import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '../../models/index.js';
import { redis } from '../../lib/redis.js';
import { readCreds, getAccessToken } from './oauth.js';
import { logger } from '../../config/logger.js';

/**
 * Cliente MCP multi-tenant optimizado:
 *  - Conexiones persistentes con caducidad por inactividad (30 min) y deduplicación de conexiones simultáneas.
 *  - Catálogo de herramientas en caché Redis compartida entre workers (stale-while-revalidate) + memoria local.
 *  - Recuerda qué transporte funciona en cada servidor (no repite el intento fallido Streamable→SSE).
 *  - Paginación completa de tools/list (servidores grandes como Zoho exponen cientos).
 *  - Timeout por servidor: uno lento no bloquea al resto. Reconexión automática ante fallos.
 * stdio queda excluido a propósito: ejecutar binarios de clientes en infraestructura compartida es un riesgo RCE.
 */
const IDLE_MS = 30 * 60 * 1000;
const TOOLS_FRESH_MS = 10 * 60 * 1000;
const SERVER_TIMEOUT_MS = 8000;
const pool = new Map();        // id -> { client, key, lastUsed }
const connecting = new Map();  // id -> Promise
const srvCache = new Map();    // id -> { srv, ver, at }
const toolsMem = new Map();    // id -> { ver, tools, at }

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: sin respuesta en ${ms / 1000}s`)), ms))]);
const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Invalida conexión y catálogo de un servidor en TODOS los workers (versión en Redis). */
export async function bumpMcpVersion(id) {
  await redis.incr(`mcp:ver:${id}`); await redis.del(`mcp:tools:${id}`);
  dropClient(id); srvCache.delete(String(id)); toolsMem.delete(String(id));
}

async function loadServer(id) {
  const ver = (await redis.get(`mcp:ver:${id}`)) || '0';
  const hit = srvCache.get(String(id));
  if (hit && hit.ver === ver && Date.now() - hit.at < 60000) return { srv: hit.srv, ver };
  const srv = await McpServer.findById(id).select('+credentialsEnc');
  if (srv) srvCache.set(String(id), { srv, ver, at: Date.now() });
  return { srv, ver };
}

export async function authHeaders(srv) {
  const c = readCreds(srv);
  switch (srv.authType) {
    case 'bearer': return { Authorization: `Bearer ${c.token}` };
    case 'api_key': return { [c.headerName || 'X-API-Key']: c.apiKey };
    case 'basic': return { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` };
    case 'headers': return { ...(c.headers || {}) };
    case 'oauth2_code':
    case 'oauth2_client_credentials': return { Authorization: `Bearer ${await getAccessToken(srv)}` };
    default: return {};
  }
}

async function connect(srv) {
  const headers = await authHeaders(srv);
  const url = new URL(srv.url);
  const make = async (kind) => {
    const client = new Client({ name: 'juntialagents', version: '1.0.0' });
    const transport = kind === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...i?.headers, ...headers } }) } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    await client.connect(transport);
    return client;
  };
  if (srv.transport !== 'auto') return make(srv.transport === 'sse' ? 'sse' : 'streamable-http');
  const memoKey = `mcp:tr:${srv._id}`;
  const known = await redis.get(memoKey);
  const order = known === 'sse' ? ['sse', 'streamable-http'] : ['streamable-http', 'sse'];
  try {
    const c = await make(order[0]); if (known !== order[0]) await redis.set(memoKey, order[0], 'EX', 7 * 86400); return c;
  } catch (e) {
    logger.debug({ err: e.message, server: String(srv._id) }, `MCP ${order[0]} falló, probando ${order[1]}`);
    const c = await make(order[1]); await redis.set(memoKey, order[1], 'EX', 7 * 86400); return c;
  }
}

export async function getClient(id) {
  const key = String(id);
  const { srv, ver } = await loadServer(id);
  if (!srv?.enabled) return null;
  const connKey = `${ver}:${srv.oauth?.expiresAt ? new Date(srv.oauth.expiresAt).getTime() : ''}`;
  const hit = pool.get(key);
  if (hit && hit.key === connKey && Date.now() - hit.lastUsed < IDLE_MS) { hit.lastUsed = Date.now(); return { client: hit.client, srv }; }
  if (connecting.has(key)) return { client: await connecting.get(key), srv };
  if (hit) { hit.client.close().catch(() => {}); pool.delete(key); }
  const p = connect(srv).then((client) => { pool.set(key, { client, key: connKey, lastUsed: Date.now() }); return client; }).finally(() => connecting.delete(key));
  connecting.set(key, p);
  return { client: await p, srv };
}
export const dropClient = (id) => { const h = pool.get(String(id)); if (h) { h.client.close().catch(() => {}); pool.delete(String(id)); } };

// Cierra conexiones inactivas (evita sockets colgados en procesos de larga vida)
setInterval(() => { for (const [id, h] of pool) if (Date.now() - h.lastUsed > IDLE_MS) dropClient(id); }, 5 * 60 * 1000).unref();

async function fetchTools(id) {
  const run = async () => {
    const { client } = await getClient(id);
    const all = []; let cursor;
    do { const r = await client.listTools(cursor ? { cursor } : undefined); all.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor && all.length < 2000);
    return all.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations || undefined }));
  };
  try { return await run(); } catch (e) { dropClient(id); return run(); } // reconexión ante conexión caída
}

/** Catálogo de herramientas: memoria (60 s) → Redis (compartido) → servidor. Si está viejo, se usa y se refresca en segundo plano. */
async function getTools(id) {
  const key = String(id);
  const ver = (await redis.get(`mcp:ver:${id}`)) || '0';
  const mem = toolsMem.get(key);
  if (mem && mem.ver === ver && Date.now() - mem.at < 60000) return mem.tools;
  const raw = await redis.get(`mcp:tools:${id}`);
  if (raw) {
    const c = JSON.parse(raw);
    if (c.ver === ver) {
      toolsMem.set(key, { ver, tools: c.tools, at: Date.now() });
      if (Date.now() - c.at > TOOLS_FRESH_MS && (await redis.set(`mcp:tools:lock:${id}`, 1, 'EX', 60, 'NX'))) {
        fetchTools(id).then((tools) => storeTools(id, ver, tools)).catch(() => {}); // stale-while-revalidate
      }
      return c.tools;
    }
  }
  const tools = await fetchTools(id);
  await storeTools(id, ver, tools);
  return tools;
}
async function storeTools(id, ver, tools) {
  toolsMem.set(String(id), { ver, tools, at: Date.now() });
  await redis.set(`mcp:tools:${id}`, JSON.stringify({ ver, at: Date.now(), tools }), 'EX', 86400);
  McpServer.updateOne({ _id: id }, { lastCheck: { ok: true, at: new Date(), toolCount: tools.length } }).catch(() => {});
}

/** Herramientas de todos los MCP del bot, en paralelo, con nombres únicos `slug__tool` (≤64 chars). */
export async function loadTools(serverIds) {
  const tools = []; const routes = new Map();
  await Promise.all((serverIds || []).map(async (id) => {
    try {
      const { srv } = await loadServer(id); if (!srv?.enabled) return;
      const list = await withTimeout(getTools(id), SERVER_TIMEOUT_MS, srv.name);
      for (const t of list) {
        if (srv.toolAllowlist?.length && !srv.toolAllowlist.includes(t.name)) continue;
        const name = `${sanitize(srv.slug || 'mcp')}__${sanitize(t.name)}`.slice(0, 64);
        tools.push({ name, description: `[${srv.name}] ${t.description || ''}`.slice(0, 1024), schema: t.inputSchema || { type: 'object', properties: {} }, annotations: t.annotations });
        routes.set(name, { serverId: id, tool: t.name, label: `${srv.name} › ${t.name}`, annotations: t.annotations });
      }
    } catch (err) {
      dropClient(id);
      logger.warn({ serverId: String(id), err: err.message }, 'MCP no disponible');
      McpServer.updateOne({ _id: id }, { lastCheck: { ok: false, at: new Date(), error: err.message } }).catch(() => {});
    }
  }));
  return { tools, routes };
}

const compact = (text) => {
  const t = text.trim();
  if ((t.startsWith('{') || t.startsWith('[')) && t.length < 2e6) { try { return JSON.stringify(JSON.parse(t)); } catch { /* no es JSON */ } }
  return text;
};

export async function callTool(route, args) {
  const run = async () => {
    const c = await getClient(route.serverId);
    if (!c) throw new Error('Conector desactivado');
    return c.client.callTool({ name: route.tool, arguments: args || {} }, undefined, { timeout: 60000 });
  };
  let res;
  try { res = await run(); } catch (e) { dropClient(route.serverId); res = await run(); } // 1 reintento con conexión nueva
  // Archivos devueltos por el conector (imágenes, recursos binarios, enlaces a recursos): se entregan aparte, no como texto ilegible
  const files = [];
  const text = (res.content || []).map((p) => {
    if (p.type === 'text') return compact(p.text);
    if (p.type === 'image') { files.push({ name: `imagen-${files.length + 1}.${(p.mimeType || 'image/png').split('/')[1]}`, mime: p.mimeType || 'image/png', data: p.data }); return `[archivo adjunto: imagen-${files.length}]`; }
    if (p.type === 'resource' && p.resource?.blob) { const n = p.resource.uri?.split('/').pop() || `archivo-${files.length + 1}`; files.push({ name: n, mime: p.resource.mimeType || 'application/octet-stream', data: p.resource.blob, uri: p.resource.uri }); return `[archivo adjunto: ${n}]`; }
    if (p.type === 'resource' && p.resource?.text) return compact(p.resource.text);
    if (p.type === 'resource_link') { files.push({ name: p.name || p.uri?.split('/').pop(), mime: p.mimeType, uri: p.uri }); return `[enlace a archivo: ${p.name || p.uri}]`; }
    return `[${p.type}]`;
  }).join('\n');
  const full = text || JSON.stringify(res.structuredContent || {});
  const out = full.length > 20000 ? `${full.slice(0, 20000)}\n\n[RESPUESTA RECORTADA: ${full.length.toLocaleString('es-ES')} caracteres, solo ves los primeros 20.000. Vuelve a consultar pidiendo SOLO los campos que necesitas (parámetro fields, p. ej. fields=Deal_Name,Stage,Owner,…) y/o menos registros por página.]` : full;
  return { isError: !!res.isError, text: out, files };
}

export async function testServer(serverId) {
  await bumpMcpVersion(serverId);
  try {
    const tools = await getTools(serverId);
    return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
  } catch (err) {
    await McpServer.updateOne({ _id: serverId }, { lastCheck: { ok: false, at: new Date(), error: err.message } });
    return { ok: false, error: err.message };
  }
}
