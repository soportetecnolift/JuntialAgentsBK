import { Audit, BotLog, daysFromNow } from '../models/index.js';
import { getTrace } from './trace.js';
import { logger } from '../config/logger.js';

export function audit(req, action, target = {}, meta = {}) {
  const u = req.user || {};
  Audit.create({
    actorId: u.id, actorEmail: u.email, actorRole: u.role, tenantId: u.tenantId, action, target, meta,
    ip: req.ip, requestId: req.id, expiresAt: daysFromNow(365),
  }).catch((err) => logger.warn({ err }, 'audit write failed'));
}

/** Log visible para el cliente en su panel del bot (30 días). */
/** Registro estructurado por agente: nivel, evento, traza (correlación), canal, duración y metadatos. */
export function botLog(botId, level, event, message, meta = {}, chatId) {
  const tr = getTrace();
  const traceId = meta.traceId || tr?.traceId; const source = meta.source || tr?.source; const chat = chatId ?? tr?.chatId;
  const elapsedMs = tr ? Date.now() - tr.t0 : undefined;
  logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ botId: String(botId), event, chatId: chat, traceId, source, ...meta }, message);
  BotLog.create({ botId, level, event, message: String(message).slice(0, 4000), meta, chatId: chat, traceId, source, elapsedMs, expiresAt: daysFromNow(30) }).catch(() => {});
}
