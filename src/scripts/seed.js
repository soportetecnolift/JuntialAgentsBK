import { connectDB, disconnectDB } from '../lib/db.js';
import { Plan, User } from '../models/index.js';
import { env } from '../config/env.js';
import { DEFAULT_LIMITS, backfillPlanLimits } from '../modules/plans/limits.js';

await connectDB();
const plans = [
  { slug: 'free', name: 'Gratis', priceMonthly: 0, order: 1, limits: DEFAULT_LIMITS.free, features: ['1 bot', 'Claude o GPT con tu clave', 'Soporte por ticket'] },
  { slug: 'pro', name: 'Pro', priceMonthly: 29, order: 2, limits: DEFAULT_LIMITS.pro, features: ['5 bots', 'Conectores MCP con OAuth', 'Tareas programadas', 'API REST para integraciones', 'CRM con reglas de flujo', 'Funciones JavaScript', 'Chat de soporte'] },
  { slug: 'business', name: 'Business', priceMonthly: 99, order: 3, limits: DEFAULT_LIMITS.business, features: ['25 bots', 'Webhooks ilimitados por bot', 'Soporte prioritario'] },
  { slug: 'enterprise', name: 'Enterprise', priceMonthly: 0, order: 4, isPublic: false, limits: DEFAULT_LIMITS.enterprise, features: ['Límites a medida', 'SLA'] },
];
for (const p of plans) {
  // Planes nuevos: se crean completos. Planes existentes: se respetan tus límites y solo se añaden los que falten.
  const exists = await Plan.findOne({ slug: p.slug }).lean();
  if (!exists) await Plan.create(p); else await Plan.updateOne({ slug: p.slug }, { $set: { features: p.features } });
}
await backfillPlanLimits();
if (env.SUPERADMIN_EMAIL) await User.updateOne({ email: env.SUPERADMIN_EMAIL }, { $set: { role: 'superadmin', emailVerified: true, status: 'active', name: 'Superadmin' } }, { upsert: true });
console.log('✅ Planes y superadmin listos (el superadmin entra con Google o código OTP)');
await disconnectDB();
