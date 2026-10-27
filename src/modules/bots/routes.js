import { Router } from 'express';
import { z } from 'zod';
import { Bot, BotLog, ChatContext, Message, Task, McpServer } from '../../models/index.js';
import { asyncH, notFound, badRequest } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { tenantScope } from '../../middleware/auth.js';
import { encrypt, mask, randomToken, sha256 } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { TgApi, TokenInvalidError } from '../../telegram/api.js';
import { bumpBotVersion, getBotRuntime } from '../../telegram/runtime.js';
import { runAgent, defaultModel } from '../../ai/agent.js';
import { listModels, newerFor } from '../../ai/models.js';
import { decrypt } from '../../lib/crypto.js';
import { assertLimit, getTenantPlan, limitOf } from '../plans/limits.js';
import { notify } from '../notifications/service.js';
import { audit, botLog } from '../../lib/audit.js';
import { unscheduleTask } from '../tasks/scheduler.js';
import { router as taskRouter } from '../tasks/routes.js';
import { router as webhookRouter } from '../webhooks/routes.js';
import webRoutes from '../web/routes.js';
import workerRoutes from '../worker/routes.js';
import { ROLES, AUTONOMY_PRESETS } from '../worker/roles.js';
import { WorkerRoutine } from '../../models/index.js';
import { syncRoutine } from '../worker/engine.js';
import { emitPlatformEvent } from '../platform/events.js';

const r = Router();
r.use('/:botId/tasks', taskRouter);
r.use('/:botId/webhooks', webhookRouter);
r.use('/:botId/web', webRoutes);
r.use('/:botId/worker', workerRoutes);

const find = async (req, id = req.params.id) => { const b = await Bot.findOne({ _id: id, ...tenantScope(req) }); if (!b) throw notFound('Bot'); return b; };
const done = async (bot) => { await bumpBotVersion(bot._id); return bot; };

r.get('/', asyncH(async (req, res) => res.json(await Bot.find(tenantScope(req)).sort({ createdAt: -1 }).lean())));
r.post('/', validate(z.object({ name: z.string().min(2).max(60), kind: z.enum(['telegram', 'web', 'worker']).default('telegram'), role: z.string().optional() })), asyncH(async (req, res) => {
  const tenantId = req.user.tenantId; if (!tenantId) throw badRequest('Tu usuario no pertenece a un cliente');
  await assertLimit(tenantId, 'bots', await Bot.countDocuments({ tenantId }));
  const web = req.body.kind === 'web'; const worker = req.body.kind === 'worker';
  const role = ROLES[req.body.role] || ROLES.personalizado;
  // Empleados digitales: informes multi-registro y varios pasos de consulta por tarea → necesitan bastante más
  // margen que un bot conversacional. 1500/8 (lo que usa Telegram/web) les corta los informes a mitad de frase.
  const bot = await Bot.create({ tenantId, name: req.body.name, kind: req.body.kind, status: web || worker ? 'active' : 'paused',
    ai: { provider: 'anthropic', model: defaultModel('anthropic'), ...(worker ? { maxTokens: 8000, maxToolSteps: 16 } : {}) },
    ...(web ? { web: { publicKey: `ja_pk_${randomToken(18)}`, appearance: { title: req.body.name }, voice: { enabled: true, mode: 'browser' } } } : {}),
    ...(worker ? { systemPrompt: '', worker: { role: req.body.role || 'personalizado', title: role.title, mission: role.mission, responsibilities: role.responsibilities, kpis: role.kpis, knowledge: { instructions: '', examples: [] }, memory: [], blueprint: {},
      autonomy: { preset: role.preset, policy: AUTONOMY_PRESETS[role.preset].policy } } } : {}) });
  if (worker) for (const rt of role.routines) await syncRoutine(await WorkerRoutine.create({ ...rt, tenantId, botId: bot._id, enabled: false })); // creadas en pausa: el cliente las revisa y las activa
  audit(req, 'bot.create', { kind: 'bot', id: bot.id }); emitPlatformEvent('bot.created', { botId: bot.id, tenantId: String(tenantId), name: bot.name });
  res.status(201).json(bot);
}));
r.get('/:id', asyncH(async (req, res) => {
  const bot = await find(req);
  res.json({ ...bot.toObject(), webhookUrl: `${env.PUBLIC_API_URL}/tg/${bot._id}` });
}));

const settings = z.object({
  name: z.string().min(2).max(60).optional(), systemPrompt: z.string().max(20000).optional(),
  behavior: z.object({
    groupMode: z.enum(['mention', 'always', 'commands']), triggerKeywords: z.array(z.string().max(40)).max(20), progressMessages: z.boolean(),
    learnFromGroup: z.boolean(), historyTurns: z.number().int().min(0).max(60), allowedChatIds: z.array(z.number()).max(500), language: z.string().max(10),
    buttons: z.object({
      agent: z.boolean().default(true),
      menu: z.object({ enabled: z.boolean(), buttons: z.array(z.string().min(1).max(60)).max(12) }).default({ enabled: false, buttons: [] }),
      sets: z.array(z.object({ name: z.string().min(1).max(40), when: z.string().max(200).default(''), buttons: z.array(z.string().min(1).max(300)).min(1).max(12) })).max(20).default([]),
    }),
  }).partial().optional(),
  crm: z.object({ enabled: z.boolean() }).optional(),
  flood: z.object({ perChatPerMinute: z.number().int().min(1).max(120), maxPending: z.number().int().min(1).max(50), debounceMs: z.number().int().min(0).max(10000) }).partial().optional(),
});
r.put('/:id', validate(settings), asyncH(async (req, res) => {
  const bot = await find(req);
  if (req.body.name) bot.name = req.body.name;
  if (req.body.systemPrompt !== undefined) bot.systemPrompt = req.body.systemPrompt;
  if (req.body.behavior) bot.behavior = { ...bot.behavior.toObject(), ...req.body.behavior };
  if (req.body.flood) bot.flood = { ...bot.flood.toObject(), ...req.body.flood };
  if (req.body.crm) bot.crm = req.body.crm;
  await bot.save(); await done(bot); audit(req, 'bot.update', { kind: 'bot', id: bot.id }); res.json(bot);
}));

/* ── Telegram: el cliente pega el token de @BotFather ── */
r.put('/:id/telegram', validate(z.object({ token: z.string().regex(/^\d{5,}:[\w-]{30,}$/, 'Formato de token inválido') })), asyncH(async (req, res) => {
  const bot = await find(req);
  const api = new TgApi(req.body.token, String(bot._id));
  let me; try { me = await api.getMe(); } catch (e) { throw badRequest(e instanceof TokenInvalidError ? 'Telegram rechazó el token' : e.message); }
  const dup = await Bot.findOne({ 'telegram.botId': me.id, _id: { $ne: bot._id } }).lean();
  if (dup) throw badRequest('Este bot de Telegram ya está conectado en otra cuenta');
  const secret = randomToken(32);
  await api.setWebhook(`${env.PUBLIC_API_URL}/tg/${bot._id}`, secret);
  await api.call('setMyCommands', { commands: [{ command: 'start', description: 'Empezar' }, { command: 'ayuda', description: 'Qué puedo hacer' }] }).catch(() => {});
  bot.telegram = { tokenEnc: encrypt(req.body.token), tokenMask: mask(req.body.token), botId: me.id, username: me.username, webhookSecretHash: sha256(secret), connected: true, lastError: null };
  if (bot.status !== 'paused' || !bot.stats.messagesIn) bot.status = 'active';
  await bot.save(); await done(bot);
  notify(req.user.id, 'bot.connected', { username: me.username, botId: bot.id }).catch(() => {});
  botLog(bot._id, 'info', 'telegram.connected', `Conectado como @${me.username}`);
  audit(req, 'bot.telegram.connect', { kind: 'bot', id: bot.id }); emitPlatformEvent('bot.connected', { botId: bot.id, tenantId: String(bot.tenantId), username: me.username });
  res.json({ username: me.username, canReadAllGroupMessages: me.can_read_all_group_messages,
    hint: me.can_read_all_group_messages ? null : 'Privacy mode activo: en grupos solo verá menciones, respuestas y comandos. Para que aprenda del contexto del grupo, desactívalo en @BotFather → /setprivacy → Disable.' });
}));
r.delete('/:id/telegram', asyncH(async (req, res) => {
  const bot = await find(req); const rt = await getBotRuntime(bot._id);
  await rt?.api?.deleteWebhook().catch(() => {});
  bot.telegram = { connected: false }; bot.status = 'paused'; await bot.save(); await done(bot);
  audit(req, 'bot.telegram.disconnect', { kind: 'bot', id: bot.id }); res.json({ ok: true });
}));

/* ── IA: Claude o GPT con la clave del cliente ── */
// Lista EN VIVO los modelos a los que tiene acceso la clave (la guardada o una nueva aún sin guardar)
r.post('/:id/ai/models', validate(z.object({ provider: z.enum(['anthropic', 'openai']), apiKey: z.string().min(20).optional(), refresh: z.boolean().optional() })), asyncH(async (req, res) => {
  const bot = await Bot.findOne({ _id: req.params.id, ...tenantScope(req) }).select('+ai.apiKeyEnc'); if (!bot) throw notFound('Bot');
  const key = req.body.apiKey || (req.body.provider === bot.ai.provider ? decrypt(bot.ai.apiKeyEnc) : null);
  try {
    const { models, source } = await listModels(req.body.provider, key, { force: !!req.body.refresh });
    const current = bot.ai.provider === req.body.provider ? (bot.ai.model || defaultModel(bot.ai.provider)) : null;
    res.json({ source, models, current, currentAvailable: current ? models.some((m) => m.id === current) : null, newer: current ? newerFor(models, current) : null });
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw badRequest('La API key no es válida o no tiene permisos para listar modelos');
    const { models } = await listModels(req.body.provider, null);
    res.json({ source: 'fallback', models, warning: `No se pudo consultar el proveedor (${e.message}). Se muestra la lista de respaldo.` });
  }
}));

r.put('/:id/ai', validate(z.object({
  provider: z.enum(['anthropic', 'openai']), model: z.string().max(80).optional(), apiKey: z.string().min(20).optional(), transcribeKey: z.string().min(20).optional(), autoUpgrade: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(), maxTokens: z.number().int().min(100).max(16000).optional(), maxToolSteps: z.number().int().min(0).max(20).optional(),
})), asyncH(async (req, res) => {
  const bot = await Bot.findOne({ _id: req.params.id, ...tenantScope(req) }).select('+ai.apiKeyEnc'); if (!bot) throw notFound('Bot');
  const b = req.body;
  if (b.provider !== bot.ai.provider && !b.apiKey) throw badRequest('Al cambiar de proveedor debes indicar su API key');
  const model = b.model || defaultModel(b.provider);
  // Comprobar que el modelo existe para esa clave y ajustar el máximo de salida a su límite real
  const key = b.apiKey || decrypt(bot.ai.apiKeyEnc);
  const live = key ? await listModels(b.provider, key).catch(() => null) : null;
  if (live?.source === 'live') {
    const m = live.models.find((x) => x.id === model);
    if (!m) throw badRequest(`El modelo ${model} no está disponible para esta API key`);
    if (m.maxTokens && b.maxTokens > m.maxTokens) b.maxTokens = m.maxTokens;
  }
  bot.ai.provider = b.provider; bot.ai.model = model; bot.ai.modelStatus = { checkedAt: new Date(), available: true, newer: live ? newerFor(live.models, model)?.id || null : null };
  if (b.apiKey) { bot.ai.apiKeyEnc = encrypt(b.apiKey); bot.ai.apiKeyMask = mask(b.apiKey); }
  if (b.transcribeKey) bot.ai.transcribeKeyEnc = encrypt(b.transcribeKey);
  for (const k of ['temperature', 'maxTokens', 'maxToolSteps', 'autoUpgrade']) if (b[k] !== undefined) bot.ai[k] = b[k];
  await bot.save(); await done(bot); audit(req, 'bot.ai.update', { kind: 'bot', id: bot.id }, { provider: b.provider, model: bot.ai.model });
  res.json({ ok: true, ai: { provider: bot.ai.provider, model: bot.ai.model, apiKeyMask: bot.ai.apiKeyMask } });
}));
r.post('/:id/ai/test', asyncH(async (req, res) => {
  const bot = await find(req); const rt = await getBotRuntime(bot._id);
  if (!rt.aiKey) throw badRequest('Configura primero la API key');
  const t0 = Date.now();
  try {
    const out = await runAgent({ bot: { ...rt.bot, ai: { ...rt.bot.ai, maxTokens: 50 } }, apiKey: rt.aiKey, system: bot.systemPrompt?.trim() || (bot.kind === 'worker' ? `Eres ${bot.worker?.title || bot.name}, un empleado digital.` : 'Eres un asistente útil.'), turns: [{ role: 'user', parts: [{ type: 'text', text: req.body?.message || 'Responde solo: OK' }] }], tools: [], exec: async () => ({}) });
    res.json({ ok: true, reply: out.text, ms: Date.now() - t0 });
  } catch (e) { res.json({ ok: false, error: e.message }); }
}));

r.put('/:id/status', validate(z.object({ status: z.enum(['active', 'paused']) })), asyncH(async (req, res) => {
  const bot = await find(req);
  if (req.body.status === 'active' && bot.kind !== 'web' && !bot.telegram.connected) throw badRequest('Conecta Telegram antes de activar el bot');
  bot.status = req.body.status; await bot.save(); await done(bot); audit(req, `bot.${req.body.status}`, { kind: 'bot', id: bot.id }); res.json(bot);
}));
r.put('/:id/mcp', validate(z.object({ serverIds: z.array(z.string()) })), asyncH(async (req, res) => {
  const bot = await find(req);
  if (bot.kind === 'web' && req.body.serverIds.length && !bot.web?.mcpAck?.at) throw badRequest('Este agente es público: acepta primero el aviso de seguridad sobre conectores');
  const { plan } = await getTenantPlan(bot.tenantId);
  const maxMcp = limitOf(plan, 'mcpServers');
  if (maxMcp >= 0 && req.body.serverIds.length > maxMcp) throw badRequest(`Tu plan permite ${maxMcp} conectores por agente`);
  const valid = await McpServer.find({ _id: { $in: req.body.serverIds }, tenantId: bot.tenantId }).select('_id').lean();
  bot.mcpServerIds = valid.map((v) => v._id); await bot.save(); await done(bot); res.json(bot);
}));
r.delete('/:id', asyncH(async (req, res) => {
  const bot = await find(req); const rt = await getBotRuntime(bot._id);
  await rt?.api?.deleteWebhook().catch(() => {});
  const tasks = await Task.find({ botId: bot._id }); await Promise.all(tasks.map((t) => unscheduleTask(t.toObject())));
  await Promise.all([Task.deleteMany({ botId: bot._id }), ChatContext.deleteMany({ botId: bot._id }), Message.deleteMany({ botId: bot._id })]);
  await bot.deleteOne(); await bumpBotVersion(bot._id);
  audit(req, 'bot.delete', { kind: 'bot', id: String(bot._id) }); emitPlatformEvent('bot.deleted', { botId: String(bot._id), tenantId: String(bot.tenantId) });
  res.json({ ok: true });
}));

/* ── Playbooks (procedimientos) ── */
r.put('/:id/playbooks', validate(z.object({ playbooks: z.array(z.object({ name: z.string().min(2).max(80), when: z.string().max(500).default(''), steps: z.string().min(3).max(4000), enabled: z.boolean().default(true) })).max(30) })), asyncH(async (req, res) => {
  const bot = await find(req); bot.playbooks = req.body.playbooks; await bot.save(); await done(bot);
  audit(req, 'bot.playbooks.update', { kind: 'bot', id: bot.id }); res.json(bot.playbooks);
}));

/* ── Observabilidad y contexto de chats ── */
const logQuery = (bot, qs) => {
  const q = { botId: bot._id };
  if (qs.level) q.level = { $in: String(qs.level).split(',') };
  if (qs.event) q.event = new RegExp(`^${String(qs.event).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (qs.traceId) q.traceId = String(qs.traceId);
  if (qs.chatId) q.chatId = Number(qs.chatId);
  if (qs.q) q.message = new RegExp(String(qs.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (qs.before || qs.since) q.createdAt = { ...(qs.before ? { $lt: new Date(qs.before) } : {}), ...(qs.since ? { $gte: new Date(qs.since) } : {}) };
  return q;
};
r.get('/:id/logs', asyncH(async (req, res) => {
  const bot = await find(req); const limit = Math.min(+req.query.limit || 100, 500);
  const items = await BotLog.find(logQuery(bot, req.query)).sort({ createdAt: -1 }).limit(limit + 1).lean();
  res.json({ items: items.slice(0, limit), next: items.length > limit ? items[limit - 1].createdAt : null });
}));
// Resumen de 24 h: totales por nivel, eventos más frecuentes e histograma por hora
r.get('/:id/logs/stats', asyncH(async (req, res) => {
  const bot = await find(req); const since = new Date(Date.now() - 24 * 3600000); const m = { botId: bot._id, createdAt: { $gte: since } };
  const [byLevel, byEvent, hist] = await Promise.all([
    BotLog.aggregate([{ $match: m }, { $group: { _id: '$level', n: { $sum: 1 } } }]),
    BotLog.aggregate([{ $match: m }, { $group: { _id: '$event', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 25 }]),
    BotLog.aggregate([{ $match: m }, { $group: { _id: { h: { $dateTrunc: { date: '$createdAt', unit: 'hour' } }, l: '$level' }, n: { $sum: 1 } } }]),
  ]);
  const hours = Array.from({ length: 24 }, (_, i) => { const h = new Date(Math.floor((Date.now() - (23 - i) * 3600000) / 3600000) * 3600000); return { h, info: 0, warn: 0, error: 0 }; });
  for (const x of hist) { const slot = hours.find((s) => +s.h === +new Date(x._id.h)); if (slot) slot[x._id.l] = (slot[x._id.l] || 0) + x.n; }
  res.json({ levels: Object.fromEntries(byLevel.map((x) => [x._id, x.n])), events: byEvent.map((x) => ({ event: x._id, n: x.n })), hours });
}));
r.get('/:id/logs/export', asyncH(async (req, res) => {
  const bot = await find(req); const rows = await BotLog.find(logQuery(bot, req.query)).sort({ createdAt: -1 }).limit(10000).lean();
  const fmt = req.query.format === 'csv' ? 'csv' : 'ndjson';
  res.setHeader('Content-Disposition', `attachment; filename="logs-${bot.name.replace(/\W+/g, '_')}-${new Date().toISOString().slice(0, 10)}.${fmt}"`);
  if (fmt === 'csv') {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.type('text/csv').send(['fecha,nivel,evento,mensaje,chat,traza,origen', ...rows.map((l) => [l.createdAt.toISOString(), l.level, l.event, l.message, l.chatId, l.traceId, l.source].map(esc).join(','))].join('\n'));
  } else res.type('application/x-ndjson').send(rows.map((l) => JSON.stringify(l)).join('\n'));
}));
r.get('/:id/chats', asyncH(async (req, res) => { const bot = await find(req); res.json(await ChatContext.find({ botId: bot._id }).sort({ lastMessageAt: -1 }).limit(200).lean()); }));
r.get('/:id/chats/:chatId/messages', asyncH(async (req, res) => {
  const bot = await find(req); res.json((await Message.find({ botId: bot._id, chatId: +req.params.chatId }).sort({ createdAt: -1 }).limit(80).lean()).reverse());
}));
r.put('/:id/chats/:chatId', validate(z.object({ project: z.object({ name: z.string(), code: z.string().optional(), description: z.string().optional(), crmRef: z.string().optional() }).optional(), muted: z.boolean().optional(), notes: z.array(z.object({ text: z.string() })).optional() })), asyncH(async (req, res) => {
  const bot = await find(req);
  const update = { ...req.body }; if (update.notes) update.notes = update.notes.map((n) => ({ ...n, at: new Date(), by: 'panel' }));
  res.json(await ChatContext.findOneAndUpdate({ botId: bot._id, chatId: +req.params.chatId }, update, { new: true }));
}));
r.delete('/:id/chats/:chatId/history', asyncH(async (req, res) => {
  const bot = await find(req); await Message.deleteMany({ botId: bot._id, chatId: +req.params.chatId }); res.json({ ok: true });
}));
export default r;
