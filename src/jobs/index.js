import { Task, Webhook, Session, Bot, Tenant, daysFromNow } from '../models/index.js';
import { deliverToChats } from '../telegram/sender.js';
import { emitEvent, render } from '../modules/webhooks/dispatcher.js';
import { notify } from '../modules/notifications/service.js';
import { sendMail, layout } from '../lib/mailer.js';
import { consumeMessage } from '../modules/plans/limits.js';
import { botLog } from '../lib/audit.js';
import { checkAllBotModels } from '../ai/modelWatch.js';

export async function runTaskJob(job) {
  const task = await Task.findById(job.data.taskId);
  if (!task || (!task.enabled && !job.data.manual)) return;
  const bot = await Bot.findById(task.botId).lean();
  if (!bot || bot.status !== 'active') return;
  try {
    if (task.action === 'agent') { const q = await consumeMessage(bot.tenantId); if (!q.allowed) throw new Error('Cuota de mensajes agotada'); }
    await deliverToChats(task.botId, task.chatIds, { mode: task.action, text: task.prompt });
    Object.assign(task, { lastRunAt: new Date(), lastStatus: 'ok', lastError: null, runs: task.runs + 1 });
    if (task.type === 'once') task.enabled = false;
    await task.save();
    emitEvent(bot, 'task.completed', { taskId: task.id, name: task.name });
    botLog(bot._id, 'info', 'task.ok', `Tarea "${task.name}" ejecutada`);
  } catch (err) {
    Object.assign(task, { lastRunAt: new Date(), lastStatus: 'error', lastError: err.message }); await task.save();
    emitEvent(bot, 'task.failed', { taskId: task.id, name: task.name, error: err.message });
    botLog(bot._id, 'error', 'task.failed', `Tarea "${task.name}": ${err.message}`);
    if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
      const t = await Tenant.findById(bot.tenantId).lean();
      notify(t.ownerId, 'task.failed', { name: task.name, error: err.message, botId: String(bot._id) }).catch(() => {});
    }
    throw err;
  }
}

export async function inboundJob(job) {
  if (job.name === 'api-send') {
    const { botId, chatIds, text, mode, buttons } = job.data;
    const r = await deliverToChats(botId, chatIds, { mode: mode === 'agent' ? 'agent' : 'message', text, buttons });
    botLog(botId, 'info', 'api.send', `Envío por API a ${chatIds.length} chat(s)`);
    return { delivered: chatIds.length, messageIds: r };
  }
  const wh = await Webhook.findById(job.data.webhookId).lean(); if (!wh?.enabled) return;
  const bot = await Bot.findById(wh.botId).lean(); if (bot?.status !== 'active') return;
  const text = render(wh.template, job.data.payload);
  if (wh.action === 'run_agent') { const q = await consumeMessage(bot.tenantId); if (!q.allowed) throw new Error('Cuota agotada'); }
  await deliverToChats(wh.botId, wh.chatIds, { mode: wh.action === 'run_agent' ? 'agent' : 'message', text });
  emitEvent(bot, 'webhook.inbound.processed', { webhookId: String(wh._id), name: wh.name });
  botLog(bot._id, 'info', 'webhook.in', `Webhook entrante "${wh.name}" procesado`);
}

export async function emailJob(job) {
  const { to, subject, title, body, link, html, text } = job.data;
  if (html) return sendMail({ to, subject, html, text: text || html.replace(/<[^>]+>/g, ' ') }); // email ya maquetado (p. ej. aprobaciones con botones)
  await sendMail({ to, subject, html: layout(title, `<p>${body}</p>`, link ? { url: link, label: 'Abrir JuntialAgents' } : null), text: body.replace(/<[^>]+>/g, '') });
}

export async function maintenanceJob(job) {
  if (job.name === 'model-check') return checkAllBotModels();
  if (job.name === 'session-expiry') {
    const from = daysFromNow(2); const to = daysFromNow(3);
    const sessions = await Session.find({ revokedAt: null, expiresAt: { $gte: from, $lt: to } }).select('userId expiresAt').lean();
    const seen = new Set();
    for (const s of sessions) {
      if (seen.has(String(s.userId))) continue; seen.add(String(s.userId));
      await notify(s.userId, 'auth.session_expiring', { date: s.expiresAt.toLocaleDateString('es-ES') });
    }
  }
}
