import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { User, Session } from '../../models/index.js';
import { asyncH, unauthorized, conflict } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { requireAuth } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../notifications/service.js';
import * as S from './service.js';
import staffRoutes from './staff.js';
import { AppError } from '../../lib/errors.js';

const r = Router();
r.use(staffRoutes);

// Las cuentas del equipo NO entran por el login de clientes (deben pasar por /admin/login con 2FA)
const STAFF = ['superadmin', 'admin', 'employee'];
const noStaff = (u) => { if (u && STAFF.includes(u.role)) throw new AppError(403, 'STAFF_PORTAL', 'Las cuentas del equipo entran por el acceso de administración'); };
const email = z.string().email().transform((s) => s.toLowerCase().trim());
const password = z.string().min(10, 'Mínimo 10 caracteres').max(128);
const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

function respond(res, s) {
  res.cookie(S.REFRESH_COOKIE, s.refreshToken, S.cookieOpts(s.expiresAt));
  res.json({ accessToken: s.accessToken, sessionExpiresAt: s.expiresAt, user: s.user });
}

r.post('/register', validate(z.object({ email, password, name: z.string().min(2).max(80) })), asyncH(async (req, res) => {
  const { email: e, password: p, name } = req.body;
  const exists = await User.findOne({ email: e });
  if (exists?.emailVerified) throw conflict('Ya existe una cuenta con este email');
  if (!exists) await User.create({ email: e, name, passwordHash: await S.hashPassword(p) });
  else { exists.passwordHash = await S.hashPassword(p); exists.name = name; await exists.save(); }
  await S.sendOtp(e, 'verify');
  res.status(201).json({ needsVerification: true });
}));

r.post('/verify-email', validate(z.object({ email, code: z.string().length(6) })), asyncH(async (req, res) => {
  await S.checkOtp(req.body.email, 'verify', req.body.code);
  let user = await User.findOneAndUpdate({ email: req.body.email }, { emailVerified: true }, { new: true });
  noStaff(user);
  user = await S.ensureClientTenant(user);
  respond(res, await S.createSession(user, { ...meta(req), method: 'password' }));
}));

r.post('/login', validate(z.object({ email, password: z.string() })), asyncH(async (req, res) => {
  const user = await User.findOne({ email: req.body.email }).select('+passwordHash');
  // Respuesta y tiempo uniformes para no filtrar si el email existe
  const ok = user?.passwordHash ? await argon2.verify(user.passwordHash, req.body.password) : (await argon2.hash('dummy-timing'), false);
  if (!ok) throw unauthorized('Email o contraseña incorrectos');
  noStaff(user);
  if (!user.emailVerified) { await S.sendOtp(user.email, 'verify'); return res.json({ needsVerification: true }); }
  respond(res, await S.createSession(user, { ...meta(req), method: 'password' }));
}));

r.post('/otp/request', validate(z.object({ email })), asyncH(async (req, res) => {
  const user = await User.findOne({ email: req.body.email, status: 'active' });
  if (user && !STAFF.includes(user.role)) await S.sendOtp(user.email, 'login');
  res.json({ ok: true }); // siempre ok (anti-enumeración)
}));

r.post('/otp/verify', validate(z.object({ email, code: z.string().length(6) })), asyncH(async (req, res) => {
  const existing = await User.findOne({ email: req.body.email }).lean(); noStaff(existing);
  await S.checkOtp(req.body.email, 'login', req.body.code);
  const user = await User.findOneAndUpdate({ email: req.body.email }, { emailVerified: true }, { new: true });
  if (!user) throw unauthorized();
  respond(res, await S.createSession(user, { ...meta(req), method: 'otp' }));
}));

r.post('/google', validate(z.object({ credential: z.string().min(20) })), asyncH(async (req, res) => {
  const user = await S.verifyGoogle(req.body.credential);
  noStaff(user);
  respond(res, await S.createSession(user, { ...meta(req), method: 'google' }));
}));

r.post('/refresh', asyncH(async (req, res) => {
  try { respond(res, await S.refreshSession(req.cookies[S.REFRESH_COOKIE], meta(req))); }
  catch (e) { res.clearCookie(S.REFRESH_COOKIE, S.cookieOpts()); throw e; }
}));

r.post('/password/forgot', validate(z.object({ email })), asyncH(async (req, res) => {
  if (await User.exists({ email: req.body.email })) await S.sendOtp(req.body.email, 'reset');
  res.json({ ok: true });
}));
r.post('/password/reset', validate(z.object({ email, code: z.string().length(6), password })), asyncH(async (req, res) => {
  await S.checkOtp(req.body.email, 'reset', req.body.code);
  const user = await User.findOneAndUpdate({ email: req.body.email }, { passwordHash: await S.hashPassword(req.body.password), emailVerified: true }, { new: true });
  await S.revokeAllSessions(user._id);
  notify(user._id, 'auth.password_changed').catch(() => {});
  res.json({ ok: true });
}));

/* ── Autenticado ── */
r.post('/logout', requireAuth, asyncH(async (req, res) => {
  const s = await Session.findById(req.user.sid); if (s) await S.revokeSession(s);
  res.clearCookie(S.REFRESH_COOKIE, S.cookieOpts()); res.json({ ok: true });
}));
r.get('/me', requireAuth, asyncH(async (req, res) => {
  const user = await User.findById(req.user.id); const s = await Session.findById(req.user.sid).lean();
  res.json({ user: S.publicUser(user), sessionExpiresAt: s?.expiresAt });
}));
r.get('/sessions', requireAuth, asyncH(async (req, res) => {
  const items = await Session.find({ userId: req.user.id, revokedAt: null, expiresAt: { $gt: new Date() } }).select('ip userAgent method createdAt lastUsedAt expiresAt').sort({ lastUsedAt: -1 }).lean();
  res.json(items.map((s) => ({ ...s, current: String(s._id) === req.user.sid })));
}));
r.delete('/sessions/:id', requireAuth, asyncH(async (req, res) => {
  const s = await Session.findOne({ _id: req.params.id, userId: req.user.id }); if (s) await S.revokeSession(s);
  audit(req, 'session.revoke', { kind: 'session', id: req.params.id }); res.json({ ok: true });
}));
r.post('/password/change', requireAuth, validate(z.object({ current: z.string().optional(), password })), asyncH(async (req, res) => {
  const user = await User.findById(req.user.id).select('+passwordHash');
  if (user.passwordHash && !(await argon2.verify(user.passwordHash, req.body.current || ''))) throw unauthorized('Contraseña actual incorrecta');
  user.passwordHash = await S.hashPassword(req.body.password); await user.save();
  await S.revokeAllSessions(user._id, req.user.sid);
  notify(user._id, 'auth.password_changed').catch(() => {});
  audit(req, 'password.change'); res.json({ ok: true });
}));
export default r;
