import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { unauthorized, forbidden } from '../lib/errors.js';

// Matriz RBAC. superadmin = todo.
export const PERMISSIONS = {
  superadmin: ['*'],
  admin: ['users.read', 'users.write', 'tenants.read', 'tenants.write', 'plans.read', 'plans.write', 'tickets.read', 'tickets.write', 'audit.read', 'bots.read_any', 'bots.write_any', 'stats.read', 'platform.webhooks'],
  employee: ['users.read', 'tenants.read', 'plans.read', 'tickets.read', 'tickets.write', 'bots.read_any', 'stats.read'],
  client: [],
};
export const can = (role, perm) => PERMISSIONS[role]?.includes('*') || PERMISSIONS[role]?.includes(perm);
export const isStaff = (role) => role !== 'client';

export async function requireAuth(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw unauthorized();
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET);
    // Revocación inmediata (logout / cierre de sesión remoto / usuario deshabilitado)
    if (await redis.exists(`revoked:sid:${p.sid}`)) throw unauthorized('Sesión cerrada');
    req.user = { id: p.sub, role: p.role, tenantId: p.tid, sid: p.sid, email: p.email };
    next();
  } catch (e) { next(e.status ? e : unauthorized('Token inválido o expirado')); }
}

export const requirePerm = (perm) => (req, _res, next) => (can(req.user.role, perm) ? next() : next(forbidden()));
export const requireRole = (...roles) => (req, _res, next) => (roles.includes(req.user.role) ? next() : next(forbidden()));

/** Filtro de tenant: clientes solo ven lo suyo; staff con permiso ve todo (o filtra con ?tenantId). */
export function tenantScope(req, anyPerm) {
  if (req.user.role === 'client') return { tenantId: req.user.tenantId };
  const perm = anyPerm || (req.method === 'GET' ? 'bots.read_any' : 'bots.write_any');
  if (can(req.user.role, perm)) return req.query.tenantId ? { tenantId: req.query.tenantId } : {};
  return { tenantId: req.user.tenantId };
}
