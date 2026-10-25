import { OrgConnection } from '../../models/index.js';
import { decrypt } from '../../lib/crypto.js';
import { safeUrl } from '../crm/net.js';

/**
 * Conexiones de la organización (como las de Zoho): credenciales guardadas una vez, cifradas, y usables por
 * funciones, agentes y apps de Juntial sin exponer nunca el secreto al código.
 */
const tokenCache = new Map();
async function authHeaders(c) {
  const k = JSON.parse(decrypt(c.credentialsEnc) || '{}');
  switch (c.type) {
    case 'api_key': return { [k.headerName || 'X-API-Key']: k.apiKey };
    case 'bearer': return { Authorization: `Bearer ${k.token}` };
    case 'basic': return { Authorization: `Basic ${Buffer.from(`${k.username}:${k.password}`).toString('base64')}` };
    case 'headers': return { ...(k.headers || {}) };
    case 'oauth2_client_credentials': {
      const hit = tokenCache.get(String(c._id)); if (hit && hit.exp > Date.now() + 30000) return { Authorization: `Bearer ${hit.token}` };
      await safeUrl(k.tokenUrl);
      const r = await fetch(k.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: k.clientId, client_secret: k.clientSecret, ...(k.scope ? { scope: k.scope } : {}) }), signal: AbortSignal.timeout(15000) });
      const j = await r.json(); if (!r.ok || !j.access_token) throw new Error(`La conexión no pudo obtener token (${r.status})`);
      tokenCache.set(String(c._id), { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }); return { Authorization: `Bearer ${j.access_token}` };
    }
    default: return {};
  }
}
/** Petición HTTP autenticada con una conexión. url puede ser relativa a la URL base de la conexión. */
export async function connectionRequest(orgId, slug, { url, method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}, { app = 'juntialagents' } = {}) {
  const c = await OrgConnection.findOne({ orgId, slug }).select('+credentialsEnc').lean();
  if (!c) throw new Error(`No existe la conexión «${slug}»`);
  if (c.apps?.length && !c.apps.includes(app)) throw new Error(`La conexión «${slug}» no está compartida con esta aplicación`);
  const full = /^https?:\/\//.test(url || '') ? url : `${(c.baseUrl || '').replace(/\/$/, '')}/${String(url || '').replace(/^\//, '')}`;
  const u = await safeUrl(full);
  if (c.baseUrl && !full.startsWith(c.baseUrl.replace(/\/$/, ''))) throw new Error('La URL debe pertenecer a la dirección base de la conexión');
  let b = body; const h = { 'user-agent': 'Juntial-Connections/1.0', ...headers, ...(await authHeaders(c)) };
  if (b != null && typeof b !== 'string') { b = JSON.stringify(b); h['content-type'] ||= 'application/json'; }
  const r = await fetch(u, { method: method.toUpperCase(), headers: h, body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : b, redirect: 'manual', signal: AbortSignal.timeout(Math.min(timeoutMs, 20000)) });
  OrgConnection.updateOne({ _id: c._id }, { lastUsedAt: new Date(), $inc: { uses: 1 } }).catch(() => {});
  const text = (await r.text()).slice(0, 1_000_000); let json = null; try { json = JSON.parse(text); } catch { /* texto */ }
  return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), body: json ?? text };
}
