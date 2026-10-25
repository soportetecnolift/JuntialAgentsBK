import { CenterEvent, CenterSubscription, daysFromNow } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { logger } from '../../config/logger.js';
import { decrypt, hmac } from '../../lib/crypto.js';
import { safeUrl } from '../crm/net.js';

/**
 * Bus de eventos de la organización: cualquier app de Juntial publica lo que pasa (approval.decided,
 * crm.record.updated, worker.run.completed…) y otras apps o sistemas externos se suscriben.
 * Es la base de las conexiones entre herramientas de Juntial.
 */
const handlers = new Map(); // tipo (o prefijo.*) → [fn(event)]
export function subscribe(pattern, fn) { const l = handlers.get(pattern) || []; l.push(fn); handlers.set(pattern, l); }
const matches = (pattern, type) => pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));

export async function publish(orgId, type, data = {}, { app = 'center', actor } = {}) {
  if (!orgId) return null;
  try {
    const ev = await CenterEvent.create({ orgId, app, type, actor, data: JSON.parse(JSON.stringify(data)), expiresAt: daysFromNow(30) });
    for (const [p, fns] of handlers) if (matches(p, type)) for (const fn of fns) Promise.resolve(fn(ev)).catch((e) => logger.warn({ err: e.message, type }, 'Suscriptor interno falló'));
    const subs = await CenterSubscription.find({ orgId, enabled: true }).lean();
    for (const s of subs) if ((s.events || []).some((p) => matches(p, type))) await Q.webhooks.add('center-hook', { subId: String(s._id), eventId: String(ev._id) }, { attempts: 6, backoff: { type: 'exponential', delay: 10000 } });
    return ev;
  } catch (e) { logger.warn({ err: e.message, type }, 'No se pudo publicar el evento'); return null; }
}
export async function deliverCenterHook(job) {
  const s = await CenterSubscription.findById(job.data.subId).select('+secretEnc').lean(); const ev = await CenterEvent.findById(job.data.eventId).lean();
  if (!s?.enabled || !ev) return;
  await safeUrl(s.url);
  const body = JSON.stringify({ id: String(ev._id), type: ev.type, app: ev.app, orgId: String(ev.orgId), actor: ev.actor, data: ev.data, createdAt: ev.createdAt });
  const t = Math.floor(Date.now() / 1000);
  const r = await fetch(s.url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'user-agent': 'JuntialCenter/1.0', 'x-juntial-event': ev.type, 'x-juntial-signature': `t=${t},v1=${hmac(decrypt(s.secretEnc) || 'none', `${t}.${body}`)}` } });
  await CenterSubscription.updateOne({ _id: s._id }, r.ok ? { failures: 0, lastDeliveryAt: new Date() } : { $inc: { failures: 1 } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
