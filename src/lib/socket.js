import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { createRedis, redis } from './redis.js';
import { Ticket } from '../models/index.js';

let io;
// Adaptador Redis => escala horizontal entre réplicas de la API.
export function initSocket(httpServer, corsOrigins) {
  io = new Server(httpServer, { cors: { origin: corsOrigins, credentials: true }, path: '/ws' });
  io.adapter(createAdapter(createRedis(), createRedis()));
  io.use((socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth?.token, env.JWT_ACCESS_SECRET);
      socket.user = { id: p.sub, role: p.role, tenantId: p.tid };
      next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
    if (socket.user.role !== 'client') socket.join('staff');
    socket.on('ticket:join', async (ticketId) => {
      const t = await Ticket.findById(ticketId).lean().catch(() => null);
      if (!t) return;
      if (socket.user.role === 'client' && String(t.tenantId) !== String(socket.user.tenantId)) return;
      socket.join(`ticket:${ticketId}`);
    });
    socket.on('ticket:typing', (ticketId) => socket.to(`ticket:${ticketId}`).emit('ticket:typing', { ticketId, userId: socket.user.id }));
  });
  return io;
}

// Desde el worker (otro proceso) emitimos vía Redis sin servidor socket propio.
let emitter;
export function emitTo(room, event, payload) {
  if (io) return io.to(room).emit(event, payload);
  emitter ??= new Emitter(redis);
  emitter.to(room).emit(event, payload);
}
