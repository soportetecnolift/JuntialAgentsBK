import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { User } from '../../models/index.js';
import { asyncH, unauthorized, forbidden, tooMany, badRequest } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { requireAuth, isStaff } from '../../middleware/auth.js';
import { encrypt, decrypt, sha256, randomToken, safeEqual } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { audit } from '../../lib/audit.js';
import { newSecret, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import * as S from './service.js';

/**
 * Acceso de administración (/admin/login): solo superadmin, admin y empleados.
 *  Paso 1: email + contraseña  →  token MFA de 5 min (no da acceso a nada más)
 *  Paso 2: código TOTP o código de respaldo → sesión de 30 días
 *  El primer acceso obliga a configurar la app autenticadora.
 *  Bloqueo de 15 min tras 5 fallos por cuenta e IP; cada intento queda auditado.
 */
const r = Router();
const MFA_PURPOSE = 'staff-mfa';
const LOCK_S = 900; const MAX_FAILS = 5;
const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
const auditAnon = (req, action, email, extra = {}) => audit({ ...req, user: { email, role: 'anon' } }, action, { kind: 'user', id: email }, extra);

async function fail(req, email, reason) {
  const keys = [`staff:fail:${email}`, `staff:fail:ip:${req.ip}`];
  for (const k of keys) { const n = await redis.incr(k); if (n === 1) await redis.expire(k, LOCK_S); if (n >= MAX_FAILS) await redis.set(k.replace(':fail:', ':lock:'), 1, 'EX', LOCK_S); }
  logger.warn({ email, ip: req.ip, reason }, 'Intento fallido en acceso de administración');
  auditAnon(req, 'staff.login.failed', email, { reason });
}
async function assertNotLocked(req, email) {
  if ((await redis.exists(`staff:lock:${email}`)) || (await redis.exists(`staff:lock:ip:${req.ip}`))) throw tooMany('Acceso bloqueado temporalmente por intentos fallidos. Inténtalo en 15 minutos.');
}

function finish(res, s, extra = {}) {
  res.cookie(S.REFRESH_COOKIE, s.refreshToken, S.cookieOpts(s.expiresAt));
  res.json({ accessToken: s.accessToken, sessionExpiresAt: s.expiresAt, user: s.user, ...extra });
}
const genBackupCodes = () => Array.from({ length: 8 }, () => randomToken(6).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8).toLowerCase().replace(/(.{4})(.{4})/, '$1-$2'));

r.post('/staff/login', validate(z.object({ email: z.string().email().transform((s) => s.toLowerCase().trim()), password: z.string().min(1) })), asyncH(async (req, res) => {
  const { email, password } = req.body;
  await assertNotLocked(req, email);
  const user = await User.findOne({ email }).select('+passwordHash');
  const ok = user?.passwordHash ? await argon2.verify(user.passwordHash, password) : (await argon2.hash('timing'), false);
  // Mismo mensaje para "no existe", "contraseña mal" y "no es del equipo": no revelamos nada
  if (!ok || !isStaff(user.role)) { await fail(req, email, !user ? 'no_user' : !ok ? 'bad_password' : 'not_staff'); throw unauthorized('Credenciales incorrectas'); }
  if (user.status !== 'active') throw forbidden('Cuenta deshabilitada');
  await redis.del(`staff:fail:${email}`);

  if (!env.STAFF_MFA_REQUIRED && !user.mfa?.enabled) {
    auditAnon(req, 'staff.login.success', email, { mfa: false });
    return finish(res, await S.createSession(user, { ...meta(req), method: 'staff' }));
  }
  const mfaToken = jwt.sign({ sub: String(user._id), purpose: MFA_PURPOSE, nonce: randomToken(8) }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
  if (user.mfa?.enabled) return res.json({ step: 'mfa', mfaToken });

  // Primer acceso: generar secreto pendiente y QR
  const secret = newSecret();
  await User.updateOne({ _id: user._id }, { 'mfa.pendingSecretEnc': encrypt(secret) });
  const url = otpauthUrl(secret, user.email);
  res.json({ step: 'setup', mfaToken, secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) });
}));

r.post('/staff/mfa', validate(z.object({ mfaToken: z.string(), code: z.string().trim().min(6).max(12) })), asyncH(async (req, res) => {
  let p; try { p = jwt.verify(req.body.mfaToken, env.JWT_ACCESS_SECRET); } catch { throw unauthorized('El paso de verificación caducó. Vuelve a introducir tu contraseña.'); }
  if (p.purpose !== MFA_PURPOSE) throw unauthorized();
  const tries = await redis.incr(`staff:mfa:${p.nonce}`); if (tries === 1) await redis.expire(`staff:mfa:${p.nonce}`, 300);
  if (tries > 5) throw tooMany('Demasiados códigos incorrectos. Vuelve a empezar.');

  const user = await User.findById(p.sub).select('+mfa.secretEnc +mfa.pendingSecretEnc +mfa.backupCodes');
  if (!user || user.status !== 'active' || !isStaff(user.role)) throw unauthorized();
  const code = req.body.code.replace(/\s/g, '').toLowerCase();
  let backupCodes; let usedBackup = false;

  if (user.mfa?.enabled) {
    const step = verifyTotp(decrypt(user.mfa.secretEnc), code);
    if (step != null) {
      // Anti-replay: un mismo código no sirve dos veces
      const last = Number(await redis.get(`totp:last:${user._id}`)) || 0;
      if (step <= last) throw badRequest('Ese código ya se usó. Espera al siguiente.');
      await redis.set(`totp:last:${user._id}`, step, 'EX', 120);
    } else {
      const h = sha256(code); const idx = (user.mfa.backupCodes || []).findIndex((b) => safeEqual(b, h));
      if (idx < 0) { await fail(req, user.email, 'bad_mfa'); throw badRequest('Código incorrecto'); }
      user.mfa.backupCodes.splice(idx, 1); usedBackup = true; await user.save();
    }
  } else {
    const pending = decrypt(user.mfa?.pendingSecretEnc);
    if (!pending || verifyTotp(pending, code) == null) throw badRequest('Código incorrecto. Comprueba que la hora del móvil sea automática.');
    backupCodes = genBackupCodes();
    user.mfa = { enabled: true, enabledAt: new Date(), secretEnc: encrypt(pending), pendingSecretEnc: null, backupCodes: backupCodes.map(sha256) };
    await user.save();
    auditAnon(req, 'staff.mfa.enabled', user.email);
  }
  await redis.del(`staff:fail:${user.email}`);
  auditAnon(req, 'staff.login.success', user.email, { usedBackup });
  finish(res, await S.createSession(user, { ...meta(req), method: 'staff' }), {
    ...(backupCodes ? { backupCodes } : {}),
    ...(usedBackup ? { warning: `Usaste un código de respaldo. Te quedan ${user.mfa.backupCodes.length}.` } : {}),
  });
}));

/* ── Gestión de la verificación en dos pasos desde Ajustes (sesión iniciada) ── */
r.get('/staff/mfa/status', requireAuth, asyncH(async (req, res) => {
  const u = await User.findById(req.user.id).select('+mfa.backupCodes').lean();
  res.json({ enabled: !!u.mfa?.enabled, enabledAt: u.mfa?.enabledAt, backupCodesLeft: u.mfa?.backupCodes?.length || 0 });
}));
r.post('/staff/backup-codes', requireAuth, validate(z.object({ code: z.string().length(6) })), asyncH(async (req, res) => {
  if (!isStaff(req.user.role)) throw forbidden();
  const user = await User.findById(req.user.id).select('+mfa.secretEnc +mfa.backupCodes');
  if (!user.mfa?.enabled || verifyTotp(decrypt(user.mfa.secretEnc), req.body.code) == null) throw badRequest('Código de la app incorrecto');
  const codes = genBackupCodes(); user.mfa.backupCodes = codes.map(sha256); await user.save();
  audit(req, 'staff.mfa.backup_regenerated'); res.json({ backupCodes: codes });
}));
export default r;
