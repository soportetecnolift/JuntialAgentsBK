import crypto from 'node:crypto';
import { env } from '../config/env.js';

// Cifrado en reposo AES-256-GCM con versión de clave (permite rotación / KMS).
const KEYS = { v1: Buffer.from(env.ENCRYPTION_KEY, 'base64') };
if (KEYS.v1.length !== 32) throw new Error('ENCRYPTION_KEY debe ser 32 bytes en base64');
const CURRENT = 'v1';

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEYS[CURRENT], iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [CURRENT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
export function decrypt(payload) {
  if (!payload) return null;
  const [ver, iv, tag, data] = payload.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', KEYS[ver], Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
export const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
export const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : null);
