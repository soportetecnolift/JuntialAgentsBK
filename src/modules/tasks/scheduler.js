import cronParser from 'cron-parser';
import { Q } from '../../lib/queues.js';
import { badRequest } from '../../lib/errors.js';

export function validateCron(cron, tz) {
  try {
    const it = cronParser.parseExpression(cron, { tz });
    const a = it.next().getTime(); const b = it.next().getTime();
    if (b - a < 5 * 60000) throw badRequest('La frecuencia mínima es de 5 minutos');
    return new Date(a);
  } catch (e) { if (e.status) throw e; throw badRequest('Expresión cron inválida'); }
}

/** Sincroniza la tarea con BullMQ (Job Schedulers: idempotentes, sobreviven reinicios y escalan en cluster). */
export async function syncTask(task) {
  const id = String(task._id);
  await Q.tasks.removeJobScheduler(`task-${id}`).catch(() => {});
  await Q.tasks.remove(`task-once-${id}`).catch(() => {});
  if (!task.enabled) return;
  if (task.type === 'cron') await Q.tasks.upsertJobScheduler(`task-${id}`, { pattern: task.cron, tz: task.timezone }, { name: 'run', data: { taskId: id }, opts: { attempts: 2, backoff: { type: 'fixed', delay: 30000 } } });
  else if (task.runAt > new Date()) await Q.tasks.add('run', { taskId: id }, { jobId: `task-once-${id}`, delay: task.runAt - Date.now(), attempts: 2 });
}
export const unscheduleTask = (task) => syncTask({ ...task, _id: task._id, enabled: false });
