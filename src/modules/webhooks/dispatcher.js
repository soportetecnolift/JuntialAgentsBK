import crypto from 'node:crypto';
import { Webhook, WebhookDelivery, daysFromNow, Tenant, PlatformWebhook, User } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { redis } from '../../lib/redis.js';
import { decrypt, hmac } from '../../lib/crypto.js';
import { notify } from '../notifications/service.js';

export const EVENTS = ['message.replied', 'conversation.started', 'lead.captured', 'handoff.requested', 'bot.error', 'bot.membership', 'task.completed', 'task.failed', 'webhook.inbound.processed'];

/** Publica un evento hacia los webhooks salientes suscritos (fan-out en cola, nunca bloquea al bot). */
export async function emitEvent(bot, event, data) {
  try {
    const ck = `wh:out:${bot._id}`;
    let subs = await redis.get(ck);
    if (!subs) { subs = JSON.stringify(await Webhook.find({ botId: bot._id, direction: 'outbound', enabled: true }).select('_id events').lean()); await redis.set(ck, subs, 'EX', 30); }
    for (const w of JSON.parse(subs)) {
      if (!w.events.includes(event) && !w.events.includes('*')) continue;
      const deliveryId = crypto.randomUUID();
      await Q.webhooks.add('deliver', { webhookId: w._id, event, deliveryId, payload: { id: deliveryId, event, createdAt: new Date().toISOString(), botId: String(bot._id), data } },
        { attempts: 8, backoff: { type: 'exponential', delay: 10000 }, jobId: deliveryId });
    }
  } catch { /* nunca romper el flujo del bot por un webhook */ }
}
export const invalidateWebhookCache = (botId) => redis.del(`wh:out:${botId}`);

/** Worker: entrega firmada estilo Stripe: X-JuntialAgents-Signature: t=<ts>,v1=<hmac(ts.body)> */
export async function deliverWebhook(job) {
  const { webhookId, event, payload, platform } = job.data;
  const Model = platform ? PlatformWebhook : Webhook;
  const wh = await Model.findById(webhookId).select('+secretEnc');
  if (!wh?.enabled) return;
  const body = JSON.stringify(payload); const t = Math.floor(Date.now() / 1000);
  const sig = hmac(decrypt(wh.secretEnc), `${t}.${body}`);
  const start = Date.now(); let status = 0; let error;
  try {
    const r = await fetch(wh.url, { method: 'POST', body, signal: AbortSignal.timeout(15000), headers: {
      'content-type': 'application/json', 'user-agent': 'JuntialAgents-Webhooks/1.0', 'x-juntialagents-event': event,
      'x-juntialagents-delivery': payload.id, 'x-juntialagents-signature': `t=${t},v1=${sig}`, ...(platform ? { 'x-juntialagents-scope': 'platform' } : {}),
    } });
    status = r.status; if (!r.ok) error = `HTTP ${r.status}`;
  } catch (e) { error = e.message; }
  await WebhookDelivery.create({ webhookId, event, status, ok: !error, attempt: job.attemptsMade + 1, durationMs: Date.now() - start, error, expiresAt: daysFromNow(30) });
  if (!error) { await Model.updateOne({ _id: webhookId }, { consecutiveFailures: 0, lastDeliveryAt: new Date() }); return; }
  if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
    const updated = await Model.findByIdAndUpdate(webhookId, { $inc: { consecutiveFailures: 1 } }, { new: true });
    if (updated.consecutiveFailures >= 20) {
      updated.enabled = false; await updated.save();
      if (platform) { await redis.del('pwh:subs'); notify(updated.createdBy, 'webhook.disabled', { name: updated.name }).catch(() => {}); }
      else {
        await invalidateWebhookCache(updated.botId);
        const tenant = await Tenant.findById(updated.tenantId).lean();
        notify(tenant.ownerId, 'webhook.disabled', { name: updated.name }).catch(() => {});
      }
    }
  }
  throw new Error(error); // => reintento con backoff
}

/** Plantillas {{payload.ruta}} para webhooks entrantes */
export function render(tpl, data) {
  return String(tpl || '').replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
