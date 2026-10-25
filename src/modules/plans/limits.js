import { Tenant, Plan, Usage, Bot, McpServer, Task, Webhook, ApiKey, Workflow, CrmFunction, CrmRecord } from '../../models/index.js';
import { redis } from '../../lib/redis.js';
import { planLimit } from '../../lib/errors.js';
import { notify } from '../notifications/service.js';
import { emitPlatformEvent } from '../platform/events.js';

/* ───────── Catálogo único de límites (‑1 = ilimitado) ─────────
 * Fuente de verdad para el seed, la migración de planes antiguos, el panel y los mensajes de error.
 * Si se añade un límite nuevo, basta con añadirlo aquí: los planes existentes lo reciben al arrancar.
 */
export const LIMITS = {
  bots: { label: 'agentes', group: 'Agentes' },
  messagesPerMonth: { label: 'mensajes al mes', group: 'Agentes', monthly: true },
  mcpServers: { label: 'conectores MCP', group: 'Agentes' },
  scheduledTasks: { label: 'tareas programadas', group: 'Agentes' },
  webhooks: { label: 'webhooks', group: 'Integraciones' },
  apiKeys: { label: 'API keys', group: 'Integraciones' },
  apiRequestsPerMinute: { label: 'peticiones API por minuto', group: 'Integraciones', rate: true },
  contacts: { label: 'contactos', group: 'CRM' },
  workflows: { label: 'reglas de flujo', group: 'CRM' },
  functions: { label: 'funciones', group: 'CRM' },
  historyDays: { label: 'días de historial', group: 'Datos', retention: true },
};
export const DEFAULT_LIMITS = {
  free:       { bots: 1, messagesPerMonth: 300, mcpServers: 1, scheduledTasks: 2, webhooks: 2, apiKeys: 1, apiRequestsPerMinute: 30, contacts: 500, workflows: 3, functions: 1, historyDays: 7 },
  pro:        { bots: 5, messagesPerMonth: 10000, mcpServers: 5, scheduledTasks: 20, webhooks: 20, apiKeys: 5, apiRequestsPerMinute: 120, contacts: 20000, workflows: 30, functions: 15, historyDays: 30 },
  business:   { bots: 25, messagesPerMonth: 100000, mcpServers: 25, scheduledTasks: 200, webhooks: 100, apiKeys: 20, apiRequestsPerMinute: 600, contacts: 250000, workflows: 300, functions: 100, historyDays: 90 },
  enterprise: { bots: -1, messagesPerMonth: -1, mcpServers: -1, scheduledTasks: -1, webhooks: -1, apiKeys: -1, apiRequestsPerMinute: 3000, contacts: -1, workflows: -1, functions: -1, historyDays: 365 },
};
DEFAULT_LIMITS._fallback = DEFAULT_LIMITS.pro; // planes personalizados sin un límite definido: valores sensatos, nunca 0
/** Límite efectivo: el del plan y, si no existe (plan antiguo), el valor por defecto de su nivel. */
export function limitOf(plan, key) {
  const v = plan?.limits?.[key];
  if (v != null && v !== '') return Number(v);
  return (DEFAULT_LIMITS[plan?.slug] || DEFAULT_LIMITS._fallback)[key] ?? -1;
}
/** Migración idempotente al arrancar: añade a los planes existentes los límites que les falten. */
export async function backfillPlanLimits() {
  const plans = await Plan.find().lean(); let fixed = 0;
  for (const p of plans) {
    const missing = Object.keys(LIMITS).filter((k) => p.limits?.[k] == null);
    if (!missing.length) continue;
    const base = DEFAULT_LIMITS[p.slug] || DEFAULT_LIMITS._fallback;
    await Plan.updateOne({ _id: p._id }, { $set: Object.fromEntries(missing.map((k) => [`limits.${k}`, base[k]])) }); fixed++;
  }
  if (fixed) { const keys = await redis.keys('plan:tenant:*'); if (keys.length) await redis.del(...keys); }
  return fixed;
}

export const period = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export async function getTenantPlan(tenantId) {
  const key = `plan:tenant:${tenantId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const t = await Tenant.findById(tenantId).lean();
  const plan = t?.subscription?.planId ? await Plan.findById(t.subscription.planId).lean() : await Plan.findOne({ slug: 'free' }).lean();
  const out = { tenant: { id: String(t?._id), status: t?.status, ownerId: String(t?.ownerId), subStatus: t?.subscription?.status }, plan };
  await redis.set(key, JSON.stringify(out), 'EX', 60);
  return out;
}
export const invalidatePlanCache = (tenantId) => redis.del(`plan:tenant:${tenantId}`);

/** Lanza 402 si crear un recurso más supera el plan. */
export async function assertLimit(tenantId, key, currentCount) {
  const { plan } = await getTenantPlan(tenantId);
  const max = limitOf(plan, key);
  if (max >= 0 && currentCount >= max) {
    const err = planLimit(`Has alcanzado el límite de tu plan ${plan?.name || ''}: ${max} ${LIMITS[key]?.label || key}. Mejora tu plan para añadir más.`);
    err.details = { limit: key, max, used: currentCount, plan: plan?.slug }; throw err;
  }
}

/** Consumo actual de cada recurso frente a su límite (para el panel del cliente y del equipo). */
export async function usageSummary(tenantId) {
  const { plan } = await getTenantPlan(tenantId);
  const used = {
    bots: await Bot.countDocuments({ tenantId }),
    messagesPerMonth: await getUsage(tenantId),
    mcpServers: await McpServer.countDocuments({ tenantId }),
    scheduledTasks: await Task.countDocuments({ tenantId, enabled: true, createdBy: 'user' }),
    webhooks: await Webhook.countDocuments({ tenantId }),
    apiKeys: await ApiKey.countDocuments({ tenantId, revokedAt: null }),
    contacts: await CrmRecord.countDocuments({ tenantId }),
    workflows: await Workflow.countDocuments({ tenantId }),
    functions: await CrmFunction.countDocuments({ tenantId }),
  };
  return Object.entries(LIMITS).map(([key, m]) => {
    const limit = limitOf(plan, key); const u = used[key];
    return { key, label: m.label, group: m.group, limit, used: u ?? null, unlimited: limit < 0, kind: m.monthly ? 'monthly' : m.rate ? 'rate' : m.retention ? 'retention' : 'count', pct: u != null && limit > 0 ? Math.min(100, Math.round((u / limit) * 100)) : 0 };
  });
}

/** Cuenta un mensaje procesado por IA. Devuelve allowed=false si se agotó la cuota. */
export async function consumeMessage(tenantId, tokens = {}) {
  const { plan, tenant } = await getTenantPlan(tenantId);
  if (tenant.status === 'suspended') return { allowed: false, reason: 'suspended' };
  const limit = limitOf(plan, 'messagesPerMonth');
  const p = period(); const k = `usage:${tenantId}:${p}`;
  const used = await redis.incr(k); if (used === 1) await redis.expire(k, 40 * 86400);
  Usage.updateOne({ tenantId, period: p }, { $inc: { messages: 1, tokensIn: tokens.in || 0, tokensOut: tokens.out || 0 } }, { upsert: true }).catch(() => {});
  if (limit >= 0) {
    if (used === Math.ceil(limit * 0.8) && (await redis.set(`warn80:${tenantId}:${p}`, 1, 'EX', 40 * 86400, 'NX'))) notify(tenant.ownerId, 'plan.limit_warning', { used, limit }).catch(() => {});
    if (used > limit) {
      if (await redis.set(`warn100:${tenantId}:${p}`, 1, 'EX', 40 * 86400, 'NX')) { notify(tenant.ownerId, 'plan.limit_reached', { limit }).catch(() => {}); emitPlatformEvent('usage.limit_reached', { tenantId: String(tenantId), limit, period: p }); }
      return { allowed: false, reason: 'quota', used, limit };
    }
  }
  return { allowed: true, used, limit };
}
export const getUsage = async (tenantId) => Number((await redis.get(`usage:${tenantId}:${period()}`)) || 0);
