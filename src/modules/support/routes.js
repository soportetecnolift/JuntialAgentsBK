import { Router } from 'express';
import { z } from 'zod';
import { Ticket, TicketMessage, User, Tenant } from '../../models/index.js';
import { asyncH, notFound, forbidden } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { can, isStaff } from '../../middleware/auth.js';
import { emitTo } from '../../lib/socket.js';
import { notify, notifyStaff } from '../notifications/service.js';
import { audit } from '../../lib/audit.js';
import { emitPlatformEvent } from '../platform/events.js';

const r = Router();
const STATUS_ES = { open: 'abierto', in_progress: 'en curso', waiting_customer: 'esperando tu respuesta', resolved: 'resuelto', closed: 'cerrado' };

async function load(req) {
  const t = await Ticket.findById(req.params.id); if (!t) throw notFound('Ticket');
  if (req.user.role === 'client' && String(t.tenantId) !== String(req.user.tenantId)) throw forbidden();
  if (isStaff(req.user.role) && !can(req.user.role, 'tickets.read')) throw forbidden();
  return t;
}

r.get('/', asyncH(async (req, res) => {
  const q = {};
  if (req.user.role === 'client') q.tenantId = req.user.tenantId;
  else { if (req.query.mine) q.assignee = req.user.id; if (req.query.unassigned) q.assignee = null; }
  if (req.query.status) q.status = { $in: String(req.query.status).split(',') };
  if (req.query.channel) q.channel = req.query.channel;
  const items = await Ticket.find(q).sort({ lastMessageAt: -1 }).limit(200).populate('assignee', 'name email').populate('createdBy', 'name email').lean();
  res.json(items);
}));

r.post('/', validate(z.object({ subject: z.string().min(3).max(140), body: z.string().min(1).max(10000), category: z.enum(['technical', 'billing', 'feature', 'other']).default('technical'), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), channel: z.enum(['ticket', 'chat']).default('ticket') })), asyncH(async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  // Un único chat directo abierto por cliente
  if (req.body.channel === 'chat') {
    const open = await Ticket.findOne({ tenantId: req.user.tenantId, channel: 'chat', status: { $nin: ['resolved', 'closed'] } });
    if (open) return res.json(open);
  }
  const t = await Ticket.create({ tenantId: req.user.tenantId, createdBy: req.user.id, subject: req.body.subject, category: req.body.category, priority: req.body.priority, channel: req.body.channel, lastMessageAt: new Date() });
  await TicketMessage.create({ ticketId: t._id, authorId: req.user.id, authorRole: req.user.role, authorName: user.name || user.email, body: req.body.body });
  notifyStaff('ticket.created', { short: String(t._id).slice(-6), subject: t.subject, ticketId: t.id }).catch(() => {});
  emitPlatformEvent('ticket.created', { ticketId: t.id, tenantId: String(t.tenantId), subject: t.subject, priority: t.priority, channel: t.channel });
  res.status(201).json(t);
}));

r.get('/:id', asyncH(async (req, res) => {
  const t = await load(req);
  const q = { ticketId: t._id }; if (req.user.role === 'client') q.internal = false;
  const messages = await TicketMessage.find(q).sort({ createdAt: 1 }).lean();
  if (isStaff(req.user.role) && t.unreadForStaff) { t.unreadForStaff = false; await t.save(); }
  const tenant = isStaff(req.user.role) ? await Tenant.findById(t.tenantId).select('name').lean() : undefined;
  res.json({ ticket: await t.populate('assignee', 'name email'), messages, tenant });
}));

r.post('/:id/messages', validate(z.object({ body: z.string().min(1).max(10000), internal: z.boolean().default(false) })), asyncH(async (req, res) => {
  const t = await load(req); const staff = isStaff(req.user.role);
  if (staff && !can(req.user.role, 'tickets.write')) throw forbidden();
  const user = await User.findById(req.user.id).lean();
  const m = await TicketMessage.create({ ticketId: t._id, authorId: req.user.id, authorRole: req.user.role, authorName: user.name || user.email, body: req.body.body, internal: staff && req.body.internal });
  t.lastMessageAt = new Date();
  if (staff && !m.internal) { if (t.status === 'open') t.status = 'in_progress'; if (!t.assignee) t.assignee = req.user.id; }
  if (!staff) { t.unreadForStaff = true; if (['waiting_customer', 'resolved'].includes(t.status)) t.status = 'open'; }
  await t.save();
  emitTo(`ticket:${t._id}`, 'ticket:message', m);
  if (!m.internal) emitPlatformEvent('ticket.replied', { ticketId: t.id, byStaff: staff, preview: m.body.slice(0, 200) });
  if (!m.internal) {
    const preview = m.body.slice(0, 160);
    if (staff) notify(t.createdBy, 'ticket.replied', { subject: t.subject, ticketId: t.id, preview }).catch(() => {});
    else if (t.assignee) notify(t.assignee, 'ticket.replied', { subject: t.subject, ticketId: t.id, preview }).catch(() => {});
    else emitTo('staff', 'staff:event', { type: 'ticket.message', ticketId: t.id });
  }
  res.status(201).json(m);
}));

r.patch('/:id', validate(z.object({ status: z.enum(['open', 'in_progress', 'waiting_customer', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assignee: z.string().nullable().optional() })), asyncH(async (req, res) => {
  const t = await load(req);
  if (req.user.role === 'client') { if (req.body.status !== 'closed') throw forbidden(); t.status = 'closed'; }
  else { if (!can(req.user.role, 'tickets.write')) throw forbidden(); Object.assign(t, req.body); }
  await t.save();
  emitTo(`ticket:${t._id}`, 'ticket:updated', t);
  if (req.body.status && isStaff(req.user.role)) notify(t.createdBy, 'ticket.status', { subject: t.subject, ticketId: t.id, status: STATUS_ES[t.status] }).catch(() => {});
  audit(req, 'ticket.update', { kind: 'ticket', id: t.id }, req.body);
  res.json(t);
}));
export default r;
