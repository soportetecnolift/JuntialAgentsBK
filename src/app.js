import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { redis } from './lib/redis.js';
import { registry } from './lib/metrics.js';
import { requestId, metricsMw, notFoundMw, errorMw } from './middleware/common.js';
import { requireAuth } from './middleware/auth.js';
import { telegramWebhook } from './telegram/ingress.js';
import { inboundHandler } from './modules/webhooks/routes.js';
import { oauthCallback } from './modules/mcp/routes.js';
import authRoutes from './modules/auth/routes.js';
import botRoutes from './modules/bots/routes.js';
import mcpRoutes from './modules/mcp/routes.js';
import planRoutes from './modules/plans/routes.js';
import supportRoutes from './modules/support/routes.js';
import notificationRoutes from './modules/notifications/routes.js';
import adminRoutes from './modules/admin/routes.js';
import developerRoutes, { platformWebhookRouter } from './modules/developer/routes.js';
import { createV1 } from './api/v1.js';
import { docsHtml } from './api/openapi.js';
import widgetPublic from './modules/web/public.js';
import crmRoutes from './modules/crm/routes.js';
import { approvalPublic } from './modules/worker/channels.js';
import centerRoutes, { invitationLookup } from './modules/center/routes.js';
import { appGuard } from './modules/center/access.js';
import { wellKnown, oauthPublic, oauthConsent } from './modules/oauth/server.js';
import { mcpRouter } from './modules/oauth/mcp.js';

// El panel (WEB_URL) siempre está permitido, aunque CORS_ORIGINS falte o no lo incluya
export const corsOrigins = [...new Set([...env.CORS_ORIGINS.split(','), env.WEB_URL].map((s) => s.trim().replace(/\/$/, '')).filter(Boolean))];
const limiter = (prefix, windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, store: new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...a) => redis.call(...a) }), message: { error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes, inténtalo más tarde' } } });

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => ['/healthz', '/readyz', '/metrics'].includes(req.url) }, customLogLevel: (_q, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info') }));
  // Widget público de agentes web (antes de helmet/compression: carga cross-origin + streaming SSE)
  app.use('/widget/v1', widgetPublic);

  // Documentación interactiva (Scalar) — CSP propia para permitir su script
  app.get('/docs', helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'", 'https://cdn.jsdelivr.net', "'unsafe-inline'"], 'connect-src': ["'self'", '*'], 'img-src': ["'self'", 'data:', 'https:'], 'font-src': ["'self'", 'https:', 'data:'] } } }), (_q, res) => res.type('html').send(docsHtml()));
  app.use(helmet());
  app.use(compression({ filter: (req, res) => (/text\/event-stream/.test(req.headers.accept || '') ? false : compression.filter(req, res)) })); // sin buffer en streaming
  app.use(metricsMw);

  // Probes / métricas (exponer /metrics solo en red interna en producción)
  app.get('/healthz', (_q, res) => res.json({ ok: true }));
  app.get('/readyz', async (_q, res) => {
    const mongo = mongoose.connection.readyState === 1; const rds = (await redis.ping().catch(() => '')) === 'PONG';
    res.status(mongo && rds ? 200 : 503).json({ mongo, redis: rds });
  });
  app.get('/metrics', async (_q, res) => { res.set('content-type', registry.contentType); res.end(await registry.metrics()); });

  // Endpoints de máquina (sin CORS, cuerpo acotado)
  app.post('/tg/:botId', express.json({ limit: '1mb' }), telegramWebhook);
  app.post('/hooks/in/:token', express.json({ limit: '512kb' }), inboundHandler);
  app.use('/a', limiter('approval', 60000, 60), approvalPublic);
  // Subida de documentos al empleado digital (hasta 10 MB en base64): parser con límite mayor solo en esa ruta
  app.post(['/api/bots/:botId/worker/files', '/v1/bots/:botId/worker/files'], express.json({ limit: '15mb' })); // decisiones de aprobación por enlace (email, webhook)
  app.get('/api/mcp/oauth/callback', oauthCallback);

  // OAuth 2.1 + MCP para Claude, ChatGPT y otras apps de IA
  const openCors = cors({ origin: '*', allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID'], exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] });
  app.use('/.well-known', openCors); // CORS abierto SOLO para los metadatos públicos (nunca para /api, que usa cookies)
  app.use(wellKnown);
  app.use('/oauth', openCors, limiter('oauth', 60000, 120), oauthPublic);
  app.use('/mcp', openCors, express.json({ limit: '12mb' }), limiter('mcp', 60000, 600), mcpRouter);

  // API pública v1 (API keys de cliente y de administrador)
  app.use('/v1', createV1());

  // API de la plataforma
  app.use('/api', cors({ origin: corsOrigins, credentials: true }), express.json({ limit: '2mb' }), cookieParser(), limiter('api', 60000, 600));
  app.use('/api/auth', limiter('auth', 15 * 60000, 60), authRoutes);
  // Juntial Center
  app.get('/api/center/invitations/lookup/:token', invitationLookup);
  app.use('/api/center', requireAuth, centerRoutes);
  app.use('/api/oauth', requireAuth, oauthConsent);
  // JuntialAgents: permisos según el rol de cada persona en la app
  const ja = appGuard('juntialagents');
  app.use('/api/bots', requireAuth, ja, botRoutes);
  app.use('/api/mcp', requireAuth, ja, mcpRoutes);
  app.use('/api/plans', requireAuth, planRoutes);
  app.use('/api/support', requireAuth, supportRoutes);
  app.use('/api/notifications', requireAuth, notificationRoutes);
  app.use('/api/admin', requireAuth, adminRoutes);
  app.use('/api/crm', requireAuth, ja, crmRoutes);
  app.use('/api/developer/platform-webhooks', requireAuth, platformWebhookRouter);
  app.use('/api/developer', requireAuth, ja, developerRoutes);

  app.use(notFoundMw);
  app.use(errorMw);
  return app;
}
