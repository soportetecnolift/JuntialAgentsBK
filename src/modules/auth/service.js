import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { OAuth2Client } from 'google-auth-library';
import { env, isProd } from '../../config/env.js';
import { User, Session, Otp, Tenant, Plan } from '../../models/index.js';
import { sha256, randomToken, randomOtp, safeEqual } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { unauthorized, badRequest, tooMany, forbidden } from '../../lib/errors.js';
import { notify, emailDirect } from '../notifications/service.js';
import { emitPlatformEvent } from '../platform/events.js';

const SESSION_MS = env.SESSION_DAYS * 86400000;
const googleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;
export const REFRESH_COOKIE = 'ja_rt';

export const hashPassword = (p) => argon2.hash(p, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });

export function cookieOpts(expiresAt) {
  return {
    httpOnly: true, secure: isProd || env.COOKIE_SAMESITE === 'none', sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined, path: '/api/auth', expires: expiresAt,
  };
}

function signAccess(user, sid) {
  return jwt.sign({ sub: String(user._id), role: user.role, tid: user.tenantId ? String(user.tenantId) : null, sid, email: user.email }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL });
}

/** Crea sesión con caducidad absoluta de 30 días. */
export async function createSession(user, { ip, userAgent, method }) {
  if (user.status !== 'active') throw forbidden('Cuenta deshabilitada');
  const secret = randomToken(48);
  const known = await Session.exists({ userId: user._id, userAgent, revokedAt: null });
  const session = await Session.create({ userId: user._id, refreshHash: sha256(secret), ip, userAgent, method, expiresAt: new Date(Date.now() + SESSION_MS), lastUsedAt: new Date() });
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
  if (!known && user.lastLoginAt) notify(user._id, 'auth.new_login', { ip, userAgent: userAgent?.slice(0, 80) }).catch(() => {});
  return { accessToken: signAccess(user, String(session._id)), refreshToken: `${session._id}.${secret}`, expiresAt: session.expiresAt, user: publicUser(user) };
}

/** Rotación de refresh token + detección de reutilización. NO extiende la caducidad (30 días absolutos). */
export async function refreshSession(raw, { ip }) {
  if (!raw?.includes('.')) throw unauthorized();
  const [sid, secret] = raw.split('.');
  const session = await Session.findById(sid).catch(() => null);
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Sesión expirada, inicia sesión de nuevo');
  const h = sha256(secret);
  if (!safeEqual(h, session.refreshHash)) {
    if (session.prevRefreshHash && safeEqual(h, session.prevRefreshHash)) {
      // Token antiguo reutilizado => posible robo. Revocar.
      await revokeSession(session);
    }
    throw unauthorized();
  }
  const user = await User.findById(session.userId);
  if (!user || user.status !== 'active') { await revokeSession(session); throw unauthorized(); }
  const next = randomToken(48);
  session.prevRefreshHash = session.refreshHash; session.refreshHash = sha256(next); session.lastUsedAt = new Date(); session.ip = ip;
  await session.save();
  return { accessToken: signAccess(user, sid), refreshToken: `${sid}.${next}`, expiresAt: session.expiresAt, user: publicUser(user) };
}

export async function revokeSession(session) {
  session.revokedAt = new Date(); await session.save();
  await redis.set(`revoked:sid:${session._id}`, 1, 'EX', 3600); // > vida del access token
}
export async function revokeAllSessions(userId, exceptSid) {
  const sessions = await Session.find({ userId, revokedAt: null, _id: { $ne: exceptSid } });
  await Promise.all(sessions.map(revokeSession));
}

export const publicUser = (u) => ({ id: String(u._id), email: u.email, name: u.name, avatar: u.avatar, role: u.role, tenantId: u.tenantId ? String(u.tenantId) : null, emailVerified: u.emailVerified, notificationPrefs: u.notificationPrefs });

/** Cada cliente nuevo obtiene su tenant con el plan gratuito. */
export async function ensureClientTenant(user) {
  if (user.role !== 'client' || user.tenantId) return user;
  const free = await Plan.findOne({ slug: 'free' }).lean();
  const now = new Date();
  const tenant = await Tenant.create({ name: user.name || user.email, ownerId: user._id, subscription: { planId: free?._id, status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) } });
  user.tenantId = tenant._id; await user.save();
  notify(user._id, 'account.welcome', { name: user.name }).catch(() => {});
  emitPlatformEvent('user.created', { userId: String(user._id), email: user.email, name: user.name });
  emitPlatformEvent('tenant.created', { tenantId: String(tenant._id), name: tenant.name, ownerEmail: user.email, plan: free?.slug });
  return user;
}

/* ───── OTP ───── */
export async function sendOtp(email, purpose) {
  const k = `otp:rl:${email}`;
  const n = await redis.incr(k); if (n === 1) await redis.expire(k, 3600);
  if (n > 5) throw tooMany('Has pedido demasiados códigos. Espera una hora.');
  const code = randomOtp();
  await Otp.deleteMany({ email, purpose });
  await Otp.create({ email, purpose, codeHash: sha256(`${email}:${code}`), expiresAt: new Date(Date.now() + 10 * 60000) });
  await emailDirect(email, 'auth.otp', { code });
}
export async function checkOtp(email, purpose, code) {
  const otp = await Otp.findOne({ email, purpose });
  if (!otp || otp.expiresAt < new Date()) throw badRequest('Código caducado. Pide uno nuevo.');
  if (otp.attempts >= 5) { await otp.deleteOne(); throw tooMany('Demasiados intentos. Pide un código nuevo.'); }
  if (!safeEqual(otp.codeHash, sha256(`${email}:${code}`))) { otp.attempts += 1; await otp.save(); throw badRequest('Código incorrecto'); }
  await otp.deleteOne();
}

/* ───── Google ───── */
export async function verifyGoogle(credential) {
  if (!googleClient) throw badRequest('Google no configurado');
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email_verified) throw unauthorized('Email de Google no verificado');
  let user = await User.findOne({ $or: [{ googleId: p.sub }, { email: p.email.toLowerCase() }] });
  if (!user) user = await User.create({ email: p.email, name: p.name, avatar: p.picture, googleId: p.sub, emailVerified: true });
  else if (!user.googleId) { user.googleId = p.sub; user.emailVerified = true; user.avatar ||= p.picture; await user.save(); }
  return ensureClientTenant(user);
}
