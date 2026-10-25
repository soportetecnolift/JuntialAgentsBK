import { Membership, Tenant, User, OrgApp } from '../../models/index.js';
import { redis } from '../../lib/redis.js';
import { forbidden } from '../../lib/errors.js';
import { logger } from '../../config/logger.js';

/** Membresía (cacheada 60 s) de una persona en una organización. */
export async function getMembership(userId, orgId) {
  if (!userId || !orgId) return null;
  const ck = `mbr:${orgId}:${userId}`; const c = await redis.get(ck); if (c) return JSON.parse(c);
  const m = await Membership.findOne({ orgId, userId, status: 'active' }).lean();
  await redis.set(ck, JSON.stringify(m), 'EX', 60);
  return m;
}
export const invalidateMembership = (userId, orgId) => redis.del(`mbr:${orgId}:${userId}`);
export const appRoleOf = (m, appId) => (m?.orgRole === 'owner' ? 'admin' : m?.appRoles?.[appId] || (m?.orgRole === 'admin' ? 'admin' : 'none'));

/** Migración: cada organización existente tiene a su dueño como propietario con acceso de administrador. */
export async function backfillMemberships() {
  const tenants = await Tenant.find().select('ownerId name').lean(); let n = 0;
  for (const t of tenants) {
    if (!t.ownerId) continue;
    const u = await User.findById(t.ownerId).select('email name').lean(); if (!u) continue;
    const r = await Membership.updateOne({ orgId: t._id, userId: t.ownerId }, { $setOnInsert: { email: u.email, name: u.name, orgRole: 'owner', appRoles: { juntialagents: 'admin' }, status: 'active', joinedAt: new Date() } }, { upsert: true });
    await OrgApp.updateOne({ orgId: t._id, appId: 'juntialagents' }, { $setOnInsert: { enabled: true } }, { upsert: true });
    if (r.upsertedCount) n++;
  }
  // Usuarios de clientes que ya tenían organización sin membresía (cuentas antiguas)
  const users = await User.find({ role: 'client', tenantId: { $ne: null } }).select('email name tenantId').lean();
  for (const u of users) {
    const r = await Membership.updateOne({ orgId: u.tenantId, userId: u._id }, { $setOnInsert: { email: u.email, name: u.name, orgRole: 'admin', appRoles: { juntialagents: 'admin' }, status: 'active', joinedAt: new Date() } }, { upsert: true });
    if (r.upsertedCount) n++;
  }
  if (n) logger.info({ n }, 'Juntial Center: membresías creadas para organizaciones existentes');
  return n;
}

/**
 * Permisos de una app para los usuarios de cliente (el equipo de la plataforma no pasa por aquí).
 * viewer: solo lectura · editor: todo salvo administración · admin: todo.
 */
const ADMIN_ONLY = [/^\/api\/developer/, /^\/api\/plans\/request/];
export const appGuard = (appId) => async (req, _res, next) => {
  try {
    if (!req.user || req.user.role !== 'client' || !req.user.tenantId) return next();
    const m = await getMembership(req.user.id, req.user.tenantId);
    if (!m) throw forbidden('No perteneces a esta organización');
    const role = appRoleOf(m, appId);
    const app = await OrgApp.findOne({ orgId: req.user.tenantId, appId }).lean();
    if (app && app.enabled === false) throw forbidden('Esta aplicación está desactivada en tu organización');
    if (role === 'none') throw forbidden('No tienes acceso a esta aplicación. Pídeselo a un administrador en Juntial Center.');
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (role === 'viewer' && write) throw forbidden('Tu rol es de solo lectura');
    if (role !== 'admin' && write && ADMIN_ONLY.some((r) => r.test(req.originalUrl))) throw forbidden('Solo los administradores pueden hacer esto');
    req.member = m; req.appRole = role; next();
  } catch (e) { next(e); }
};
/** Solo propietarios/administradores de la organización. */
export const requireOrgAdmin = async (req, _res, next) => {
  try {
    if (req.user.role !== 'client') return next();
    const m = await getMembership(req.user.id, req.user.tenantId);
    if (!m || !['owner', 'admin'].includes(m.orgRole)) throw forbidden('Solo los administradores de la organización');
    req.member = m; next();
  } catch (e) { next(e); }
};
