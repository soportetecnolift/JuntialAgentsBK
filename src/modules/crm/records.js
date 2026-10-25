import { CrmRecord, CrmActivity, daysFromNow } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { notFound, planLimit } from '../../lib/errors.js';
import { getFields, coerce } from './fields.js';
import { getTenantPlan, limitOf } from '../plans/limits.js';

export const MAX_DEPTH = 3; // protección anti-bucles: un cambio hecho por una regla/función puede disparar como mucho 3 niveles
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const plain = (d) => JSON.parse(JSON.stringify(d || {}));

/**
 * Crea o actualiza un registro de forma atómica y publica el evento para las reglas de flujo.
 * by: 'agent' | 'user' | 'api' | 'workflow' | 'function'
 */
export async function saveRecord({ tenantId, id, data, by = 'user', agentId, channels, depth = 0, triggerWorkflows = true, module = 'contacts' }) {
  const fields = await getFields(tenantId, module);
  const clean = coerce(fields, data);
  let before = null; let rec;
  if (id) {
    const $set = Object.fromEntries(Object.entries(clean).map(([k, v]) => [`data.${k}`, v]));
    if (channels?.telegram) $set['channels.telegram'] = channels.telegram;
    if (channels?.web) $set['channels.web'] = channels.web;
    before = await CrmRecord.findOneAndUpdate({ _id: id, tenantId }, { $set, ...(agentId ? { $addToSet: { agentIds: agentId } } : {}) }, { new: false }).lean();
    if (!before) throw notFound('Contacto');
    rec = await CrmRecord.findById(id).lean();
  } else {
    const { plan } = await getTenantPlan(tenantId); const max = limitOf(plan, 'contacts');
    if (max >= 0 && (await CrmRecord.countDocuments({ tenantId })) >= max) throw planLimit(`Tu plan permite ${max} contactos`);
    rec = (await CrmRecord.create({ tenantId, module, data: clean, channels, agentIds: agentId ? [agentId] : [], createdBy: by })).toObject();
  }
  const old = plain(before?.data); const now = plain(rec.data);
  const changes = {};
  for (const k of new Set([...Object.keys(old), ...Object.keys(now)])) if (!same(old[k], now[k])) changes[k] = { old: old[k] ?? null, new: now[k] ?? null };
  if (before && !Object.keys(changes).length) return { record: rec, changes, created: false };
  CrmActivity.create({ recordId: rec._id, tenantId, type: before ? 'updated' : 'created', by, agentId, changes, expiresAt: daysFromNow(365) }).catch(() => {});
  if (triggerWorkflows && depth < MAX_DEPTH) {
    await Q.workflows.add('event', { tenantId: String(tenantId), recordId: String(rec._id), event: before ? 'edit' : 'create', changes, old, by, agentId: agentId ? String(agentId) : null, depth }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: { count: 2000 } });
  }
  return { record: rec, changes, created: !before };
}

export async function deleteRecord({ tenantId, id, by = 'user' }) {
  const rec = await CrmRecord.findOneAndDelete({ _id: id, tenantId }).lean(); if (!rec) throw notFound('Contacto');
  CrmActivity.create({ recordId: rec._id, tenantId, type: 'deleted', by, expiresAt: daysFromNow(365) }).catch(() => {});
  await Q.workflows.add('event', { tenantId: String(tenantId), recordId: String(rec._id), event: 'delete', snapshot: plain(rec.data), changes: {}, old: plain(rec.data), by, depth: 0 }, { attempts: 3 });
  return rec;
}

/** Ficha del contacto de un canal (usuario de Telegram o conversación web); se crea al primer dato. */
export async function recordForChannel({ tenantId, telegram, web }) {
  if (telegram?.userId) return CrmRecord.findOne({ tenantId, 'channels.telegram.userId': telegram.userId }).lean();
  if (web?.recordId) return CrmRecord.findOne({ _id: web.recordId, tenantId }).lean();
  return null;
}
