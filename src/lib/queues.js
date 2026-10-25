import { Queue } from 'bullmq';
import { redis } from './redis.js';

const base = { connection: redis, defaultJobOptions: { removeOnComplete: { count: 1000, age: 3600 }, removeOnFail: { count: 5000, age: 7 * 86400 } } };
export const Q = {
  chat: new Queue('chat-drain', base),          // procesamiento serializado por chat
  tasks: new Queue('scheduled-tasks', base),    // tareas programadas (cron / una vez)
  webhooks: new Queue('webhook-out', base),     // entregas salientes con reintentos
  inbound: new Queue('webhook-in', base),       // disparos entrantes
  email: new Queue('email', base),
  maintenance: new Queue('maintenance', base),
  workflows: new Queue('workflows', base),
  workers: new Queue('workers', base),            // empleados digitales: rutinas, eventos, seguimientos y decisiones        // reglas de flujo: eventos de registros, acciones programadas y por fecha
};
