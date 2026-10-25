import { Router } from 'express';
import { Notification, User } from '../../models/index.js';
import { asyncH } from '../../lib/errors.js';

const r = Router();
r.get('/', asyncH(async (req, res) => {
  const items = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(Math.min(+req.query.limit || 30, 100)).lean();
  const unread = await Notification.countDocuments({ userId: req.user.id, readAt: null });
  res.json({ items, unread });
}));
r.post('/:id/read', asyncH(async (req, res) => { await Notification.updateOne({ _id: req.params.id, userId: req.user.id }, { readAt: new Date() }); res.json({ ok: true }); }));
r.post('/read-all', asyncH(async (req, res) => { await Notification.updateMany({ userId: req.user.id, readAt: null }, { readAt: new Date() }); res.json({ ok: true }); }));
r.put('/prefs', asyncH(async (req, res) => {
  const { email, inApp } = req.body;
  await User.updateOne({ _id: req.user.id }, { notificationPrefs: { email: !!email, inApp: inApp !== false } });
  res.json({ ok: true });
}));
export default r;
