import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Contexto de traza (correlación): todo lo que se registra durante un turno de chat, una petición web
 * o una tarea de un empleado digital comparte el mismo traceId, aunque pase por colas, MCP o funciones.
 */
const als = new AsyncLocalStorage();
export const newTraceId = () => randomUUID().replace(/-/g, '').slice(0, 16);
export const withTrace = (ctx, fn) => als.run({ traceId: ctx.traceId || newTraceId(), t0: Date.now(), ...ctx }, fn);
export const getTrace = () => als.getStore() || null;
