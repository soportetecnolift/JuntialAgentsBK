import { Notification, User, daysFromNow } from '../../models/index.js';
import { TEMPLATES } from './templates.js';
import { Q } from '../../lib/queues.js';
import { emitTo } from '../../lib/socket.js';
import { logger } from '../../config/logger.js';

/** Notifica a uno o varios usuarios por los canales que corresponda (in-app + email + socket). */
export async function notify(userIds, type, data = {}, { forceEmail = false } = {}) {
  const tpl = TEMPLATES[type];
  if (!tpl) return logger.warn({ type }, 'Plantilla de notificación desconocida');
  const ids = [].concat(userIds).filter(Boolean);
  const users = await User.find({ _id: { $in: ids } }).select('email name notificationPrefs').lean();
  for (const u of users) {
    const title = tpl.title(data); const body = tpl.body(data); const link = tpl.link?.(data);
    if (tpl.inApp !== false && u.notificationPrefs?.inApp !== false) {
      const n = await Notification.create({ userId: u._id, type, title, body: body.replace(/<[^>]+>/g, ''), link, severity: tpl.severity, expiresAt: daysFromNow(90) });
      emitTo(`user:${u._id}`, 'notification', n);
    }
    if (tpl.email && (forceEmail || type.startsWith('auth.') || u.notificationPrefs?.email !== false)) {
      await Q.email.add('send', { to: u.email, subject: title, title, body, link }, { attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
    }
  }
}

/** Para destinatarios que aún no son usuarios (p.ej. OTP de registro). */
export const emailDirect = (to, type, data) => {
  const tpl = TEMPLATES[type];
  return Q.email.add('send', { to, subject: tpl.title(data), title: tpl.title(data), body: tpl.body(data), link: tpl.link?.(data) }, { attempts: 5, backoff: { type: 'exponential', delay: 3000 } });
};

export const notifyStaff = async (type, data) => {
  const staff = await User.find({ role: { $in: ['superadmin', 'admin', 'employee'] }, status: 'active' }).select('_id').lean();
  await notify(staff.map((s) => s._id), type, data);
  emitTo('staff', 'staff:event', { type, data });
};
