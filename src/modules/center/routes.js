import { Router } from 'express';
import { z } from 'zod';
import { Tenant, User, Plan, Membership, Department, Invitation, OrgApp, OrgConnection, CenterEvent, CenterSubscription, ApprovalPolicy, WorkerApproval, Bot, OAuthGrant, OAuthClient, daysFromNow } from '../../models/index.js';
import { asyncH, notFound, badRequest, forbidden } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { encrypt, decrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { Q } from '../../lib/queues.js';
import { layout } from '../../lib/mailer.js';
import { APPS, APP_ROLES, publicApps, appById } from './apps.js';
import { getMembership, invalidateMembership, appRoleOf, requireOrgAdmin } from './access.js';
import { publish } from './events.js';
import { connectionRequest } from './connections.js';
import { matchPolicy, resolveApprovers, myApprovals, findAmount } from './approvals.js';

/** Juntial Center: /api/center (y /v1/center) */
const r = Router();
const org = (req) => { if (!req.user.tenantId) throw forbidden('Sin organización activa'); return req.user.tenantId; };
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const memberView = (m) => ({ ...m, appRoles: m.appRoles || {} });
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/* ── Yo y mis organizaciones ── */
r.get('/me', asyncH(async (req, res) => {
  const mems = await Membership.find({ userId: req.user.id, status: 'active' }).lean();
  const orgs = await Tenant.find({ _id: { $in: mems.map((m) => m.orgId) } }).select('name slug logo status').lean();
  const cur = mems.find((m) => String(m.orgId) === String(req.user.tenantId));
  const enabled = await OrgApp.find({ orgId: req.user.tenantId }).lean();
  res.json({
    user: { id: req.user.id, email: req.user.email },
    organizations: orgs.map((o) => ({ ...o, role: mems.find((m) => String(m.orgId) === String(o._id))?.orgRole, active: String(o._id) === String(req.user.tenantId) })),
    membership: cur ? memberView(cur) : null,
    apps: publicApps().map((a) => ({ ...a, enabled: a.status === 'available' && (enabled.find((x) => x.appId === a.id)?.enabled ?? a.id === 'juntialagents'), myRole: cur ? appRoleOf(cur, a.id) : 'none' })),
    appRoles: APP_ROLES,
  });
}));
r.post('/orgs', validate(z.object({ name: z.string().min(2).max(80), country: z.string().max(60).optional() })), asyncH(async (req, res) => {
  if (req.user.role !== 'client') throw forbidden('Las cuentas del equipo no crean organizaciones');
  if ((await Membership.countDocuments({ userId: req.user.id, orgRole: 'owner' })) >= 10) throw badRequest('Máximo 10 organizaciones propias');
  const free = await Plan.findOne({ slug: 'free' }).lean(); const now = new Date();
  let slug = slugify(req.body.name); if (await Tenant.exists({ slug })) slug = `${slug}-${randomToken(3).toLowerCase()}`;
  const t = await Tenant.create({ name: req.body.name, slug, country: req.body.country, ownerId: req.user.id, subscription: { planId: free?._id, status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000) } });
  const u = await User.findById(req.user.id).lean();
  await Membership.create({ orgId: t._id, userId: req.user.id, email: u.email, name: u.name, orgRole: 'owner', appRoles: { juntialagents: 'admin' }, status: 'active', joinedAt: now });
  await OrgApp.create({ orgId: t._id, appId: 'juntialagents', enabled: true, enabledBy: req.user.id });
  await User.updateOne({ _id: req.user.id }, { tenantId: t._id });
  audit(req, 'center.org.create', { kind: 'tenant', id: String(t._id) }); res.status(201).json({ org: t, switched: true });
}));
// Cambiar de organización: el cliente renueva su sesión (/api/auth/refresh) para obtener el token de la nueva
r.post('/orgs/:id/switch', asyncH(async (req, res) => {
  const m = await Membership.findOne({ orgId: req.params.id, userId: req.user.id, status: 'active' }).lean(); if (!m) throw forbidden('No perteneces a esa organización');
  await User.updateOne({ _id: req.user.id }, { tenantId: req.params.id }); res.json({ ok: true, refresh: true });
}));
r.get('/org', asyncH(async (req, res) => { const t = await Tenant.findById(org(req)).populate('subscription.planId', 'name slug').lean(); if (!t) throw notFound(); res.json({ ...t, members: await Membership.countDocuments({ orgId: t._id, status: 'active' }) }); }));
r.put('/org', requireOrgAdmin, validate(z.object({ name: z.string().min(2).max(80), logo: z.string().url().max(500).or(z.literal('')), country: z.string().max(60), timezone: z.string().max(60) }).partial()), asyncH(async (req, res) => { res.json(await Tenant.findByIdAndUpdate(org(req), req.body, { new: true })); }));

/* ── Miembros ── */
r.get('/members', asyncH(async (req, res) => res.json((await Membership.find({ orgId: org(req) }).sort({ orgRole: 1, name: 1 }).lean()).map(memberView))));
const memberPatch = z.object({ orgRole: z.enum(['admin', 'member']), title: z.string().max(80), departmentIds: z.array(z.string()).max(20), managerId: z.string().nullable(), appRoles: z.record(z.enum(['admin', 'editor', 'viewer', 'none'])), telegramUsername: z.string().max(40).or(z.literal('')), status: z.enum(['active', 'disabled']) }).partial();
r.put('/members/:id', requireOrgAdmin, validate(memberPatch), asyncH(async (req, res) => {
  const m = await Membership.findOne({ _id: req.params.id, orgId: org(req) }); if (!m) throw notFound('Miembro');
  if (m.orgRole === 'owner' && (req.body.orgRole || req.body.status === 'disabled' || req.body.appRoles?.juntialagents && req.body.appRoles.juntialagents !== 'admin')) throw badRequest('El propietario no se puede degradar ni desactivar');
  Object.assign(m, { ...req.body, telegramUsername: req.body.telegramUsername !== undefined ? req.body.telegramUsername.replace(/^@/, '').toLowerCase() || undefined : m.telegramUsername, appRoles: req.body.appRoles ? { ...m.appRoles, ...req.body.appRoles } : m.appRoles });
  m.markModified('appRoles'); await m.save(); await invalidateMembership(m.userId, m.orgId);
  audit(req, 'center.member.update', { kind: 'membership', id: m.id }, req.body); res.json(memberView(m.toObject()));
}));
r.put('/me/profile', validate(z.object({ title: z.string().max(80), telegramUsername: z.string().max(40).or(z.literal('')) }).partial()), asyncH(async (req, res) => {
  const m = await Membership.findOneAndUpdate({ orgId: org(req), userId: req.user.id }, { ...req.body, ...(req.body.telegramUsername !== undefined ? { telegramUsername: req.body.telegramUsername.replace(/^@/, '').toLowerCase() || undefined } : {}) }, { new: true }).lean();
  await invalidateMembership(req.user.id, org(req)); res.json(memberView(m));
}));
r.delete('/members/:id', requireOrgAdmin, asyncH(async (req, res) => {
  const m = await Membership.findOne({ _id: req.params.id, orgId: org(req) }); if (!m) throw notFound(); if (m.orgRole === 'owner') throw badRequest('No se puede quitar al propietario');
  await m.deleteOne(); await invalidateMembership(m.userId, m.orgId);
  const u = await User.findById(m.userId); if (u && String(u.tenantId) === String(m.orgId)) { const other = await Membership.findOne({ userId: u._id, status: 'active' }).lean(); u.tenantId = other?.orgId || null; await u.save(); }
  publish(m.orgId, 'center.member.removed', { email: m.email }, { actor: req.user.email }); audit(req, 'center.member.remove', { kind: 'membership', id: m.id }); res.json({ ok: true });
}));

/* ── Invitaciones ── */
r.get('/invitations', requireOrgAdmin, asyncH(async (req, res) => res.json(await Invitation.find({ orgId: org(req), acceptedAt: null }).sort({ createdAt: -1 }).lean())));
r.post('/invitations', requireOrgAdmin, validate(z.object({ email: z.string().email(), orgRole: z.enum(['admin', 'member']).default('member'), title: z.string().max(80).optional(), departmentIds: z.array(z.string()).max(20).default([]), appRoles: z.record(z.enum(['admin', 'editor', 'viewer', 'none'])).default({ juntialagents: 'editor' }) })), asyncH(async (req, res) => {
  const o = org(req); const email = req.body.email.toLowerCase();
  const u = await User.findOne({ email }).lean();
  if (u && await Membership.exists({ orgId: o, userId: u._id })) throw badRequest('Esa persona ya es miembro');
  const raw = randomToken(24); await Invitation.deleteMany({ orgId: o, email, acceptedAt: null });
  const inv = await Invitation.create({ ...req.body, email, orgId: o, tokenHash: sha256(raw), invitedBy: req.user.id, expiresAt: daysFromNow(7) });
  const t = await Tenant.findById(o).lean(); const link = `${env.WEB_URL}/invite/${raw}`;
  await Q.email.add('send', { to: email, subject: `Te invitan a ${t.name} en Juntial Center`, html: layout(`Únete a ${esc(t.name)}`, `<p>${esc(req.user.email)} te ha invitado a la organización <b>${esc(t.name)}</b> en Juntial Center.</p><p><a href="${link}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#0E7C86;color:#fff;font-weight:700;text-decoration:none">Aceptar invitación</a></p><p style="font-size:12px;color:#5b6673">Caduca en 7 días.</p>`, null) }, { attempts: 3 });
  publish(o, 'center.member.invited', { email }, { actor: req.user.email }); audit(req, 'center.invite', { kind: 'invitation', id: inv.id }, { email });
  res.status(201).json({ ...inv.toObject(), link });
}));
r.delete('/invitations/:id', requireOrgAdmin, asyncH(async (req, res) => { await Invitation.deleteOne({ _id: req.params.id, orgId: org(req) }); res.json({ ok: true }); }));
r.post('/invitations/accept', validate(z.object({ token: z.string().min(20) })), asyncH(async (req, res) => {
  const inv = await Invitation.findOne({ tokenHash: sha256(req.body.token), acceptedAt: null, expiresAt: { $gt: new Date() } }); if (!inv) throw badRequest('La invitación no es válida o ha caducado');
  const u = await User.findById(req.user.id).lean();
  if (u.email.toLowerCase() !== inv.email) throw forbidden(`La invitación es para ${inv.email}. Entra con esa cuenta.`);
  await Membership.updateOne({ orgId: inv.orgId, userId: u._id }, { $set: { email: u.email, name: u.name, orgRole: inv.orgRole, title: inv.title, departmentIds: inv.departmentIds, appRoles: inv.appRoles || { juntialagents: 'editor' }, status: 'active', joinedAt: new Date() } }, { upsert: true });
  inv.acceptedAt = new Date(); await inv.save(); await User.updateOne({ _id: u._id }, { tenantId: inv.orgId }); await invalidateMembership(u._id, inv.orgId);
  publish(inv.orgId, 'center.member.joined', { email: u.email, name: u.name }, { actor: u.email });
  res.json({ ok: true, orgId: inv.orgId, refresh: true });
}));

/* ── Áreas / departamentos ── */
r.get('/departments', asyncH(async (req, res) => {
  const deps = await Department.find({ orgId: org(req) }).sort({ name: 1 }).lean(); const ms = await Membership.find({ orgId: org(req), status: 'active' }).select('departmentIds').lean();
  res.json(deps.map((d) => ({ ...d, members: ms.filter((m) => (m.departmentIds || []).map(String).includes(String(d._id))).length })));
}));
const depSchema = z.object({ name: z.string().min(2).max(60), description: z.string().max(300).default(''), color: z.string().max(20).default('#0E7C86'), parentId: z.string().nullable().optional(), headId: z.string().nullable().optional() });
r.post('/departments', requireOrgAdmin, validate(depSchema), asyncH(async (req, res) => res.status(201).json(await Department.create({ ...req.body, orgId: org(req) }))));
r.put('/departments/:id', requireOrgAdmin, validate(depSchema.partial()), asyncH(async (req, res) => { const d = await Department.findOneAndUpdate({ _id: req.params.id, orgId: org(req) }, req.body, { new: true }); if (!d) throw notFound(); res.json(d); }));
r.delete('/departments/:id', requireOrgAdmin, asyncH(async (req, res) => { await Department.deleteOne({ _id: req.params.id, orgId: org(req) }); await Membership.updateMany({ orgId: org(req) }, { $pull: { departmentIds: req.params.id } }); res.json({ ok: true }); }));

/* ── Aplicaciones ── */
r.get('/apps', asyncH(async (req, res) => { const en = await OrgApp.find({ orgId: org(req) }).lean(); res.json({ apps: publicApps().map((a) => ({ ...a, enabled: en.find((x) => x.appId === a.id)?.enabled ?? false })), roles: APP_ROLES }); }));
r.put('/apps/:appId', requireOrgAdmin, validate(z.object({ enabled: z.boolean() })), asyncH(async (req, res) => {
  const a = appById(req.params.appId); if (!a) throw notFound('Aplicación'); if (a.status !== 'available') throw badRequest('Esta aplicación aún no está disponible');
  await OrgApp.updateOne({ orgId: org(req), appId: a.id }, { enabled: req.body.enabled, enabledBy: req.user.id }, { upsert: true });
  publish(org(req), req.body.enabled ? 'center.app.enabled' : 'center.app.disabled', { app: a.id }, { actor: req.user.email }); res.json({ ok: true });
}));

/* ── Conexiones compartidas ── */
const connView = (c) => { const o = c.toObject ? c.toObject() : c; delete o.credentialsEnc; return o; };
r.get('/connections', asyncH(async (req, res) => res.json(await OrgConnection.find({ orgId: org(req) }).sort({ name: 1 }).lean())));
const connSchema = z.object({ name: z.string().min(2).max(60), slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Nombre API: minúsculas, números, - y _'), service: z.string().max(60).default(''), description: z.string().max(300).default(''), type: z.enum(['api_key', 'bearer', 'basic', 'headers', 'oauth2_client_credentials']), baseUrl: z.string().url().startsWith('https://', 'La URL base debe ser https').or(z.literal('')).default(''), credentials: z.record(z.any()), apps: z.array(z.string()).default(['juntialagents']) });
r.post('/connections', requireOrgAdmin, validate(connSchema), asyncH(async (req, res) => {
  const { credentials, ...b } = req.body; if (await OrgConnection.exists({ orgId: org(req), slug: b.slug })) throw badRequest('Ya existe una conexión con ese nombre API');
  const c = await OrgConnection.create({ ...b, orgId: org(req), credentialsEnc: encrypt(JSON.stringify(credentials)), createdBy: req.user.id });
  audit(req, 'center.connection.create', { kind: 'connection', id: c.slug }); res.status(201).json(connView(c));
}));
r.put('/connections/:id', requireOrgAdmin, validate(connSchema.partial().omit({ slug: true })), asyncH(async (req, res) => {
  const c = await OrgConnection.findOne({ _id: req.params.id, orgId: org(req) }).select('+credentialsEnc'); if (!c) throw notFound();
  const { credentials, ...b } = req.body; Object.assign(c, b);
  if (credentials) { const cur = JSON.parse(decrypt(c.credentialsEnc) || '{}'); c.credentialsEnc = encrypt(JSON.stringify(Object.fromEntries(Object.entries({ ...cur, ...credentials }).filter(([, v]) => v !== '')))); }
  await c.save(); res.json(connView(c));
}));
r.delete('/connections/:id', requireOrgAdmin, asyncH(async (req, res) => { await OrgConnection.deleteOne({ _id: req.params.id, orgId: org(req) }); res.json({ ok: true }); }));
r.post('/connections/:id/test', requireOrgAdmin, validate(z.object({ url: z.string().max(1000).default(''), method: z.string().default('GET') })), asyncH(async (req, res) => {
  const c = await OrgConnection.findOne({ _id: req.params.id, orgId: org(req) }).lean(); if (!c) throw notFound();
  try { const out = await connectionRequest(org(req), c.slug, { url: req.body.url, method: req.body.method }, { app: c.apps?.[0] || 'juntialagents' }); res.json({ ok: out.ok, status: out.status, body: typeof out.body === 'string' ? out.body.slice(0, 2000) : out.body }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
}));

/* ── Eventos y suscripciones (integraciones entre apps y con sistemas externos) ── */
r.get('/events', asyncH(async (req, res) => res.json(await CenterEvent.find({ orgId: org(req), ...(req.query.type ? { type: new RegExp(`^${String(req.query.type).replace(/[^\w.]/g, '')}`) } : {}) }).sort({ createdAt: -1 }).limit(Math.min(+req.query.limit || 100, 500)).lean())));
r.get('/event-types', asyncH(async (_req, res) => res.json(APPS.filter((a) => a.publishes).flatMap((a) => a.publishes.map((t) => ({ app: a.id, type: t }))).concat(['center.member.invited', 'center.member.joined', 'center.member.removed', 'center.app.enabled', 'center.app.disabled', 'approval.step', 'approval.escalated'].map((t) => ({ app: 'center', type: t }))))));
r.get('/subscriptions', requireOrgAdmin, asyncH(async (req, res) => res.json(await CenterSubscription.find({ orgId: org(req) }).lean())));
r.post('/subscriptions', requireOrgAdmin, validate(z.object({ name: z.string().min(2).max(60), events: z.array(z.string().max(80)).min(1).max(50), url: z.string().url().startsWith('https://', 'Debe ser https') })), asyncH(async (req, res) => {
  const secret = `whsec_${randomToken(24)}`; const s = await CenterSubscription.create({ ...req.body, orgId: org(req), secretEnc: encrypt(secret) });
  res.status(201).json({ ...s.toObject(), secretEnc: undefined, secret });
}));
r.put('/subscriptions/:id', requireOrgAdmin, validate(z.object({ name: z.string(), events: z.array(z.string()), url: z.string().url(), enabled: z.boolean() }).partial()), asyncH(async (req, res) => res.json(await CenterSubscription.findOneAndUpdate({ _id: req.params.id, orgId: org(req) }, req.body, { new: true }))));
r.delete('/subscriptions/:id', requireOrgAdmin, asyncH(async (req, res) => { await CenterSubscription.deleteOne({ _id: req.params.id, orgId: org(req) }); res.json({ ok: true }); }));

/* ── Políticas de aprobación ── */
const approverSpec = z.object({ kind: z.enum(['members', 'role', 'department', 'department_head']), memberIds: z.array(z.string()).default([]), orgRoles: z.array(z.string()).default([]), appRoles: z.array(z.string()).default([]), departmentIds: z.array(z.string()).default([]) });
const policySchema = z.object({
  name: z.string().min(2).max(100), description: z.string().max(500).default(''), enabled: z.boolean().default(true), priority: z.number().int().min(1).max(1000).default(100),
  match: z.object({ app: z.string().default('juntialagents'), agentIds: z.array(z.string()).default([]), departmentIds: z.array(z.string()).default([]), categories: z.array(z.enum(['read', 'internal', 'data', 'external', 'destructive'])).default([]), toolPattern: z.string().max(200).default(''), minAmount: z.number().nullable().default(null) }),
  steps: z.array(z.object({ name: z.string().min(1).max(80), approvers: approverSpec, mode: z.enum(['any', 'all', 'quorum']).default('any'), quorum: z.number().int().min(1).max(50).default(2), timeoutHours: z.number().min(0.25).max(720).default(24), onTimeout: z.enum(['remind', 'escalate', 'approve', 'reject']).default('remind'), escalate: approverSpec.optional() })).min(1, 'Añade al menos un paso').max(10),
});
r.get('/policies', asyncH(async (req, res) => res.json(await ApprovalPolicy.find({ orgId: org(req) }).sort({ priority: 1, createdAt: 1 }).lean())));
r.post('/policies', requireOrgAdmin, validate(policySchema), asyncH(async (req, res) => { const p = await ApprovalPolicy.create({ ...req.body, orgId: org(req) }); audit(req, 'center.policy.create', { kind: 'policy', id: p.id }); res.status(201).json(p); }));
r.put('/policies/:id', requireOrgAdmin, validate(policySchema.partial()), asyncH(async (req, res) => { const p = await ApprovalPolicy.findOneAndUpdate({ _id: req.params.id, orgId: org(req) }, req.body, { new: true }); if (!p) throw notFound(); audit(req, 'center.policy.update', { kind: 'policy', id: p.id }); res.json(p); }));
r.delete('/policies/:id', requireOrgAdmin, asyncH(async (req, res) => { await ApprovalPolicy.deleteOne({ _id: req.params.id, orgId: org(req) }); res.json({ ok: true }); }));
// Simulador: «si el agente X quisiera hacer Y por Z €, ¿quién lo aprobaría?»
r.post('/policies/simulate', validate(z.object({ agentId: z.string().optional(), category: z.string(), tool: z.string().default(''), amount: z.number().nullable().optional(), departmentId: z.string().optional() })), asyncH(async (req, res) => {
  const o = org(req); let dep = req.body.departmentId;
  if (!dep && req.body.agentId) dep = (await Bot.findOne({ _id: req.body.agentId, tenantId: o }).lean())?.worker?.departmentId;
  const p = await matchPolicy(o, { ...req.body, departmentId: dep });
  if (!p) return res.json({ policy: null, info: 'Ninguna política encaja: decide cualquier responsable (propietario, administradores o administradores de la app).' });
  const steps = [];
  for (const s of p.steps) { const ms = await resolveApprovers(o, s.approvers, { departmentId: dep }); steps.push({ name: s.name, mode: s.mode, quorum: s.quorum, timeoutHours: s.timeoutHours, onTimeout: s.onTimeout, approvers: ms.map((m) => ({ id: m._id, name: m.name || m.email, email: m.email })) }); }
  res.json({ policy: { id: p._id, name: p.name }, steps });
}));

/* ── Bandeja de aprobaciones de toda la organización ── */
r.get('/approvals', asyncH(async (req, res) => {
  const m = await getMembership(req.user.id, org(req)); const all = req.query.scope === 'all' && ['owner', 'admin'].includes(m?.orgRole);
  const rows = await myApprovals(org(req), req.user.id, { all, status: req.query.status === 'all' ? null : req.query.status || 'pending' });
  const bots = await Bot.find({ _id: { $in: [...new Set(rows.map((a) => String(a.botId)))] } }).select('name worker.title').lean();
  res.json(rows.map((a) => ({ ...a, agent: bots.find((b) => String(b._id) === String(a.botId)) })));
}));
r.post('/approvals/:id/decide', validate(z.object({ approve: z.boolean(), feedback: z.string().max(1000).optional() })), asyncH(async (req, res) => {
  const a = await WorkerApproval.findOne({ _id: req.params.id, tenantId: org(req) }).lean(); if (!a) throw notFound();
  if (!a.steps?.length) { const m = await getMembership(req.user.id, org(req)); if (!(['owner', 'admin'].includes(m?.orgRole) || appRoleOf(m, 'juntialagents') === 'admin')) throw forbidden('Solo los responsables pueden decidir esta aprobación'); }
  const { decideApproval } = await import('../worker/engine.js');
  const out = await decideApproval(a._id, { approve: req.body.approve, by: req.user.email, via: 'center', feedback: req.body.feedback, actor: { userId: req.user.id } });
  audit(req, 'center.approval.decide', { kind: 'approval', id: req.params.id }, { approve: req.body.approve }); res.json(out);
}));

/* ── Apps de IA conectadas por OAuth (Claude, ChatGPT…) ── */
r.get('/ai-apps', asyncH(async (req, res) => {
  const grants = await OAuthGrant.find({ orgId: org(req), revokedAt: null, refreshExp: { $gt: new Date() } }).sort({ updatedAt: -1 }).lean();
  const clients = await OAuthClient.find({ clientId: { $in: grants.map((g) => g.clientId) } }).lean(); const users = await User.find({ _id: { $in: grants.map((g) => g.userId) } }).select('email name').lean();
  res.json(grants.map((g) => ({ id: g._id, app: clients.find((c) => c.clientId === g.clientId)?.name || 'App de IA', scopes: g.scopes, user: users.find((u) => String(u._id) === String(g.userId))?.email, lastUsedAt: g.lastUsedAt, createdAt: g.createdAt, mine: String(g.userId) === String(req.user.id) })));
}));
r.delete('/ai-apps/:id', asyncH(async (req, res) => {
  const g = await OAuthGrant.findOne({ _id: req.params.id, orgId: org(req) }); if (!g) throw notFound();
  const m = await getMembership(req.user.id, org(req)); if (String(g.userId) !== String(req.user.id) && !['owner', 'admin'].includes(m?.orgRole)) throw forbidden();
  g.revokedAt = new Date(); await g.save(); const { redis } = await import('../../lib/redis.js'); if (g.accessHash) await redis.del(`oat:${g.accessHash}`); audit(req, 'center.ai_app.revoke', { kind: 'oauth_grant', id: g.id }); res.json({ ok: true });
}));
r.get('/mcp-info', asyncH(async (_req, res) => res.json({ url: `${env.PUBLIC_API_URL}/mcp`, authorization: `${env.PUBLIC_API_URL}/.well-known/oauth-authorization-server`, resource: `${env.PUBLIC_API_URL}/.well-known/oauth-protected-resource` })));
export default r;
export const invitationLookup = asyncH(async (req, res) => {
  const inv = await Invitation.findOne({ tokenHash: sha256(req.params.token), acceptedAt: null, expiresAt: { $gt: new Date() } }).lean(); if (!inv) throw notFound('Invitación');
  const t = await Tenant.findById(inv.orgId).select('name logo').lean(); res.json({ org: t, email: inv.email, orgRole: inv.orgRole, expiresAt: inv.expiresAt });
});
