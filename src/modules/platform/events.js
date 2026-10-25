import crypto from 'node:crypto';
import { PlatformWebhook } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { redis } from '../../lib/redis.js';

/** Eventos de plataforma para desarrollos a medida de los administradores (CRM, facturación, BI…). */
export const PLATFORM_EVENTS = ['user.created', 'tenant.created', 'tenant.status_changed', 'plan.changed', 'plan.requested', 'bot.created', 'bot.deleted', 'bot.connected', 'ticket.created', 'ticket.replied', 'usage.limit_reached'];

export async function emitPlatformEvent(event, data) {
  try {
    let subs = await redis.get('pwh:subs');
    if (!subs) { subs = JSON.stringify(await PlatformWebhook.find({ enabled: true }).select('_id events').lean()); await redis.set('pwh:subs', subs, 'EX', 30); }
    for (const w of JSON.parse(subs)) {
      if (!w.events.includes(event) && !w.events.includes('*')) continue;
      const id = crypto.randomUUID();
      await Q.webhooks.add('deliver', { platform: true, webhookId: w._id, event, deliveryId: id, payload: { id, event, createdAt: new Date().toISOString(), data } }, { attempts: 8, backoff: { type: 'exponential', delay: 10000 }, jobId: id });
    }
  } catch { /* no bloquear el flujo */ }
}
export const invalidatePlatformSubs = () => redis.del('pwh:subs');
