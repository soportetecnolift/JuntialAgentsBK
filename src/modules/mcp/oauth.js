import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { McpServer } from '../../models/index.js';
import { encrypt, decrypt, randomToken } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { badRequest } from '../../lib/errors.js';

/**
 * OAuth 2.1 para MCP remoto (spec MCP Authorization):
 *  - Descubrimiento RFC 9728 (protected resource) + RFC 8414 (authorization server metadata)
 *  - Registro dinámico de cliente RFC 7591 si el servidor lo soporta
 *  - Authorization Code + PKCE S256, parámetro resource (RFC 8707), refresh automático
 *  - Client Credentials para integraciones máquina-a-máquina
 */
export const CALLBACK = () => `${env.PUBLIC_API_URL}/api/mcp/oauth/callback`;
const getJson = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; } catch { return null; } };

export async function discover(resourceUrl) {
  const u = new URL(resourceUrl);
  const prm = (await getJson(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)) || (await getJson(`${u.origin}/.well-known/oauth-protected-resource`));
  const issuer = prm?.authorization_servers?.[0] || u.origin;
  const iu = new URL(issuer);
  const meta = (await getJson(`${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`))
    || (await getJson(`${iu.origin}/.well-known/openid-configuration`));
  if (!meta) return null;
  return { authorizationUrl: meta.authorization_endpoint, tokenUrl: meta.token_endpoint, registrationUrl: meta.registration_endpoint, scopes: (prm?.scopes_supported || meta.scopes_supported || []).join(' ') };
}

export const readCreds = (srv) => (srv.credentialsEnc ? JSON.parse(decrypt(srv.credentialsEnc)) : {});
export const writeCreds = (srv, creds) => { srv.credentialsEnc = encrypt(JSON.stringify(creds)); };

export async function startAuthorization(serverId, userId) {
  const srv = await McpServer.findById(serverId).select('+credentialsEnc');
  const creds = readCreds(srv);
  if (!srv.oauth?.authorizationUrl || !srv.oauth?.tokenUrl) {
    const d = await discover(srv.url); if (!d) throw badRequest('No se pudo descubrir el servidor OAuth. Indica las URLs manualmente.');
    srv.oauth = { ...srv.oauth?.toObject?.(), ...d, scopes: srv.oauth?.scopes || d.scopes };
  }
  if (!srv.oauth.clientId) {
    if (!srv.oauth.registrationUrl) throw badRequest('El servidor no admite registro dinámico. Indica client_id.');
    const reg = await fetch(srv.oauth.registrationUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_name: 'JuntialAgents', redirect_uris: [CALLBACK()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }) }).then((r) => r.json());
    if (!reg.client_id) throw badRequest('Registro dinámico rechazado');
    srv.oauth.clientId = reg.client_id; if (reg.client_secret) creds.clientSecret = reg.client_secret;
  }
  writeCreds(srv, creds); await srv.save();
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = randomToken(24);
  await redis.set(`mcp:oauth:${state}`, JSON.stringify({ serverId: String(srv._id), verifier, userId }), 'EX', 600);
  const q = new URLSearchParams({ response_type: 'code', client_id: srv.oauth.clientId, redirect_uri: CALLBACK(), code_challenge: challenge, code_challenge_method: 'S256', state, resource: srv.url });
  if (srv.oauth.scopes) q.set('scope', srv.oauth.scopes);
  return `${srv.oauth.authorizationUrl}?${q}`;
}

async function tokenRequest(srv, creds, params) {
  const body = new URLSearchParams({ client_id: srv.oauth.clientId, ...params });
  if (creds.clientSecret) body.set('client_secret', creds.clientSecret);
  const r = await fetch(srv.oauth.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(15000) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw badRequest(`OAuth: ${t.error_description || t.error || r.status}`);
  return t;
}
function storeTokens(srv, creds, t) {
  creds.accessToken = t.access_token; if (t.refresh_token) creds.refreshToken = t.refresh_token; creds.tokenType = t.token_type || 'Bearer';
  srv.oauth.connected = true; srv.oauth.expiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null;
  writeCreds(srv, creds);
}

export async function handleCallback(code, state) {
  const raw = await redis.getdel(`mcp:oauth:${state}`); if (!raw) throw badRequest('Estado OAuth caducado');
  const { serverId, verifier } = JSON.parse(raw);
  const srv = await McpServer.findById(serverId).select('+credentialsEnc'); const creds = readCreds(srv);
  const t = await tokenRequest(srv, creds, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK(), code_verifier: verifier, resource: srv.url });
  storeTokens(srv, creds, t); await srv.save(); await redis.incr(`mcp:ver:${srv._id}`);
  return srv;
}

/** Devuelve un access token válido (refresca o pide client_credentials si hace falta). */
export async function getAccessToken(srv) {
  const creds = readCreds(srv);
  if (srv.authType === 'oauth2_client_credentials') {
    const ck = `mcp:cc:${srv._id}`; const cached = await redis.get(ck); if (cached) return cached;
    const t = await tokenRequest(srv, creds, { grant_type: 'client_credentials', ...(srv.oauth.scopes ? { scope: srv.oauth.scopes } : {}), resource: srv.url });
    await redis.set(ck, t.access_token, 'EX', Math.max(60, (t.expires_in || 3600) - 60));
    return t.access_token;
  }
  const exp = srv.oauth?.expiresAt ? new Date(srv.oauth.expiresAt).getTime() : Infinity;
  if (exp - Date.now() > 60000) return creds.accessToken;
  if (!creds.refreshToken) { const e = new Error('OAuth expirado'); e.code = 'MCP_OAUTH_EXPIRED'; throw e; }
  const lockKey = `mcp:refresh:${srv._id}`;
  if (!(await redis.set(lockKey, 1, 'PX', 15000, 'NX'))) { await new Promise((r) => setTimeout(r, 1500)); const fresh = await McpServer.findById(srv._id).select('+credentialsEnc'); return readCreds(fresh).accessToken; }
  try {
    const doc = await McpServer.findById(srv._id).select('+credentialsEnc');
    const t = await tokenRequest(doc, creds, { grant_type: 'refresh_token', refresh_token: creds.refreshToken, resource: doc.url });
    storeTokens(doc, creds, t); await doc.save(); await redis.incr(`mcp:ver:${doc._id}`);
    return t.access_token;
  } finally { await redis.del(lockKey); }
}
