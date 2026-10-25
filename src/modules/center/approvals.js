import { ApprovalPolicy, Membership, Department, WorkerApproval, User } from '../../models/index.js';
import { acquireLock, releaseLock } from '../../lib/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sha256, randomToken } from '../../lib/crypto.js';
import { notify } from '../notifications/service.js';
import { Q } from '../../lib/queues.js';
import { layout } from '../../lib/mailer.js';
import { publish } from './events.js';
import { appRoleOf } from './access.js';

/**
 * Aprobaciones avanzadas de Juntial Center.
 * Una POLÍTICA decide qué aprobaciones le tocan (app, agente, área, tipo de acción, herramienta, importe) y define una
 * CADENA DE PASOS. Cada paso tiene sus aprobadores (personas, rol, área o responsable del área), un modo
 * (cualquiera / todos / mínimo N) y un plazo con acción al vencer (recordar, escalar, aprobar o rechazar).
 */
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const AMOUNT_KEYS = /^(total|amount|importe|monto|price|precio|valor|value|sub_?total|grand_?total|total_amount)$/i;
export function findAmount(obj, field) {
  if (field) { const v = String(field).split('.').reduce((a, k) => (a == null ? a : a[k]), obj); const n = Number(v); return Number.isFinite(n) ? n : null; }
  let best = null;
  const walk = (o, d = 0) => { if (!o || typeof o !== 'object' || d > 5) return; for (const [k, v] of Object.entries(o)) { if (AMOUNT_KEYS.test(k) && Number.isFinite(Number(v))) best = Math.max(best ?? -Infinity, Number(v)); else if (typeof v === 'object') walk(v, d + 1); } };
  walk(obj); return best;
}
const toolMatches = (pattern, tool) => { if (!pattern) return true; try { return new RegExp(pattern, 'i').test(tool); } catch { return tool.toLowerCase().includes(pattern.toLowerCase()); } };

/** Política aplicable (la de mayor prioridad = número más bajo). */
export async function matchPolicy(orgId, ctx) {
  const list = await ApprovalPolicy.find({ orgId, enabled: true }).sort({ priority: 1, createdAt: 1 }).lean();
  for (const p of list) {
    const m = p.match || {};
    if (m.app && m.app !== (ctx.app || 'juntialagents')) continue;
    if (m.agentIds?.length && !m.agentIds.map(String).includes(String(ctx.agentId))) continue;
    if (m.departmentIds?.length && !m.departmentIds.map(String).includes(String(ctx.departmentId))) continue;
    if (m.categories?.length && !m.categories.includes(ctx.category)) continue;
    if (!toolMatches(m.toolPattern, ctx.tool || '')) continue;
    if (m.minAmount != null && !(ctx.amount != null && ctx.amount >= m.minAmount)) continue;
    return p;
  }
  return null;
}

/** Personas concretas que aprueban un paso. */
export async function resolveApprovers(orgId, spec = {}, ctx = {}) {
  const base = { orgId, status: 'active' }; let list = [];
  if (spec.kind === 'members') list = await Membership.find({ ...base, _id: { $in: spec.memberIds || [] } }).lean();
  else if (spec.kind === 'role') {
    const all = await Membership.find(base).lean();
    list = all.filter((m) => (spec.orgRoles?.length && spec.orgRoles.includes(m.orgRole)) || (spec.appRoles?.length && spec.appRoles.includes(appRoleOf(m, ctx.app || 'juntialagents'))));
  } else if (spec.kind === 'department') list = await Membership.find({ ...base, departmentIds: { $in: spec.departmentIds?.length ? spec.departmentIds : ctx.departmentId ? [ctx.departmentId] : [] } }).lean();
  else if (spec.kind === 'department_head') {
    const ids = spec.departmentIds?.length ? spec.departmentIds : ctx.departmentId ? [ctx.departmentId] : [];
    const deps = await Department.find({ orgId, _id: { $in: ids } }).lean();
    list = await Membership.find({ ...base, _id: { $in: deps.map((d) => d.headId).filter(Boolean) } }).lean();
  }
  return list;
}
// Si un paso queda sin nadie que apruebe, decide el propietario: una aprobación nunca se queda huérfana
async function fallbackOwners(orgId) { return Membership.find({ orgId, status: 'active', orgRole: { $in: ['owner', 'admin'] } }).lean(); }

async function notifyStep(a, stepIdx, bot) {
  const st = a.steps[stepIdx]; const members = await Membership.find({ _id: { $in: st.approverIds } }).lean();
  const tokens = []; const who = bot?.worker?.title || bot?.name || 'Un agente';
  for (const m of members) {
    const raw = `apr_${randomToken(24)}`; tokens.push({ memberId: m._id, hash: sha256(raw) });
    const link = `${env.PUBLIC_API_URL}/a/${raw}`;
    if (m.userId) notify(m.userId, 'crm.workflow', { title: `🟡 Te toca aprobar: ${a.label.slice(0, 100)}`, body: `${who} · ${a.policyName} · paso ${stepIdx + 1}/${a.steps.length} «${st.name}»`, link: `${env.WEB_URL}/center/approvals` }).catch(() => {});
    if (env.SMTP_HOST && m.email) await Q.email.add('send', { to: m.email, subject: `🟡 Tu aprobación: ${a.label.slice(0, 90)}`, html: layout(`${esc(who)} necesita tu aprobación`, `<p style="font-size:16px;font-weight:700;margin:0 0 8px">${esc(a.label)}</p><p style="color:#5b6673;margin:0 0 6px">${esc(a.policyName)} · paso ${stepIdx + 1} de ${a.steps.length}: «${esc(st.name)}»${a.amount != null ? ` · importe ${a.amount.toLocaleString('es-ES')}` : ''}</p>${a.reason ? `<p><i>Motivo:</i> ${esc(a.reason.slice(0, 800))}</p>` : ''}<p><a href="${link}?d=approve&via=email" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#0E7C86;color:#fff;font-weight:700;text-decoration:none">✅ Aprobar</a> <a href="${link}?d=reject&via=email" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#B42318;color:#fff;font-weight:700;text-decoration:none">❌ Rechazar</a></p><p style="font-size:12px;color:#5b6673">Este enlace es personal: tu decisión quedará registrada a tu nombre.</p>`, null) }, { attempts: 3 }).catch(() => {});
  }
  await WorkerApproval.updateOne({ _id: a._id }, { $push: { approverTokens: { $each: tokens } } });
  return members;
}

/** Arranca la cadena de una aprobación según su política. */
export async function startPolicyApproval(a, policy, { bot, departmentId, amount }) {
  const steps = [];
  for (const [i, s] of policy.steps.entries()) {
    let approvers = await resolveApprovers(a.tenantId, s.approvers, { departmentId, app: 'juntialagents' });
    if (!approvers.length) approvers = await fallbackOwners(a.tenantId);
    steps.push({ name: s.name || `Paso ${i + 1}`, mode: s.mode || 'any', quorum: Math.max(1, s.quorum || 1), approverIds: approvers.map((m) => m._id), status: i === 0 ? 'pending' : 'waiting', startedAt: i === 0 ? new Date() : undefined, dueAt: i === 0 ? new Date(Date.now() + (s.timeoutHours || 24) * 3600000) : undefined, timeoutHours: s.timeoutHours || 24, onTimeout: s.onTimeout || 'remind', escalate: s.escalate, reminded: 0, decisions: [] });
  }
  await WorkerApproval.updateOne({ _id: a._id }, { policyId: policy._id, policyName: policy.name, departmentId, amount, steps, currentStep: 0 });
  const fresh = await WorkerApproval.findById(a._id).lean();
  const members = await notifyStep(fresh, 0, bot);
  publish(a.tenantId, 'approval.requested', { approvalId: String(a._id), label: a.label, policy: policy.name, step: steps[0].name, approvers: members.map((m) => m.email) }, { app: 'juntialagents' });
  return { steps, firstApprovers: members };
}

/** Identifica a quién decide (panel, enlace personal, Telegram o webhook) dentro de la organización. */
export async function resolveActor(orgId, actor = {}) {
  if (actor.memberId) return Membership.findOne({ _id: actor.memberId, orgId, status: 'active' }).lean();
  if (actor.userId) return Membership.findOne({ orgId, userId: actor.userId, status: 'active' }).lean();
  if (actor.telegramUsername) return Membership.findOne({ orgId, telegramUsername: String(actor.telegramUsername).replace(/^@/, '').toLowerCase(), status: 'active' }).lean();
  if (actor.email) return Membership.findOne({ orgId, email: String(actor.email).toLowerCase(), status: 'active' }).lean();
  return null;
}

/**
 * Decisión sobre el paso actual. Devuelve { final: 'approved' | 'rejected' | null, ... }.
 * null = registrada, pero faltan votos o hay más pasos (ya se ha avisado a los siguientes aprobadores).
 */
export async function decidePolicyStep(a, { approve, actor, via, feedback, bot }) {
  const lock = await acquireLock(`apr:${a._id}`, 10000); if (!lock) return { ok: false, error: 'Otra persona está decidiendo en este momento; inténtalo de nuevo' };
  try {
    const cur = await WorkerApproval.findById(a._id).lean();
    if (cur.status !== 'pending') return { ok: false, error: 'Ya decidida o caducada' };
    const m = await resolveActor(cur.tenantId, actor);
    if (!m) return { ok: false, error: via === 'telegram' ? 'No te reconozco: vincula tu usuario de Telegram a tu perfil en Juntial Center' : 'No perteneces a esta organización' };
    const st = cur.steps[cur.currentStep]; const isApprover = st.approverIds.map(String).includes(String(m._id)); const isOwner = m.orgRole === 'owner';
    if (!isApprover && !isOwner) return { ok: false, error: `Este paso («${st.name}») no te corresponde` };
    if (st.decisions.some((d) => String(d.memberId) === String(m._id))) return { ok: false, error: 'Ya votaste en este paso' };
    const decision = { memberId: m._id, name: m.name || m.email, email: m.email, decision: approve ? 'approve' : 'reject', via, comment: feedback, at: new Date() };
    const decisions = [...st.decisions, decision]; const by = `${m.name || m.email}${!isApprover && isOwner ? ' (propietario)' : ''}`;
    if (!approve) {
      await WorkerApproval.updateOne({ _id: cur._id }, { [`steps.${cur.currentStep}.decisions`]: decisions, [`steps.${cur.currentStep}.status`]: 'rejected' });
      return { ok: true, final: 'rejected', by, member: m };
    }
    const approvals = decisions.filter((d) => d.decision === 'approve').length;
    const need = isOwner && !isApprover ? 1 : st.mode === 'all' ? st.approverIds.length : st.mode === 'quorum' ? Math.min(st.quorum, st.approverIds.length) : 1;
    if (approvals < need) {
      await WorkerApproval.updateOne({ _id: cur._id }, { [`steps.${cur.currentStep}.decisions`]: decisions });
      return { ok: true, final: null, status: 'pending', info: `Voto registrado (${approvals}/${need} en «${st.name}»)`, by, member: m };
    }
    const next = cur.currentStep + 1;
    if (next < cur.steps.length) {
      await WorkerApproval.updateOne({ _id: cur._id }, { [`steps.${cur.currentStep}.decisions`]: decisions, [`steps.${cur.currentStep}.status`]: 'approved', currentStep: next, [`steps.${next}.status`]: 'pending', [`steps.${next}.startedAt`]: new Date(), [`steps.${next}.dueAt`]: new Date(Date.now() + (cur.steps[next].timeoutHours || 24) * 3600000) });
      const fresh = await WorkerApproval.findById(cur._id).lean(); const ms = await notifyStep(fresh, next, bot);
      publish(cur.tenantId, 'approval.step', { approvalId: String(cur._id), label: cur.label, step: cur.steps[next].name, approvers: ms.map((x) => x.email) }, { app: 'juntialagents', actor: m.email });
      return { ok: true, final: null, status: 'pending', info: `Paso «${st.name}» aprobado. Ahora decide: ${cur.steps[next].name}`, by, member: m };
    }
    await WorkerApproval.updateOne({ _id: cur._id }, { [`steps.${cur.currentStep}.decisions`]: decisions, [`steps.${cur.currentStep}.status`]: 'approved' });
    return { ok: true, final: 'approved', by, member: m };
  } finally { await releaseLock(`apr:${a._id}`, lock); }
}

/** Plazos vencidos: recordar, escalar o decidir automáticamente. Se ejecuta cada 15 minutos. */
export async function processApprovalTimeouts() {
  const now = new Date(); const list = await WorkerApproval.find({ status: 'pending', 'steps.0': { $exists: true } }).limit(500).lean(); let n = 0;
  for (const a of list) {
    const st = a.steps[a.currentStep]; if (!st?.dueAt || new Date(st.dueAt) > now) continue; n++;
    const { decideApproval } = await import('../worker/engine.js');
    const extend = { [`steps.${a.currentStep}.dueAt`]: new Date(Date.now() + (st.timeoutHours || 24) * 3600000), $inc: { [`steps.${a.currentStep}.reminded`]: 1 } };
    if (st.onTimeout === 'approve' || st.onTimeout === 'reject') {
      await WorkerApproval.updateOne({ _id: a._id }, { [`steps.${a.currentStep}.status`]: st.onTimeout === 'approve' ? 'approved' : 'rejected' });
      if (st.onTimeout === 'reject' || a.currentStep === a.steps.length - 1) await decideApproval(a._id, { approve: st.onTimeout === 'approve', by: 'Sistema (plazo vencido)', via: 'plazo', feedback: `Plazo de ${st.timeoutHours} h vencido en «${st.name}»`, system: true });
      else { await WorkerApproval.updateOne({ _id: a._id }, { currentStep: a.currentStep + 1, [`steps.${a.currentStep + 1}.status`]: 'pending', [`steps.${a.currentStep + 1}.startedAt`]: new Date(), [`steps.${a.currentStep + 1}.dueAt`]: new Date(Date.now() + (a.steps[a.currentStep + 1].timeoutHours || 24) * 3600000) }); await notifyStep(await WorkerApproval.findById(a._id).lean(), a.currentStep + 1); }
    } else if (st.onTimeout === 'escalate' && st.escalate?.kind) {
      const extra = await resolveApprovers(a.tenantId, st.escalate, { departmentId: a.departmentId });
      const ids = [...new Set([...st.approverIds.map(String), ...extra.map((m) => String(m._id))])];
      await WorkerApproval.updateOne({ _id: a._id }, { ...extend, [`steps.${a.currentStep}.approverIds`]: ids, [`steps.${a.currentStep}.escalated`]: true });
      await notifyStep({ ...a, steps: a.steps.map((s, i) => (i === a.currentStep ? { ...s, approverIds: extra.map((m) => m._id) } : s)) }, a.currentStep);
      publish(a.tenantId, 'approval.escalated', { approvalId: String(a._id), label: a.label, to: extra.map((m) => m.email) }, { app: 'juntialagents' });
    } else {
      await WorkerApproval.updateOne({ _id: a._id }, extend);
      const pendingIds = st.approverIds.filter((id) => !st.decisions.some((d) => String(d.memberId) === String(id)));
      await notifyStep({ ...a, steps: a.steps.map((s, i) => (i === a.currentStep ? { ...s, approverIds: pendingIds } : s)) }, a.currentStep);
    }
  }
  if (n) logger.info({ n }, 'Aprobaciones: plazos procesados');
  return { processed: n };
}

/** Bandeja: lo que me toca decidir ahora (o todo, para administradores). */
export async function myApprovals(orgId, userId, { all = false, status = 'pending' } = {}) {
  const m = await Membership.findOne({ orgId, userId }).lean(); if (!m) return [];
  const q = { tenantId: orgId, ...(status ? { status } : {}) };
  const rows = await WorkerApproval.find(q).sort({ createdAt: -1 }).limit(200).lean();
  const mine = (a) => (a.steps?.length ? (a.steps[a.currentStep]?.approverIds || []).map(String).includes(String(m._id)) && !a.steps[a.currentStep].decisions.some((d) => String(d.memberId) === String(m._id)) : ['owner', 'admin'].includes(m.orgRole) || appRoleOf(m, 'juntialagents') === 'admin');
  return rows.filter((a) => all || a.status !== 'pending' || mine(a)).map((a) => ({ ...a, mine: a.status === 'pending' && mine(a) }));
}
