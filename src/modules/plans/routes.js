import { Router } from 'express';
import { z } from 'zod';
import { Plan, PlanRequest, Tenant, User } from '../../models/index.js';
import { asyncH, notFound, badRequest } from '../../lib/errors.js';
import { requirePerm } from '../../middleware/auth.js';
import { validate } from '../../middleware/common.js';
import { audit } from '../../lib/audit.js';
import { getTenantPlan, getUsage, invalidatePlanCache, usageSummary, LIMITS, limitOf } from './limits.js';
import { notify, notifyStaff } from '../notifications/service.js';
import { emitPlatformEvent } from '../platform/events.js';

const r = Router();
const planSchema = z.object({
  name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]+$/), description: z.string().optional(),
  priceMonthly: z.number().min(0), currency: z.string().default('USD'),
  limits: z.object(Object.fromEntries(Object.keys(LIMITS).map((k) => [k, z.number().int().min(-1)]))).partial(),
  features: z.array(z.string()).default([]), isPublic: z.boolean().default(true), active: z.boolean().default(true), order: z.number().optional(),
});

r.get('/', asyncH(async (req, res) => {
  const q = req.user.role === 'client' ? { isPublic: true, active: true } : {};
  const plans = await Plan.find(q).sort({ order: 1, priceMonthly: 1 }).lean();
  res.json(plans.map((p) => ({ ...p, limits: Object.fromEntries(Object.keys(LIMITS).map((k) => [k, limitOf(p, k)])) })));
}));
r.get('/limits', asyncH(async (_req, res) => res.json(LIMITS)));
r.get('/me', asyncH(async (req, res) => {
  const { plan } = await getTenantPlan(req.user.tenantId);
  const resources = await usageSummary(req.user.tenantId);
  const tenant = await Tenant.findById(req.user.tenantId).lean();
  const pending = await PlanRequest.findOne({ tenantId: req.user.tenantId, status: 'pending' }).lean();
  const effective = { ...plan, limits: Object.fromEntries(Object.keys(LIMITS).map((k) => [k, limitOf(plan, k)])) };
  res.json({ plan: effective, subscription: tenant?.subscription, usage: { messages: await getUsage(req.user.tenantId) }, resources, pendingRequest: pending });
}));
// Solicitud de cambio de plan (aprobación por admin; punto de enganche para pasarela de pago)
r.post('/request', validate(z.object({ planId: z.string(), note: z.string().max(500).optional() })), asyncH(async (req, res) => {
  const plan = await Plan.findById(req.body.planId); if (!plan?.active) throw notFound('Plan no disponible');
  if (await PlanRequest.exists({ tenantId: req.user.tenantId, status: 'pending' })) throw badRequest('Ya tienes una solicitud pendiente');
  const pr = await PlanRequest.create({ tenantId: req.user.tenantId, requestedBy: req.user.id, planId: plan._id, note: req.body.note });
  notifyStaff('ticket.created', { short: String(pr._id).slice(-6), subject: `Cambio a plan ${plan.name}`, ticketId: '' }).catch(() => {});
  emitPlatformEvent('plan.requested', { tenantId: String(req.user.tenantId), plan: plan.slug, requestId: String(pr._id) });
  res.status(201).json(pr);
}));

/* Admin */
r.post('/', requirePerm('plans.write'), validate(planSchema), asyncH(async (req, res) => { const p = await Plan.create(req.body); audit(req, 'plan.create', { kind: 'plan', id: p.id }); res.status(201).json(p); }));
r.put('/:id', requirePerm('plans.write'), validate(planSchema.partial()), asyncH(async (req, res) => {
  const body = { ...req.body }; if (body.limits) { Object.entries(body.limits).forEach(([k, v]) => { body[`limits.${k}`] = v; }); delete body.limits; } // actualización parcial: no borra límites no enviados
  const p = await Plan.findByIdAndUpdate(req.params.id, { $set: body }, { new: true }); if (!p) throw notFound();
  const tenants = await Tenant.find({ 'subscription.planId': p._id }).select('_id').lean();
  await Promise.all(tenants.map((t) => invalidatePlanCache(t._id)));
  audit(req, 'plan.update', { kind: 'plan', id: p.id }, req.body); res.json(p);
}));
r.get('/requests/all', requirePerm('plans.read'), asyncH(async (_req, res) => {
  res.json(await PlanRequest.find({ status: 'pending' }).populate('planId', 'name').populate('tenantId', 'name').sort({ createdAt: 1 }).lean());
}));
r.post('/requests/:id/:decision(approve|reject)', requirePerm('tenants.write'), asyncH(async (req, res) => {
  const pr = await PlanRequest.findById(req.params.id); if (!pr || pr.status !== 'pending') throw notFound();
  pr.status = req.params.decision === 'approve' ? 'approved' : 'rejected'; await pr.save();
  if (pr.status === 'approved') await assignPlan(req, pr.tenantId, pr.planId);
  res.json(pr);
}));

export async function assignPlan(req, tenantId, planId) {
  const plan = await Plan.findById(planId).lean(); if (!plan) throw notFound('Plan');
  const now = new Date();
  const t = await Tenant.findByIdAndUpdate(tenantId, { subscription: { planId, status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) } }, { new: true });
  await invalidatePlanCache(tenantId);
  const L = plan.limits;
  notify(t.ownerId, 'plan.changed', { plan: plan.name, summary: `${L.bots} bots, ${L.messagesPerMonth} mensajes/mes, ${L.mcpServers} conectores MCP` }).catch(() => {});
  emitPlatformEvent('plan.changed', { tenantId: String(tenantId), plan: plan.slug, price: plan.priceMonthly });
  audit(req, 'tenant.plan.assign', { kind: 'tenant', id: String(tenantId) }, { plan: plan.slug });
  return t;
}
export default r;
