import { Workflow, WorkflowRun, CrmRecord, CrmActivity, CrmFunction, Bot, Tenant, daysFromNow } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { redis } from '../../lib/redis.js';
import { decrypt, hmac } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { notify } from '../notifications/service.js';
import { render } from '../webhooks/dispatcher.js';
import { evaluate } from './conditions.js';
import { saveRecord } from './records.js';
import { runFunction } from './sandbox.js';
import { safeUrl } from './net.js';

/* Caché de reglas activas por cliente con versión (al guardar una regla se invalida en todos los workers) */
const cache = new Map();
export const invalidateRules = (tenantId) => redis.incr(`wf:ver:${tenantId}`);
async function activeRules(tenantId) {
  const ver = (await redis.get(`wf:ver:${tenantId}`)) || '0'; const hit = cache.get(String(tenantId));
  if (hit && hit.ver === ver && Date.now() - hit.at < 30000) return hit.rules;
  const rules = await Workflow.find({ tenantId, enabled: true }).sort({ order: 1, createdAt: 1 }).lean();
  cache.set(String(tenantId), { rules, ver, at: Date.now() }); return rules;
}

/** Alcance: reglas globales (todos los agentes) o individuales/de grupo (solo ciertos agentes). */
export function inScope(rule, agentId, record) {
  if (rule.scope?.type !== 'agents') return true;
  const ids = (rule.scope.agentIds || []).map(String);
  return (agentId && ids.includes(String(agentId))) || (record?.agentIds || []).some((a) => ids.includes(String(a)));
}
export function triggerMatches(rule, event, changes = {}) {
  const t = rule.trigger || {};
  switch (t.event) {
    case 'create': return event === 'create';
    case 'edit': return event === 'edit';
    case 'create_or_edit': return event === 'create' || event === 'edit';
    case 'field_update': return event === 'edit' && (t.fields?.length ? t.fields.some((f) => f in changes) : Object.keys(changes).length > 0);
    case 'delete': return event === 'delete';
    default: return false;
  }
}
const fmt = (v) => (v instanceof Date ? v.toISOString() : v);
function templateCtx(rule, rec, ctx) {
  const data = Object.fromEntries(Object.entries(rec.data || {}).map(([k, v]) => [k, fmt(v)]));
  return { record: { id: String(rec._id), ...data, url: `${env.WEB_URL}/crm/contacts?id=${rec._id}` }, old: ctx.old || {}, changes: ctx.changes || {}, rule: { id: String(rule._id), name: rule.name }, event: ctx.event, now: new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }) };
}

async function runAction(rule, action, rec, ctx) {
  const c = action.config || {}; const T = templateCtx(rule, rec, ctx); const r = (s) => render(s || '', T);
  switch (action.type) {
    case 'email': {
      const to = r(c.to).split(',').map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x));
      if (!to.length) throw new Error('Sin destinatario válido');
      for (const t of to.slice(0, 10)) await Q.email.add('send', { to: t, subject: r(c.subject).slice(0, 200), title: r(c.subject).slice(0, 200), body: r(c.body).slice(0, 20000).replace(/\n/g, '<br>') }, { attempts: 4, backoff: { type: 'exponential', delay: 5000 } });
      return `${to.length} email(s)`;
    }
    case 'telegram': {
      const bot = await Bot.findOne({ _id: c.botId, tenantId: rule.tenantId, kind: { $ne: 'web' } }).lean(); if (!bot) throw new Error('Bot de Telegram no válido');
      const chatId = c.target === 'record' ? rec.channels?.telegram?.chatId : Number(c.chatId);
      if (!chatId) throw new Error(c.target === 'record' ? 'El contacto no tiene chat de Telegram' : 'Falta el chat de destino');
      const buttons = String(c.buttons || '').split('\n').map((x) => r(x).trim()).filter(Boolean);
      await Q.inbound.add('api-send', { botId: String(bot._id), chatIds: [chatId], mode: c.mode === 'agent' ? 'agent' : 'message', text: r(c.text).slice(0, 4000), buttons }, { attempts: 3 });
      return `mensaje a ${chatId}`;
    }
    case 'webhook': {
      await safeUrl(r(c.url));
      const body = c.body ? r(c.body) : JSON.stringify({ event: `crm.${ctx.event}`, rule: { id: String(rule._id), name: rule.name }, record: T.record, changes: ctx.changes, at: new Date().toISOString() });
      await Q.webhooks.add('wf-hook', { ruleId: String(rule._id), url: r(c.url), method: c.method || 'POST', headers: c.headers || {}, body }, { attempts: 6, backoff: { type: 'exponential', delay: 10000 } });
      return 'en cola';
    }
    case 'field_update': {
      const value = typeof c.value === 'string' ? r(c.value) : c.value;
      await saveRecord({ tenantId: rule.tenantId, id: rec._id, data: { [c.field]: value }, by: 'workflow', depth: (ctx.depth || 0) + 1, triggerWorkflows: !!c.retrigger });
      return `${c.field} = ${String(value).slice(0, 40)}`;
    }
    case 'notify': {
      const t = await Tenant.findById(rule.tenantId).lean();
      await notify(t.ownerId, 'crm.workflow', { title: r(c.title || `Regla: ${rule.name}`).slice(0, 140), body: r(c.body).slice(0, 500), recordId: String(rec._id) });
      return 'aviso enviado';
    }
    case 'function': {
      const fn = await CrmFunction.findOne({ _id: c.functionId, tenantId: rule.tenantId }).select('+envEnc').lean(); if (!fn) throw new Error('Función no encontrada');
      const out = await runFunction({ fn, tenantId: rule.tenantId, depth: ctx.depth || 0, ruleId: rule._id, recordId: rec._id, trigger: 'workflow',
        input: { record: T.record, ctx: { event: ctx.event, changes: ctx.changes, old: ctx.old, rule: T.rule, agentId: ctx.agentId, by: ctx.by } } });
      if (out.status === 'error') throw new Error(out.error);
      return `función OK (${out.ms} ms)`;
    }
    case 'agent_task': {
      const w = await Bot.findOne({ _id: c.agentId, tenantId: rule.tenantId, kind: 'worker' }).lean(); if (!w) throw new Error('Empleado digital no encontrado');
      const instruction = `${r(c.instruction)}\n\nContacto que provoca la tarea (id ${rec._id}): ${JSON.stringify(T.record).slice(0, 3000)}${Object.keys(ctx.changes || {}).length ? `\nCambios: ${JSON.stringify(ctx.changes).slice(0, 1500)}` : ''}`;
      await Q.workers.add('event', { botId: String(w._id), recordId: String(rec._id), instruction, label: `Regla «${rule.name}»` }, { attempts: 2, backoff: { type: 'exponential', delay: 30000 } });
      return `encargado a ${w.worker?.title || w.name}`;
    }
    default: throw new Error(`Acción desconocida ${action.type}`);
  }
}

async function executeRule(rule, rec, ctx) {
  const results = [];
  for (const a of rule.actions || []) {
    if (a.delayMinutes > 0) {
      await Q.workflows.add('delayed', { ruleId: String(rule._id), recordId: String(rec._id), actionId: String(a._id), ctx: { event: ctx.event, changes: ctx.changes, old: ctx.old, by: ctx.by, agentId: ctx.agentId, depth: ctx.depth } }, { delay: a.delayMinutes * 60000, attempts: 3 });
      results.push({ type: a.type, status: 'scheduled', error: `en ${a.delayMinutes} min` }); continue;
    }
    const t0 = Date.now();
    try { const info = await runAction(rule, a, rec, ctx); results.push({ type: a.type, status: 'ok', error: info, ms: Date.now() - t0 }); }
    catch (e) { results.push({ type: a.type, status: 'error', error: e.message.slice(0, 300), ms: Date.now() - t0 }); }
  }
  const errs = results.filter((x) => x.status === 'error').length;
  const status = !errs ? (results.every((x) => x.status === 'scheduled') ? 'scheduled' : 'ok') : errs === results.length ? 'error' : 'partial';
  await WorkflowRun.create({ tenantId: rule.tenantId, ruleId: rule._id, recordId: rec._id, event: ctx.event, by: ctx.by, status, actions: results, expiresAt: daysFromNow(30) });
  await Workflow.updateOne({ _id: rule._id }, { $inc: { 'stats.runs': 1, 'stats.errors': errs ? 1 : 0 }, 'stats.lastRunAt': new Date() });
  if (ctx.event !== 'delete') CrmActivity.create({ recordId: rec._id, tenantId: rule.tenantId, type: 'workflow', by: 'workflow', text: `Regla «${rule.name}»: ${results.map((x) => `${x.type} ${x.status === 'ok' ? '✓' : x.status === 'scheduled' ? '⏱' : '✗'}`).join(', ')}`, expiresAt: daysFromNow(365) }).catch(() => {});
  return { status, results };
}

async function handleEvent(d) {
  const rec = d.event === 'delete' ? { _id: d.recordId, data: d.snapshot || {}, agentIds: [] } : await CrmRecord.findById(d.recordId).lean();
  if (!rec) return { skipped: 'sin registro' };
  const rules = await activeRules(d.tenantId); let fired = 0;
  for (const rule of rules) {
    if (!triggerMatches(rule, d.event, d.changes) || !inScope(rule, d.agentId, rec)) continue;
    if (!evaluate(rule.conditions, rec.data, d.changes)) continue;
    // Sin "repetir": en ediciones solo se ejecuta cuando el registro PASA a cumplir las condiciones (como en Zoho)
    if (d.event === 'edit' && !rule.trigger.repeat && (rule.conditions?.rules || []).some((x) => !['changed', 'changed_to'].includes(x.op)) && evaluate({ ...rule.conditions, rules: rule.conditions.rules.filter((x) => !['changed', 'changed_to'].includes(x.op)) }, d.old, {})) continue;
    await executeRule(rule, rec, d); fired++;
  }
  return { fired };
}

async function runDelayed({ ruleId, recordId, actionId, ctx }) {
  const rule = await Workflow.findById(ruleId).lean(); if (!rule?.enabled) return;
  const rec = await CrmRecord.findById(recordId).lean(); if (!rec) return;
  if (!evaluate(rule.conditions, rec.data, {})) return { skipped: 'ya no cumple las condiciones' };
  const action = rule.actions.find((a) => String(a._id) === actionId); if (!action) return;
  const t0 = Date.now(); let res;
  try { res = { type: action.type, status: 'ok', error: await runAction(rule, action, rec, ctx), ms: Date.now() - t0 }; }
  catch (e) { res = { type: action.type, status: 'error', error: e.message.slice(0, 300), ms: Date.now() - t0 }; }
  await WorkflowRun.create({ tenantId: rule.tenantId, ruleId, recordId, event: `${ctx.event} (programada)`, by: 'workflow', status: res.status, actions: [res], expiresAt: daysFromNow(30) });
}

/** Reglas por fecha (p. ej. "1 día antes de Fecha de visita"): revisión cada 10 minutos, sin duplicados. */
async function dateScan() {
  const rules = await Workflow.find({ enabled: true, 'trigger.event': 'date' }).lean(); let n = 0;
  for (const rule of rules) {
    const f = rule.trigger.dateField; if (!f || !/^[a-z_][a-z0-9_]*$/i.test(f)) continue;
    const target = Date.now() - (rule.trigger.offsetMinutes || 0) * 60000;
    const recs = await CrmRecord.find({ tenantId: rule.tenantId, [`data.${f}`]: { $gt: new Date(target - 10 * 60000), $lte: new Date(target) } }).limit(500).lean();
    for (const rec of recs) {
      if (!inScope(rule, null, rec) || !evaluate(rule.conditions, rec.data, {})) continue;
      if (!(await redis.set(`wf:date:${rule._id}:${rec._id}:${+new Date(rec.data[f])}`, 1, 'EX', 40 * 86400, 'NX'))) continue;
      await executeRule(rule, rec, { event: 'date', changes: {}, old: {}, by: 'schedule', depth: 0 }); n++;
    }
  }
  return { fired: n };
}

export async function processWorkflowJob(job) {
  if (job.name === 'event') return handleEvent(job.data);
  if (job.name === 'delayed') return runDelayed(job.data);
  if (job.name === 'date-scan') return dateScan();
  return null;
}

/** Entrega de webhooks de reglas, firmada con el secreto de la regla. */
export async function deliverWorkflowHook(job) {
  const { ruleId, url, method, headers, body } = job.data;
  const rule = await Workflow.findById(ruleId).select('+webhookSecretEnc').lean(); if (!rule) return;
  await safeUrl(url);
  const t = Math.floor(Date.now() / 1000); const sig = hmac(decrypt(rule.webhookSecretEnc) || 'none', `${t}.${body}`);
  const r = await fetch(url, { method, body, headers: { 'content-type': 'application/json', 'user-agent': 'JuntialAgents-Workflows/1.0', 'x-juntialagents-signature': `t=${t},v1=${sig}`, ...headers }, signal: AbortSignal.timeout(15000), redirect: 'manual' });
  if (!r.ok) { logger.warn({ ruleId, status: r.status }, 'Webhook de regla fallido'); throw new Error(`HTTP ${r.status}`); }
}

/** Prueba en seco desde el panel: ¿se dispararía la regla con este contacto? */
export async function dryRun(rule, rec) {
  const conds = (rule.conditions?.rules || []).map((c) => ({ ...c, ok: evaluate({ match: 'all', rules: [c] }, rec.data, {}) }));
  return { matches: evaluate(rule.conditions, rec.data, {}), conditions: conds, actions: (rule.actions || []).map((a) => ({ type: a.type, delayMinutes: a.delayMinutes })) };
}
export { executeRule };
