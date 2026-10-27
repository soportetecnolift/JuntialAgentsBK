process.env.SERVICE_NAME ||= 'juntialagents-worker';
import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDB, disconnectDB } from './lib/db.js';
import { createRedis } from './lib/redis.js';
import { Q } from './lib/queues.js';
import { drainChat } from './telegram/processor.js';
import { runTaskJob, inboundJob, emailJob, maintenanceJob } from './jobs/index.js';
import { deliverWebhook } from './modules/webhooks/dispatcher.js';
import { processWorkflowJob, deliverWorkflowHook } from './modules/crm/engine.js';
import { processWorkerJob } from './modules/worker/engine.js';
import { deliverWorkerHook } from './modules/worker/channels.js';
import { deliverCenterHook } from './modules/center/events.js';

await connectDB();
await (await import('./modules/center/access.js')).backfillMemberships().catch((err) => logger.warn({ err }, 'Juntial Center: migración de membresías'));
await (await import('./modules/plans/limits.js')).backfillPlanLimits().then((n) => n && logger.info({ plans: n }, 'Límites nuevos añadidos a planes existentes')).catch((err) => logger.warn({ err }, 'No se pudo revisar los límites de planes'));
const conn = createRedis();
const mk = (name, fn, opts = {}) => {
  const w = new Worker(name, fn, { connection: conn, concurrency: 10, ...opts });
  w.on('failed', (job, err) => logger.warn({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  w.on('error', (err) => logger.error({ queue: name, err }, 'worker error'));
  return w;
};

// Chats distintos en paralelo; el mismo chat SIEMPRE en serie (lock por chat en drainChat)
const workers = [
  mk('chat-drain', drainChat, { concurrency: env.WORKER_CONCURRENCY, lockDuration: 120000 }),
  mk('scheduled-tasks', runTaskJob, { concurrency: 20 }),
  mk('webhook-out', (job) => (job.name === 'wf-hook' ? deliverWorkflowHook(job) : job.name === 'wk-hook' ? deliverWorkerHook(job) : job.name === 'center-hook' ? deliverCenterHook(job) : deliverWebhook(job)), { concurrency: 30 }),
  mk('workflows', processWorkflowJob, { concurrency: 20 }),
  mk('workers', processWorkerJob, { concurrency: 10, lockDuration: 600000 }),
  mk('webhook-in', inboundJob, { concurrency: 20 }),
  mk('email', emailJob, { concurrency: 10, limiter: { max: 10, duration: 1000 } }),
  mk('maintenance', maintenanceJob, { concurrency: 1 }),
];

// Mantenimiento diario: avisos de sesión a punto de caducar (30 días absolutos)
await Q.maintenance.upsertJobScheduler('session-expiry-notices', { pattern: '0 9 * * *', tz: 'Europe/Madrid' }, { name: 'session-expiry' });
await Q.workers.upsertJobScheduler('approval-timeouts', { every: 15 * 60 * 1000 }, { name: 'approval-timeouts' });
await Q.workflows.upsertJobScheduler('crm-date-scan', { every: 10 * 60 * 1000 }, { name: 'date-scan' });
await Q.maintenance.upsertJobScheduler('model-check', { pattern: '0 6 * * *', tz: 'Europe/Madrid' }, { name: 'model-check' });
// Las programaciones viven en Redis: si Redis se reinició sin persistencia (p. ej. plan gratuito), se reconstruyen desde Mongo
try {
  const { WorkerRoutine, Task } = await import('./models/index.js');
  const { syncRoutine } = await import('./modules/worker/engine.js');
  const { syncTask } = await import('./modules/tasks/scheduler.js');
  const routines = await WorkerRoutine.find({ enabled: true }).lean(); for (const r of routines) await syncRoutine(r).catch(() => {});
  const { Bot: BotM } = await import('./models/index.js'); const { syncHeartbeat } = await import('./modules/worker/engine.js');
  for (const b of await BotM.find({ kind: 'worker', 'worker.proactive.enabled': true }).lean()) await syncHeartbeat(b).catch(() => {});
  const tasks = await Task.find({ enabled: true }).lean(); for (const t of tasks) await syncTask(t).catch(() => {});
  logger.info({ routines: routines.length, tasks: tasks.length }, 'Programaciones sincronizadas');
} catch (err) { logger.warn({ err }, 'No se pudieron sincronizar las programaciones'); }
logger.info('Workers en marcha');

export async function closeWorkers() { await Promise.all(workers.map((w) => w.close())); }
async function shutdown() {
  logger.info('Cerrando workers (terminando jobs activos)…');
  await closeWorkers();
  await disconnectDB(); process.exit(0);
}
if (!process.env.ALL_IN_ONE) { process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); }
