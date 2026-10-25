import { Router } from 'express';
import cors from 'cors';
import express from 'express';
import { apiKeyAuth, scope, adminOnly } from './keyAuth.js';
import { actions } from './actions.js';
import { openapi } from './openapi.js';
import botRoutes from '../modules/bots/routes.js';
import mcpRoutes from '../modules/mcp/routes.js';
import planRoutes from '../modules/plans/routes.js';
import supportRoutes from '../modules/support/routes.js';
import adminRoutes from '../modules/admin/routes.js';
import { platformWebhookRouter } from '../modules/developer/routes.js';
import crmRoutes from '../modules/crm/routes.js';
import centerRoutes from '../modules/center/routes.js';
import { appGuard } from '../modules/center/access.js';
import { ApiKey } from '../models/index.js';
import { asyncH } from '../lib/errors.js';

/**
 * API pública v1 (servidor a servidor). Reutiliza la MISMA lógica de negocio que la web:
 * cada router comprueba tenant/rol, y aquí se añade la capa de API key + scopes.
 *   Clientes  → ja_live_ck_…  (limitado a su tenant y a los scopes de la clave)
 *   Admins    → ja_live_ak_…  (alcance de plataforma, según el rol actual del dueño)
 */
export function createV1() {
  const v1 = Router();
  v1.use(cors({ origin: '*', allowedHeaders: ['Authorization', 'X-API-Key', 'Content-Type', 'Idempotency-Key'], exposedHeaders: ['RateLimit-Policy', 'Retry-After', 'X-Request-Id'] }));
  v1.get('/openapi.json', (_req, res) => res.json(openapi()));
  v1.use(express.json({ limit: '10mb' }), apiKeyAuth);

  v1.use(actions);
  // Permisos de la app según el rol de la persona en su organización (Juntial Center)
  v1.use(['/bots', '/connectors', '/crm', '/usage'], appGuard('juntialagents'));
  const botScope = (req) => ({ tasks: 'tasks', webhooks: 'webhooks', chats: 'chats', worker: 'workers', logs: 'bots' }[req.path.split('/')[2]] || 'bots');
  v1.use('/bots', scope(botScope), botRoutes);
  v1.use('/connectors', scope('mcp'), mcpRoutes);
  v1.use('/crm', scope((req) => (req.path.startsWith('/functions') || req.path.startsWith('/workflows') || req.path.startsWith('/fields') ? 'crm_admin' : 'crm')), crmRoutes);
  v1.use('/center', scope((req) => (req.path.startsWith('/approvals') ? 'approvals' : 'center')), centerRoutes);
  v1.use('/usage', scope('usage:read'), (req, _res, next) => { req.url = '/me'; next(); }, planRoutes);
  v1.use('/support', (req, res, next) => (req.apiKey.kind === 'admin' ? scope('admin:support')(req, res, next) : scope('support')(req, res, next)), supportRoutes);

  // ── Admin API ──
  const admin = Router();
  admin.use(adminOnly);
  admin.use('/platform-webhooks', scope('platform:webhooks'), platformWebhookRouter);
  admin.use('/plans', scope((req) => (req.method === 'GET' ? 'admin:read' : 'admin:write')), planRoutes);
  admin.get('/api-keys', scope('admin:read'), asyncH(async (req, res) => {
    const q = req.query.tenantId ? { tenantId: req.query.tenantId } : {};
    res.json(await ApiKey.find(q).select('-hash').sort({ createdAt: -1 }).limit(500).lean());
  }));
  admin.post('/api-keys/:id/revoke', scope('admin:write'), asyncH(async (req, res) => {
    const k = await ApiKey.findByIdAndUpdate(req.params.id, { revokedAt: new Date() }, { new: true });
    if (k) (await import('./keyAuth.js')).invalidateKey(k.hash);
    res.json({ ok: true });
  }));
  admin.use(scope((req) => (req.method === 'GET' ? 'admin:read' : 'admin:write')), adminRoutes);
  v1.use('/admin', admin);
  return v1;
}
