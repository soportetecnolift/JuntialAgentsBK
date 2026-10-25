import { ApiKey, ApiRequestLog, User, daysFromNow } from '../models/index.js';
import { sha256 } from '../lib/crypto.js';
import { redis, takeToken } from '../lib/redis.js';
import { unauthorized, forbidden, AppError } from '../lib/errors.js';
import { getTenantPlan, limitOf } from '../modules/plans/limits.js';
import { hasScope } from './scopes.js';

export const KEY_RE = /^ja_(live)_(ck|ak)_[A-Za-z0-9_-]{32,}$/;

function ipInCidr(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bits] = cidr.split('/'); const toInt = (x) => x.split('.').reduce((a, o) => (a << 8) + +o, 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(range)) return false;
  const mask = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

/**
 * Autenticación por API key (Authorization: Bearer ja_live_… o X-API-Key).
 * - Solo se guarda el SHA-256 de la clave; caché de 60 s en Redis.
 * - El poder de una clave de admin se recalcula con el rol ACTUAL de su dueño:
 *   si se le degrada o deshabilita, la clave deja de funcionar al instante (≤60 s).
 * - Rate limit por clave (token bucket) con cabeceras RateLimit estándar.
 */
export async function apiKeyAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const raw = (h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-api-key'] || '').trim();
    // Tokens OAuth (apps de IA conectadas por MCP): mismos permisos que la persona en su organización
    if (raw.startsWith('ja_oat_')) {
      const { verifyOAuthToken } = await import('../modules/oauth/server.js');
      const ctx = await verifyOAuthToken(raw); if (!ctx) throw unauthorized('Token OAuth inválido, revocado o caducado');
      const wait = await takeToken(`api:rl:${ctx.keyId}`, ctx.rpm / 60, 100);
      if (wait > 0) { res.setHeader('Retry-After', Math.ceil(wait / 1000)); throw new AppError(429, 'RATE_LIMITED', 'Demasiadas peticiones'); }
      req.user = ctx.user; req.apiKey = ctx; return next();
    }
    if (!KEY_RE.test(raw)) throw unauthorized('Falta una API key válida (Authorization: Bearer ja_live_…)');
    const hash = sha256(raw); const ck = `apikey:${hash}`;
    let ctx = JSON.parse((await redis.get(ck)) || 'null');
    if (!ctx) {
      const key = await ApiKey.findOne({ hash }).lean();
      if (!key || key.revokedAt) throw unauthorized('API key revocada o inexistente');
      const owner = await User.findById(key.ownerId).select('role status tenantId email').lean();
      if (!owner || owner.status !== 'active') throw unauthorized('El propietario de la clave está deshabilitado');
      if (key.kind === 'admin' && !['admin', 'superadmin'].includes(owner.role)) throw unauthorized('El propietario ya no es administrador');
      let rpm = key.rateLimitPerMin;
      if (key.kind === 'client') { const { plan, tenant } = await getTenantPlan(key.tenantId); if (tenant.status === 'suspended') throw forbidden('Cuenta suspendida'); rpm = Math.min(rpm || Infinity, limitOf(plan, 'apiRequestsPerMinute') < 0 ? Infinity : limitOf(plan, 'apiRequestsPerMinute')); }
      ctx = { keyId: String(key._id), kind: key.kind, scopes: key.scopes, ip: key.ipAllowlist || [], exp: key.expiresAt, rpm: rpm || 600, prefix: key.prefix,
        user: { id: String(owner._id), role: key.kind === 'admin' ? owner.role : 'client', tenantId: key.tenantId ? String(key.tenantId) : null, email: `apikey:${key.prefix}…${key.last4}` } };
      await redis.set(ck, JSON.stringify(ctx), 'EX', 60);
    }
    if (ctx.exp && new Date(ctx.exp) < new Date()) throw unauthorized('API key caducada');
    if (ctx.ip.length && !ctx.ip.some((c) => ipInCidr(req.ip.replace('::ffff:', ''), c))) throw forbidden(`IP ${req.ip} no autorizada para esta clave`);

    const wait = await takeToken(`api:rl:${ctx.keyId}`, ctx.rpm / 60, Math.max(5, Math.ceil(ctx.rpm / 6)));
    res.setHeader('RateLimit-Policy', `${ctx.rpm};w=60`);
    if (wait > 0) { res.setHeader('Retry-After', Math.ceil(wait / 1000)); throw new AppError(429, 'RATE_LIMITED', `Límite de ${ctx.rpm} peticiones/minuto superado`); }

    req.user = ctx.user; req.apiKey = ctx;
    const t0 = Date.now();
    res.on('finish', () => {
      ApiRequestLog.create({ keyId: ctx.keyId, tenantId: ctx.user.tenantId, method: req.method, path: req.originalUrl.split('?')[0].slice(0, 200), status: res.statusCode, ms: Date.now() - t0, ip: req.ip, requestId: req.id, expiresAt: daysFromNow(30) }).catch(() => {});
      ApiKey.updateOne({ _id: ctx.keyId }, { lastUsedAt: new Date(), lastUsedIp: req.ip, $inc: { requests: 1 } }).catch(() => {});
    });
    next();
  } catch (e) { next(e); }
}

/** GET/HEAD → <recurso>:read · resto → <recurso>:write */
export const scope = (resource) => (req, _res, next) => {
  const s = typeof resource === 'function' ? resource(req) : resource;
  const needed = s.includes(':') ? s : `${s}:${['GET', 'HEAD'].includes(req.method) ? 'read' : 'write'}`;
  if (!hasScope(req.apiKey.scopes, needed)) return next(forbidden(`La clave no tiene el permiso ${needed}`));
  next();
};
export const adminOnly = (req, _res, next) => (req.apiKey.kind === 'admin' ? next() : next(forbidden('Este endpoint requiere una API key de administrador')));
export const invalidateKey = (hash) => redis.del(`apikey:${hash}`);
