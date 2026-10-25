import { Router } from 'express';
import { z } from 'zod';
import { Webhook, WebhookDelivery, Bot } from '../../models/index.js';
import { asyncH, notFound, tooMany } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { tenantScope } from '../../middleware/auth.js';
import { encrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { redis, takeToken } from '../../lib/redis.js';
import { Q } from '../../lib/queues.js';
import { env } from '../../config/env.js';
import { assertLimit } from '../plans/limits.js';
import { audit } from '../../lib/audit.js';
import { EVENTS, invalidateWebhookCache } from './dispatcher.js';

export const router = Router({ mergeParams: true });
const schema = z.object({
  name: z.string().min(2).max(80), direction: z.enum(['inbound', 'outbound']),
  action: z.enum(['send_message', 'run_agent']).optional(), template: z.string().max(4000).optional(), chatIds: z.array(z.number()).optional(),
  url: z.string().url().optional(), events: z.array(z.string()).optional(), enabled: z.boolean().optional(),
}).refine((d) => (d.direction === 'outbound' ? !!d.url && d.events?.length : !!d.template && d.chatIds?.length), { message: 'Faltan campos para este tipo de webhook' });

async function ownBot(req) { const b = await Bot.findOne({ _id: req.params.botId, ...tenantScope(req) }).lean(); if (!b) throw notFound('Bot'); return b; }

router.get('/', asyncH(async (req, res) => {
  const bot = await ownBot(req);
  res.json({ events: EVENTS, items: await Webhook.find({ botId: bot._id }).lean(), inboundBase: `${env.PUBLIC_API_URL}/hooks/in/` });
}));
router.post('/', validate(schema), asyncH(async (req, res) => {
  const bot = await ownBot(req);
  await assertLimit(bot.tenantId, 'webhooks', await Webhook.countDocuments({ tenantId: bot.tenantId }));
  const doc = { ...req.body, tenantId: bot.tenantId, botId: bot._id }; let reveal;
  if (req.body.direction === 'inbound') { const token = randomToken(24); doc.tokenHash = sha256(token); reveal = { url: `${env.PUBLIC_API_URL}/hooks/in/${token}` }; }
  else { const secret = `whsec_${randomToken(24)}`; doc.secretEnc = encrypt(secret); reveal = { secret }; }
  const wh = await Webhook.create(doc); await invalidateWebhookCache(bot._id);
  audit(req, 'webhook.create', { kind: 'webhook', id: wh.id });
  res.status(201).json({ webhook: wh, ...reveal, note: 'Guárdalo ahora: no se volverá a mostrar.' });
}));
router.put('/:id', asyncH(async (req, res) => {
  const bot = await ownBot(req);
  const allowed = (({ name, template, chatIds, url, events, enabled, action }) => ({ name, template, chatIds, url, events, enabled, action }))(req.body);
  Object.keys(allowed).forEach((k) => allowed[k] === undefined && delete allowed[k]);
  if (allowed.enabled) allowed.consecutiveFailures = 0;
  const wh = await Webhook.findOneAndUpdate({ _id: req.params.id, botId: bot._id }, allowed, { new: true }); if (!wh) throw notFound();
  await invalidateWebhookCache(bot._id); res.json(wh);
}));
router.delete('/:id', asyncH(async (req, res) => {
  const bot = await ownBot(req); await Webhook.deleteOne({ _id: req.params.id, botId: bot._id }); await invalidateWebhookCache(bot._id);
  audit(req, 'webhook.delete', { kind: 'webhook', id: req.params.id }); res.json({ ok: true });
}));
router.get('/:id/deliveries', asyncH(async (req, res) => {
  await ownBot(req); res.json(await WebhookDelivery.find({ webhookId: req.params.id }).sort({ createdAt: -1 }).limit(50).lean());
}));

/** Endpoint público de webhooks entrantes: POST /hooks/in/:token */
export const inboundHandler = asyncH(async (req, res) => {
  const wh = await Webhook.findOne({ tokenHash: sha256(req.params.token), direction: 'inbound', enabled: true }).lean();
  if (!wh) throw notFound();
  if ((await takeToken(`wh:in:${wh._id}`, 2, 30)) > 0) throw tooMany(); // 120/min con ráfaga de 30
  const idem = req.headers['idempotency-key'];
  if (idem && !(await redis.set(`wh:idem:${wh._id}:${idem}`, 1, 'EX', 86400, 'NX'))) return res.status(200).json({ ok: true, duplicate: true });
  const job = await Q.inbound.add('inbound', { webhookId: String(wh._id), payload: { body: req.body, query: req.query, receivedAt: new Date().toISOString() } }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  res.status(202).json({ ok: true, jobId: job.id });
});
