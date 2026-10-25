import { Router } from 'express';
import { z } from 'zod';
import { Task, Bot } from '../../models/index.js';
import { asyncH, notFound, badRequest } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { tenantScope } from '../../middleware/auth.js';
import { assertLimit } from '../plans/limits.js';
import { audit } from '../../lib/audit.js';
import { Q } from '../../lib/queues.js';
import { syncTask, validateCron } from './scheduler.js';

export const router = Router({ mergeParams: true });
const schema = z.object({
  name: z.string().min(2).max(100), type: z.enum(['cron', 'once']), cron: z.string().optional(), runAt: z.coerce.date().optional(),
  timezone: z.string().default('Europe/Madrid'), action: z.enum(['agent', 'message']).default('agent'),
  prompt: z.string().min(1).max(8000), chatIds: z.array(z.number()).min(1), enabled: z.boolean().default(true),
});
async function ownBot(req) { const b = await Bot.findOne({ _id: req.params.botId, ...tenantScope(req) }).lean(); if (!b) throw notFound('Bot'); return b; }
function check(body) {
  if (body.type === 'cron') { if (!body.cron) throw badRequest('Falta la expresión cron'); return validateCron(body.cron, body.timezone); }
  if (!body.runAt || body.runAt < new Date()) throw badRequest('La fecha debe ser futura'); return body.runAt;
}

router.get('/', asyncH(async (req, res) => { const bot = await ownBot(req); res.json(await Task.find({ botId: bot._id }).sort({ createdAt: -1 }).lean()); }));
router.post('/', validate(schema), asyncH(async (req, res) => {
  const bot = await ownBot(req);
  await assertLimit(bot.tenantId, 'scheduledTasks', await Task.countDocuments({ tenantId: bot.tenantId, enabled: true, createdBy: 'user' }));
  const next = check(req.body);
  const t = await Task.create({ ...req.body, tenantId: bot.tenantId, botId: bot._id });
  await syncTask(t); audit(req, 'task.create', { kind: 'task', id: t.id });
  res.status(201).json({ task: t, nextRun: next });
}));
router.put('/:id', validate(schema.partial()), asyncH(async (req, res) => {
  const bot = await ownBot(req);
  const t = await Task.findOne({ _id: req.params.id, botId: bot._id }); if (!t) throw notFound();
  Object.assign(t, req.body); check(t.toObject()); await t.save(); await syncTask(t); res.json(t);
}));
router.post('/:id/run', asyncH(async (req, res) => {
  const bot = await ownBot(req); const t = await Task.findOne({ _id: req.params.id, botId: bot._id }); if (!t) throw notFound();
  await Q.tasks.add('run', { taskId: String(t._id), manual: true }); res.json({ ok: true });
}));
router.delete('/:id', asyncH(async (req, res) => {
  const bot = await ownBot(req); const t = await Task.findOneAndDelete({ _id: req.params.id, botId: bot._id }); if (!t) throw notFound();
  t.enabled = false; await syncTask(t); audit(req, 'task.delete', { kind: 'task', id: req.params.id }); res.json({ ok: true });
}));
