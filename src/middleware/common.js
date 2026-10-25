import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { AppError, badRequest } from '../lib/errors.js';
import { httpDuration } from '../lib/metrics.js';

export const validate = (schema, where = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return next(badRequest('Datos inválidos', r.error.flatten()));
  req[where] = r.data; next();
};

export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.id); next();
}

export function metricsMw(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => end({ method: req.method, route: req.route?.path || req.baseUrl || 'unknown', status: res.statusCode }));
  next();
}

export function notFoundMw(_req, res) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } }); }

// eslint-disable-next-line no-unused-vars
export function errorMw(err, req, res, _next) {
  if (err instanceof ZodError) err = badRequest('Datos inválidos', err.flatten());
  if (err?.name === 'CastError') err = badRequest('ID inválido');
  if (err?.code === 11000) err = new AppError(409, 'CONFLICT', 'El recurso ya existe');
  const status = err.status || 500;
  const known = err instanceof AppError; // error previsto: su mensaje es seguro y útil para el usuario
  if (status >= 500 && !known) logger.error({ err, reqId: req.id, path: req.path }, 'Error no controlado');
  res.status(status).json({ error: { code: err.code || 'INTERNAL', message: status >= 500 && !known ? 'Error interno' : err.message, details: err.details, requestId: req.id } });
}
