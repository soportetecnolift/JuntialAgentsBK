import express, { Router } from 'express';
import { z } from 'zod';
import { OAuthClient, OAuthGrant, Membership, Tenant, User } from '../../models/index.js';
import { redis } from '../../lib/redis.js';
import { sha256, randomToken, safeEqual } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { asyncH, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { CLIENT_SCOPES } from '../../api/scopes.js';
import { publish } from '../center/events.js';
import crypto from 'node:crypto';

/**
 * Servidor de autorización OAuth 2.1 de Juntial (para el MCP y la API):
 *  - Metadatos RFC 8414 (authorization server) y RFC 9728 (protected resource).
 *  - Registro dinámico de clientes RFC 7591 (Claude, ChatGPT y cualquier cliente MCP se registran solos).
 *  - Authorization code + PKCE S256 obligatorio, parámetro resource (RFC 8707), refresh tokens con rotación, revocación (RFC 7009).
 *  - El consentimiento se hace en el panel con la sesión de JuntialAgents (Google, contraseña u OTP) y eligiendo organización.
 */
const P = () => env.PUBLIC_API_URL.replace(/\/$/, '');
export const MCP_RESOURCE = () => `${P()}/mcp`;
export const OAUTH_SCOPES = { 'juntial:read': 'Consultar agentes, CRM, reglas, funciones, aprobaciones, documentos y consumo', 'juntial:write': 'Crear y modificar, ejecutar agentes y funciones, y decidir aprobaciones' };
const ACCESS_TTL = 3600; const REFRESH_TTL = 30 * 86400;
/** Traducción a los permisos de la API: lectura = todos los :read; escritura = todo lo del cliente. */
export function expandScopes(scopes) {
  const read = Object.keys(CLIENT_SCOPES).filter((s) => s.endsWith(':read'));
  const extra = ['workers:read', 'approvals:read', 'center:read'];
  if (scopes.includes('juntial:write')) return [...Object.keys(CLIENT_SCOPES), 'workers:write', 'approvals:write', 'center:write', ...extra];
  return [...read, ...extra];
}
const oauthError = (res, status, error, description) => res.status(status).json({ error, error_description: description });
const validRedirect = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };

export const wellKnown = Router();
const resourceMeta = (_req, res) => res.json({ resource: MCP_RESOURCE(), authorization_servers: [P()], scopes_supported: Object.keys(OAUTH_SCOPES), bearer_methods_supported: ['header'], resource_name: 'Juntial (JuntialAgents + Juntial Center)', resource_documentation: `${P()}/docs` });
wellKnown.get('/.well-known/oauth-protected-resource', resourceMeta);
wellKnown.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);
const asMeta = (_req, res) => res.json({
  issuer: P(), authorization_endpoint: `${P()}/oauth/authorize`, token_endpoint: `${P()}/oauth/token`, registration_endpoint: `${P()}/oauth/register`, revocation_endpoint: `${P()}/oauth/revoke`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: Object.keys(OAUTH_SCOPES), service_documentation: `${P()}/docs`,
});
wellKnown.get('/.well-known/oauth-authorization-server', asMeta);
wellKnown.get('/.well-known/oauth-authorization-server/mcp', asMeta);
wellKnown.get('/.well-known/openid-configuration', asMeta);

export const oauthPublic = Router();
oauthPublic.use(express.urlencoded({ extended: false, limit: '32kb' }), express.json({ limit: '32kb' }));

/* Registro dinámico de clientes (RFC 7591) */
oauthPublic.post('/register', asyncH(async (req, res) => {
  const b = req.body || {}; const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris debe contener URLs https (o http://localhost)');
  const method = ['none', 'client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
  const clientId = `jc_${randomToken(16)}`; const secret = method === 'none' ? null : `jcs_${randomToken(32)}`;
  const c = await OAuthClient.create({ clientId, secretHash: secret ? sha256(secret) : null, name: String(b.client_name || 'Cliente MCP').slice(0, 80), uri: b.client_uri, logoUri: b.logo_uri, redirectUris: uris, grantTypes: ['authorization_code', 'refresh_token'], authMethod: method, softwareId: b.software_id });
  res.status(201).json({ client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(c.createdAt / 1000), client_name: c.name, redirect_uris: uris, grant_types: c.grantTypes, response_types: ['code'], token_endpoint_auth_method: method });
}));

/* Autorización: valida y manda a la pantalla de consentimiento del panel */
oauthPublic.get('/authorize', asyncH(async (req, res) => {
  const q = req.query; const c = await OAuthClient.findOne({ clientId: q.client_id }).lean();
  const fail = (msg) => res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h1>No se puede autorizar</h1><p>${String(msg).replace(/</g, '&lt;')}</p></body>`);
  if (!c) return fail('Cliente desconocido. La aplicación debe registrarse de nuevo.');
  if (!q.redirect_uri || !c.redirectUris.includes(q.redirect_uri)) return fail('La dirección de retorno no está registrada para esta aplicación.');
  const back = (err, desc) => { const u = new URL(q.redirect_uri); u.searchParams.set('error', err); if (desc) u.searchParams.set('error_description', desc); if (q.state) u.searchParams.set('state', q.state); return res.redirect(302, u.toString()); };
  if (q.response_type !== 'code') return back('unsupported_response_type');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'Se requiere PKCE con S256');
  if (q.resource && q.resource.replace(/\/$/, '') !== MCP_RESOURCE() && q.resource.replace(/\/$/, '') !== P()) return back('invalid_target', 'Recurso desconocido');
  const scopes = String(q.scope || 'juntial:read juntial:write').split(/\s+/).filter((s) => OAUTH_SCOPES[s]);
  const id = randomToken(18);
  await redis.set(`oauth:req:${id}`, JSON.stringify({ clientId: c.clientId, redirectUri: q.redirect_uri, state: q.state, challenge: q.code_challenge, scopes: scopes.length ? scopes : ['juntial:read'], resource: q.resource || MCP_RESOURCE() }), 'EX', 900);
  res.redirect(302, `${env.WEB_URL}/oauth/consent?req=${id}`);
}));

/* Token */
async function authClient(req) {
  let id = req.body.client_id; let secret = req.body.client_secret;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) { const [a, b] = Buffer.from(h.slice(6), 'base64').toString().split(':'); id = decodeURIComponent(a); secret = decodeURIComponent(b || ''); }
  const c = await OAuthClient.findOne({ clientId: id }).lean(); if (!c) return null;
  if (c.authMethod !== 'none' && !(secret && c.secretHash && safeEqual(sha256(secret), c.secretHash))) return null;
  return c;
}
/** Emite tokens nuevos. Con oldRefreshHash, la rotación es atómica: si dos peticiones usan el mismo refresh, solo una gana. */
async function issue(grant, c, oldRefreshHash) {
  const access = `ja_oat_${randomToken(32)}`; const refresh = `ja_ort_${randomToken(40)}`;
  const set = { accessHash: sha256(access), accessExp: new Date(Date.now() + ACCESS_TTL * 1000), refreshHash: sha256(refresh), refreshExp: new Date(Date.now() + REFRESH_TTL * 1000), lastUsedAt: new Date() };
  const r = await OAuthGrant.updateOne(oldRefreshHash ? { _id: grant._id, refreshHash: oldRefreshHash, revokedAt: null } : { _id: grant._id }, { $set: set });
  if (oldRefreshHash && !r.matchedCount) return null;
  OAuthClient.updateOne({ _id: c._id }, { lastUsedAt: new Date() }).catch(() => {});
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: grant.scopes.join(' ') };
}
oauthPublic.post('/token', asyncH(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c = await authClient(req); if (!c) return oauthError(res, 401, 'invalid_client', 'Cliente no válido');
  if (req.body.grant_type === 'authorization_code') {
    const raw = await redis.getdel(`oauth:code:${req.body.code}`); if (!raw) return oauthError(res, 400, 'invalid_grant', 'Código inválido, usado o caducado');
    const d = JSON.parse(raw);
    if (d.clientId !== c.clientId || d.redirectUri !== req.body.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'El código no corresponde a este cliente o dirección');
    const verifier = String(req.body.code_verifier || ''); const calc = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || calc !== d.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE: code_verifier incorrecto');
    const grant = await OAuthGrant.create({ clientId: c.clientId, userId: d.userId, orgId: d.orgId, scopes: d.scopes, resource: d.resource, ip: req.ip });
    const out = await issue(grant, c);
    publish(d.orgId, 'center.ai_app.connected', { app: c.name, scopes: d.scopes }, { actor: d.email });
    return res.json(out);
  }
  if (req.body.grant_type === 'refresh_token') {
    const h = sha256(String(req.body.refresh_token || ''));
    const g = await OAuthGrant.findOne({ refreshHash: h, revokedAt: null }).lean();
    if (!g || g.refreshExp < new Date() || g.clientId !== c.clientId) return oauthError(res, 400, 'invalid_grant', 'Refresh token inválido o caducado');
    const m = await Membership.exists({ orgId: g.orgId, userId: g.userId, status: 'active' }); if (!m) { await OAuthGrant.updateOne({ _id: g._id }, { revokedAt: new Date() }); return oauthError(res, 400, 'invalid_grant', 'Ya no perteneces a esa organización'); }
    const out = await issue(g, c, h); if (!out) return oauthError(res, 400, 'invalid_grant', 'Refresh token ya utilizado');
    return res.json(out);
  }
  return oauthError(res, 400, 'unsupported_grant_type', 'Usa authorization_code o refresh_token');
}));
oauthPublic.post('/revoke', asyncH(async (req, res) => {
  const t = String(req.body.token || ''); const h = sha256(t);
  await OAuthGrant.updateOne({ $or: [{ accessHash: h }, { refreshHash: h }] }, { revokedAt: new Date() }); res.status(200).json({});
}));

/* Consentimiento desde el panel (con la sesión del usuario) */
export const oauthConsent = Router();
oauthConsent.get('/request/:id', asyncH(async (req, res) => {
  const d = JSON.parse((await redis.get(`oauth:req:${req.params.id}`)) || 'null'); if (!d) throw notFound('Solicitud de autorización caducada: vuelve a conectar desde la app');
  const c = await OAuthClient.findOne({ clientId: d.clientId }).lean();
  const mems = await Membership.find({ userId: req.user.id, status: 'active' }).lean(); const orgs = await Tenant.find({ _id: { $in: mems.map((m) => m.orgId) } }).select('name logo').lean();
  res.json({ client: { name: c?.name, uri: c?.uri, logo: c?.logoUri, redirectHost: new URL(d.redirectUri).host }, scopes: d.scopes.map((s) => ({ id: s, label: OAUTH_SCOPES[s] })), orgs: orgs.map((o) => ({ id: o._id, name: o.name, logo: o.logo, role: mems.find((m) => String(m.orgId) === String(o._id))?.orgRole, active: String(o._id) === String(req.user.tenantId) })) });
}));
oauthConsent.post('/consent', asyncH(async (req, res) => {
  const b = z.object({ req: z.string(), approve: z.boolean(), orgId: z.string().optional(), access: z.enum(['read', 'write']).default('write') }).parse(req.body);
  const d = JSON.parse((await redis.getdel(`oauth:req:${b.req}`)) || 'null'); if (!d) throw badRequest('Solicitud caducada: vuelve a conectar desde la app');
  const u = new URL(d.redirectUri); if (d.state) u.searchParams.set('state', d.state); u.searchParams.set('iss', P());
  if (!b.approve) { u.searchParams.set('error', 'access_denied'); return res.json({ redirect: u.toString() }); }
  if (req.user.role !== 'client') throw forbidden('Las cuentas del equipo de la plataforma no pueden conectar apps de IA');
  const orgId = b.orgId || req.user.tenantId; if (!(await Membership.exists({ orgId, userId: req.user.id, status: 'active' }))) throw forbidden('No perteneces a esa organización');
  const scopes = b.access === 'read' ? ['juntial:read'] : d.scopes.includes('juntial:write') ? ['juntial:read', 'juntial:write'] : ['juntial:read'];
  const code = randomToken(32);
  await redis.set(`oauth:code:${code}`, JSON.stringify({ ...d, scopes, userId: req.user.id, orgId, email: req.user.email }), 'EX', 120);
  u.searchParams.set('code', code); res.json({ redirect: u.toString() });
}));

/** Valida un access token OAuth para la API v1 / MCP (60 s de caché). */
export async function verifyOAuthToken(raw) {
  const h = sha256(raw); const ck = `oat:${h}`; const c = await redis.get(ck); if (c) return JSON.parse(c);
  const g = await OAuthGrant.findOne({ accessHash: h, revokedAt: null }).lean(); if (!g || g.accessExp < new Date()) return null;
  const u = await User.findById(g.userId).select('status email role').lean(); if (!u || u.status !== 'active') return null;
  if (!(await Membership.exists({ orgId: g.orgId, userId: g.userId, status: 'active' }))) return null;
  const ctx = { keyId: `oauth:${g._id}`, kind: 'oauth', grantId: String(g._id), scopes: expandScopes(g.scopes), oauthScopes: g.scopes, ip: [], rpm: 600, user: { id: String(g.userId), role: 'client', tenantId: String(g.orgId), email: u.email } };
  await redis.set(ck, JSON.stringify(ctx), 'EX', Math.min(60, Math.floor((new Date(g.accessExp) - Date.now()) / 1000)));
  OAuthGrant.updateOne({ _id: g._id }, { lastUsedAt: new Date() }).catch(() => {});
  return ctx;
}
