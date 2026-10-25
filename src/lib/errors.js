export class AppError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const badRequest = (m, d) => new AppError(400, 'BAD_REQUEST', m, d);
export const unauthorized = (m = 'No autenticado') => new AppError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'Sin permisos') => new AppError(403, 'FORBIDDEN', m);
export const notFound = (m = 'No encontrado') => new AppError(404, 'NOT_FOUND', m);
export const conflict = (m) => new AppError(409, 'CONFLICT', m);
export const tooMany = (m = 'Demasiadas solicitudes') => new AppError(429, 'RATE_LIMITED', m);
export const planLimit = (m) => new AppError(402, 'PLAN_LIMIT', m);
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
