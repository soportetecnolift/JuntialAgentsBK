import crypto from 'node:crypto';

/** TOTP RFC 6238 (SHA-1, 6 dígitos, 30 s): compatible con Google/Microsoft Authenticator, 1Password, Authy. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let val = 0; let out = '';
  for (const b of buf) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = str.replace(/=+$/, '').replace(/\s/g, '').toUpperCase(); let bits = 0; let val = 0; const out = [];
  for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new Error('base32 inválido'); val = ((val << 5) | i) & 0xfff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export const newSecret = () => base32Encode(crypto.randomBytes(20));
export const otpauthUrl = (secret, account, issuer = 'JuntialAgents') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Devuelve el paso de tiempo que coincide (±1 ventana = ±30 s de desfase de reloj) o null. */
export function verifyTotp(secret, code, window = 1) {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret); const step = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const c = hotp(key, step + w);
    if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code))) return step + w;
  }
  return null;
}
export const totpNow = (secret) => hotp(base32Decode(secret), Math.floor(Date.now() / 30000));
