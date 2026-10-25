import { Router } from 'express';
import { z } from 'zod';
import { McpServer, Bot } from '../../models/index.js';
import { asyncH, notFound } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { tenantScope } from '../../middleware/auth.js';
import { assertLimit } from '../plans/limits.js';
import { audit } from '../../lib/audit.js';
import { writeCreds, readCreds, startAuthorization, handleCallback, CALLBACK } from './oauth.js';
import { testServer, bumpMcpVersion } from './client.js';
import { bumpBotVersion } from '../../telegram/runtime.js';
import { env } from '../../config/env.js';

const r = Router();
const schema = z.object({
  name: z.string().min(2).max(60), url: z.string().url(), transport: z.enum(['auto', 'streamable-http', 'sse']).default('auto'),
  authType: z.enum(['none', 'bearer', 'api_key', 'basic', 'headers', 'oauth2_code', 'oauth2_client_credentials']),
  credentials: z.object({
    token: z.string().optional(), headerName: z.string().optional(), apiKey: z.string().optional(), username: z.string().optional(), password: z.string().optional(),
    headers: z.record(z.string()).optional(), clientSecret: z.string().optional(),
  }).default({}),
  oauth: z.object({ authorizationUrl: z.string().url().optional(), tokenUrl: z.string().url().optional(), clientId: z.string().optional(), scopes: z.string().optional() }).optional(),
  toolAllowlist: z.array(z.string()).default([]), enabled: z.boolean().default(true),
});
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'mcp';
const clean = (s) => { const o = s.toObject ? s.toObject() : s; delete o.credentialsEnc; return o; };

r.get('/', asyncH(async (req, res) => res.json({ items: await McpServer.find(tenantScope(req)).lean(), oauthRedirectUri: CALLBACK() })));
r.post('/', validate(schema), asyncH(async (req, res) => {
  const tenantId = req.user.tenantId;
  await assertLimit(tenantId, 'mcpServers', await McpServer.countDocuments({ tenantId }));
  const { credentials, ...rest } = req.body;
  const srv = new McpServer({ ...rest, tenantId, slug: slugify(rest.name) });
  writeCreds(srv, credentials); await srv.save();
  audit(req, 'mcp.create', { kind: 'mcp', id: srv.id }, { authType: srv.authType });
  const needsOAuth = srv.authType === 'oauth2_code';
  res.status(201).json({ server: clean(srv), test: needsOAuth ? null : await testServer(srv._id), needsOAuth });
}));
r.put('/:id', validate(schema.partial()), asyncH(async (req, res) => {
  const srv = await McpServer.findOne({ _id: req.params.id, ...tenantScope(req) }).select('+credentialsEnc'); if (!srv) throw notFound();
  const { credentials, ...rest } = req.body;
  Object.assign(srv, rest); if (rest.name) srv.slug = slugify(rest.name);
  if (credentials) writeCreds(srv, { ...readCreds(srv), ...Object.fromEntries(Object.entries(credentials).filter(([, v]) => v !== '' && v != null)) });
  await srv.save(); await bumpMcpVersion(srv._id);
  const bots = await Bot.find({ mcpServerIds: srv._id }).select('_id').lean(); await Promise.all(bots.map((b) => bumpBotVersion(b._id)));
  res.json({ server: clean(srv) });
}));
r.post('/:id/test', asyncH(async (req, res) => {
  const srv = await McpServer.findOne({ _id: req.params.id, ...tenantScope(req) }).lean(); if (!srv) throw notFound();
  res.json(await testServer(srv._id));
}));
r.get('/:id/oauth/start', asyncH(async (req, res) => {
  const srv = await McpServer.findOne({ _id: req.params.id, ...tenantScope(req) }).lean(); if (!srv) throw notFound();
  res.json({ url: await startAuthorization(srv._id, req.user.id) });
}));
r.delete('/:id', asyncH(async (req, res) => {
  const srv = await McpServer.findOneAndDelete({ _id: req.params.id, ...tenantScope(req) }); if (!srv) throw notFound();
  await Bot.updateMany({ mcpServerIds: srv._id }, { $pull: { mcpServerIds: srv._id } }); await bumpMcpVersion(srv._id);
  audit(req, 'mcp.delete', { kind: 'mcp', id: req.params.id }); res.json({ ok: true });
}));

/** Callback público OAuth (sin JWT; protegido por state + PKCE) */
export const oauthCallback = asyncH(async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const srv = await handleCallback(String(req.query.code), String(req.query.state));
    await testServer(srv._id);
    res.redirect(`${env.WEB_URL}/connectors?oauth=ok&id=${srv._id}`);
  } catch (e) { res.redirect(`${env.WEB_URL}/connectors?oauth=error&msg=${encodeURIComponent(e.message)}`); }
});
export default r;
