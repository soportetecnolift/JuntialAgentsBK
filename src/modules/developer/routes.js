import { Router } from 'express';
import { z } from 'zod';
import { ApiKey, ApiRequestLog, PlatformWebhook } from '../../models/index.js';
import { asyncH, notFound, forbidden, badRequest } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { can } from '../../middleware/auth.js';
import { randomToken, sha256, encrypt } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { assertLimit } from '../plans/limits.js';
import { CLIENT_SCOPES, ADMIN_SCOPES } from '../../api/scopes.js';
import { invalidateKey } from '../../api/keyAuth.js';
import { PLATFORM_EVENTS, invalidatePlatformSubs } from '../platform/events.js';
import { env } from '../../config/env.js';

/** Portal de desarrolladores (sesión web): gestión de API keys, registro de peticiones y webhooks de plataforma. */
const r = Router();
const isAdmin = (u) => ['admin', 'superadmin'].includes(u.role);
const ownQuery = (req) => (req.user.role === 'client' ? { tenantId: req.user.tenantId, kind: 'client' } : { ownerId: req.user.id, kind: 'admin' });
const view = (k) => ({ id: String(k._id), kind: k.kind, name: k.name, display: `${k.prefix}…${k.last4}`, scopes: k.scopes, ipAllowlist: k.ipAllowlist, rateLimitPerMin: k.rateLimitPerMin, expiresAt: k.expiresAt, revokedAt: k.revokedAt, lastUsedAt: k.lastUsedAt, lastUsedIp: k.lastUsedIp, requests: k.requests, createdAt: k.createdAt });

function generate(kind) {
  const raw = `ja_live_${kind === 'admin' ? 'ak' : 'ck'}_${randomToken(32)}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 14), last4: raw.slice(-4) };
}

r.get('/meta', asyncH(async (req, res) => {
  if (req.user.role === 'employee') throw forbidden('Los empleados no pueden crear API keys');
  res.json({ kind: isAdmin(req.user) ? 'admin' : 'client', scopes: isAdmin(req.user) ? { ...ADMIN_SCOPES, ...CLIENT_SCOPES } : CLIENT_SCOPES,
    baseUrl: `${env.PUBLIC_API_URL}/v1`, docsUrl: `${env.PUBLIC_API_URL}/docs`, openapiUrl: `${env.PUBLIC_API_URL}/v1/openapi.json`, platformEvents: isAdmin(req.user) ? PLATFORM_EVENTS : undefined });
}));

r.get('/keys', asyncH(async (req, res) => res.json((await ApiKey.find(ownQuery(req)).sort({ revokedAt: 1, createdAt: -1 }).lean()).map(view))));

const keySchema = z.object({
  name: z.string().min(2).max(60), scopes: z.array(z.string()).min(1), expiresInDays: z.number().int().min(1).max(730).nullable().optional(),
  ipAllowlist: z.array(z.string().regex(/^[\d.:/a-fA-F]+$/, 'IP o CIDR inválido')).max(50).default([]), rateLimitPerMin: z.number().int().min(1).max(10000).optional(),
});
r.post('/keys', validate(keySchema), asyncH(async (req, res) => {
  if (req.user.role === 'employee') throw forbidden();
  const kind = isAdmin(req.user) ? 'admin' : 'client';
  const allowed = kind === 'admin' ? { ...ADMIN_SCOPES, ...CLIENT_SCOPES } : CLIENT_SCOPES;
  const bad = req.body.scopes.filter((s) => !allowed[s]); if (bad.length) throw badRequest(`Permisos no válidos: ${bad.join(', ')}`);
  if (kind === 'client') await assertLimit(req.user.tenantId, 'apiKeys', await ApiKey.countDocuments({ tenantId: req.user.tenantId, revokedAt: null }));
  const g = generate(kind);
  const key = await ApiKey.create({ kind, ownerId: req.user.id, tenantId: kind === 'client' ? req.user.tenantId : undefined, name: req.body.name, prefix: g.prefix, last4: g.last4, hash: g.hash,
    scopes: req.body.scopes, ipAllowlist: req.body.ipAllowlist, rateLimitPerMin: req.body.rateLimitPerMin,
    expiresAt: req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86400000) : null });
  audit(req, 'apikey.create', { kind: 'apikey', id: key.id }, { scopes: key.scopes, kind });
  res.status(201).json({ key: view(key), secret: g.raw, note: 'Copia la clave ahora: no se volverá a mostrar.' });
}));

async function ownKey(req) { const k = await ApiKey.findOne({ _id: req.params.id, ...ownQuery(req) }); if (!k) throw notFound('API key'); return k; }
r.patch('/keys/:id', validate(keySchema.partial().omit({ expiresInDays: true })), asyncH(async (req, res) => {
  const k = await ownKey(req); Object.assign(k, req.body); await k.save(); await invalidateKey(k.hash);
  audit(req, 'apikey.update', { kind: 'apikey', id: k.id }, req.body); res.json(view(k));
}));
// Rotación: emite una clave nueva con la misma configuración y revoca la anterior
r.post('/keys/:id/roll', asyncH(async (req, res) => {
  const old = await ownKey(req); if (old.revokedAt) throw badRequest('La clave ya está revocada');
  const g = generate(old.kind);
  const key = await ApiKey.create({ ...old.toObject(), _id: undefined, hash: g.hash, prefix: g.prefix, last4: g.last4, requests: 0, lastUsedAt: null, createdAt: undefined, updatedAt: undefined });
  old.revokedAt = new Date(); await old.save(); await invalidateKey(old.hash);
  audit(req, 'apikey.roll', { kind: 'apikey', id: key.id }); res.json({ key: view(key), secret: g.raw });
}));
r.delete('/keys/:id', asyncH(async (req, res) => {
  const k = await ownKey(req); k.revokedAt = new Date(); await k.save(); await invalidateKey(k.hash);
  audit(req, 'apikey.revoke', { kind: 'apikey', id: k.id }); res.json({ ok: true });
}));
r.get('/logs', asyncH(async (req, res) => {
  const keys = await ApiKey.find(ownQuery(req)).select('_id').lean(); const ids = keys.map((k) => k._id);
  const q = { keyId: req.query.keyId ? { $in: ids.filter((i) => String(i) === req.query.keyId) } : { $in: ids } };
  if (req.query.errors) q.status = { $gte: 400 };
  res.json(await ApiRequestLog.find(q).sort({ createdAt: -1 }).limit(200).lean());
}));

/* ── Webhooks de plataforma (solo admin/superadmin) ── */
const pw = Router();
pw.use((req, _res, next) => (can(req.user.role, 'platform.webhooks') ? next() : next(forbidden())));
pw.get('/', asyncH(async (_req, res) => res.json({ events: PLATFORM_EVENTS, items: await PlatformWebhook.find().sort({ createdAt: -1 }).lean() })));
pw.post('/', validate(z.object({ name: z.string().min(2), url: z.string().url(), events: z.array(z.string()).min(1) })), asyncH(async (req, res) => {
  const bad = req.body.events.filter((e) => e !== '*' && !PLATFORM_EVENTS.includes(e)); if (bad.length) throw badRequest(`Eventos no válidos: ${bad.join(', ')}`);
  const secret = `whsec_${randomToken(24)}`;
  const w = await PlatformWebhook.create({ ...req.body, secretEnc: encrypt(secret), createdBy: req.user.id }); await invalidatePlatformSubs();
  audit(req, 'platform_webhook.create', { kind: 'platform_webhook', id: w.id }); res.status(201).json({ webhook: w, secret });
}));
pw.put('/:id', asyncH(async (req, res) => {
  const { name, url, events, enabled } = req.body;
  const w = await PlatformWebhook.findByIdAndUpdate(req.params.id, Object.fromEntries(Object.entries({ name, url, events, enabled, ...(enabled ? { consecutiveFailures: 0 } : {}) }).filter(([, v]) => v !== undefined)), { new: true });
  if (!w) throw notFound(); await invalidatePlatformSubs(); res.json(w);
}));
pw.delete('/:id', asyncH(async (req, res) => { await PlatformWebhook.deleteOne({ _id: req.params.id }); await invalidatePlatformSubs(); audit(req, 'platform_webhook.delete', { kind: 'platform_webhook', id: req.params.id }); res.json({ ok: true }); }));

export { pw as platformWebhookRouter };
export default r;
