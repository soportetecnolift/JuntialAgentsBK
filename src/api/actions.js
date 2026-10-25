import { Router } from 'express';
import { z } from 'zod';
import { Bot, ChatContext, ApiKey } from '../models/index.js';
import { asyncH, notFound, badRequest, planLimit } from '../lib/errors.js';
import { validate } from '../middleware/common.js';
import { tenantScope } from '../middleware/auth.js';
import { Q } from '../lib/queues.js';
import { redis } from '../lib/redis.js';
import { getBotRuntime } from '../telegram/runtime.js';
import { runAgent } from '../ai/agent.js';
import { BUILTIN_TOOLS, builtinExecutor } from '../ai/builtins.js';
import { loadTools, callTool } from '../modules/mcp/client.js';
import { buildSystemPrompt, loadHistory } from '../telegram/context.js';
import { consumeMessage } from '../modules/plans/limits.js';
import { scope } from './keyAuth.js';

/** Acciones exclusivas de la API pública (no existen en la web) */
export const actions = Router();
const ownBot = async (req) => { const b = await Bot.findOne({ _id: req.params.id, ...tenantScope(req) }).lean(); if (!b) throw notFound('Bot'); return b; };

/** Idempotencia estilo Stripe: misma Idempotency-Key ⇒ misma respuesta durante 24 h */
export function idempotent(handler) {
  return asyncH(async (req, res) => {
    const k = req.headers['idempotency-key'];
    if (!k) return handler(req, res);
    const ck = `idem:${req.apiKey.keyId}:${k}`;
    const prev = await redis.get(ck);
    if (prev) { const p = JSON.parse(prev); res.setHeader('Idempotent-Replayed', 'true'); return res.status(p.status).json(p.body); }
    const json = res.json.bind(res);
    res.json = (body) => { redis.set(ck, JSON.stringify({ status: res.statusCode, body }), 'EX', 86400).catch(() => {}); return json(body); };
    return handler(req, res);
  });
}

// POST /v1/bots/:id/messages — envía (asíncrono) un mensaje o una tarea del agente a uno o varios chats
actions.post('/bots/:id/messages', scope('messages:send'), validate(z.object({
  chatIds: z.array(z.number()).min(1).max(100), text: z.string().min(1).max(8000), mode: z.enum(['message', 'agent']).default('message'),
  buttons: z.array(z.union([z.string().max(300), z.object({ text: z.string().max(60), url: z.string().url().optional(), value: z.string().max(200).optional() })])).max(12).optional(),
})), idempotent(async (req, res) => {
  const bot = await ownBot(req);
  if (bot.status !== 'active') throw badRequest('El bot no está activo');
  const known = await ChatContext.countDocuments({ botId: bot._id, chatId: { $in: req.body.chatIds } });
  if (known !== req.body.chatIds.length) throw badRequest('Algún chatId no pertenece a este bot (el bot debe haber recibido antes un mensaje en ese chat)');
  if (req.body.mode === 'agent') { const q = await consumeMessage(bot.tenantId); if (!q.allowed) throw planLimit('Cuota de mensajes agotada'); }
  const job = await Q.inbound.add('api-send', { botId: String(bot._id), ...req.body, keyId: req.apiKey.keyId }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
  res.status(202).json({ jobId: job.id, status: 'queued', statusUrl: `/v1/jobs/${job.id}` });
}));

// GET /v1/jobs/:id — estado de un envío asíncrono
actions.get('/jobs/:id', asyncH(async (req, res) => {
  const job = await Q.inbound.getJob(req.params.id);
  if (!job || job.data.keyId !== req.apiKey.keyId) throw notFound('Job');
  res.json({ id: job.id, status: await job.getState(), attempts: job.attemptsMade, result: job.returnvalue, error: job.failedReason, createdAt: new Date(job.timestamp) });
}));

// POST /v1/bots/:id/agent — usa el bot como motor de IA desde tu sistema (síncrono, sin Telegram)
actions.post('/bots/:id/agent', scope('agent:run'), validate(z.object({
  input: z.string().min(1).max(20000), chatId: z.number().optional(), useTools: z.boolean().default(true),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20000) })).max(40).default([]),
  images: z.array(z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), data: z.string().max(7_000_000) })).max(4).default([]),
})), idempotent(async (req, res) => {
  const bot = await ownBot(req); const rt = await getBotRuntime(bot._id);
  if (!rt.aiKey) throw badRequest('El bot no tiene API key de IA configurada');
  const q = await consumeMessage(bot.tenantId); if (!q.allowed) throw planLimit('Cuota de mensajes agotada');
  const { input, chatId, useTools, history, images } = req.body;
  const ctx = chatId ? (await ChatContext.findOne({ botId: bot._id, chatId }).lean()) : null;
  const system = ctx ? buildSystemPrompt(rt.bot, ctx) : `${rt.bot.systemPrompt}\n\n## Contexto\n- Llamada desde la API de integraciones (no Telegram). Fecha: ${new Date().toISOString()}.`;
  const past = chatId ? await loadHistory(rt.bot, chatId, undefined, 20) : history.map((h) => ({ role: h.role, parts: [{ type: 'text', text: h.content }] }));
  const { tools, routes } = useTools ? await loadTools(rt.bot.mcpServerIds || []) : { tools: [], routes: new Map() };
  const builtin = chatId ? builtinExecutor({ bot: rt.bot, chatId, actor: 'api' }) : async () => null;
  const exec = async (n, a) => { try { return (await builtin(n, a)) || (routes.get(n) ? await callTool(routes.get(n), a) : { isError: true, text: 'Herramienta desconocida' }); } catch (e) { return { isError: true, text: e.message }; } };
  const t0 = Date.now();
  const out = await runAgent({ bot: rt.bot, apiKey: rt.aiKey, system, tools: chatId ? BUILTIN_TOOLS : [], mcpTools: tools, exec, hot: { bot: `hot:bot:${bot._id}`, chat: `hot:chat:${bot._id}:${chatId || 'api'}` },
    turns: [...past, { role: 'user', parts: [...images.map((i) => ({ type: 'image', mime: i.mime, data: i.data })), { type: 'text', text: input }] }] });
  res.json({ output: out.text, usage: out.usage, toolCalls: out.calls, model: rt.bot.ai.model, provider: rt.bot.ai.provider, ms: Date.now() - t0, timing: out.timing });
}));

// GET /v1/me — introspección de la clave
actions.get('/me', asyncH(async (req, res) => {
  const k = await ApiKey.findById(req.apiKey.keyId).lean();
  res.json({ keyId: req.apiKey.keyId, kind: k.kind, name: k.name, scopes: k.scopes, tenantId: k.tenantId, rateLimitPerMin: req.apiKey.rpm, expiresAt: k.expiresAt });
}));
