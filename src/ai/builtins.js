import { ChatContext, Task } from '../models/index.js';
import { Q } from '../lib/queues.js';

/** Herramientas nativas: memoria del chat, proyecto vinculado y recordatorios creados por el propio bot. */
export const BUILTIN_TOOLS = [
  { name: 'chat_save_note', description: 'Guarda un dato importante y duradero sobre este chat (acuerdos, responsables, fechas). Úsalo cuando el usuario pida recordar algo.', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'chat_set_project', description: 'Vincula este chat a un proyecto (nombre, código, descripción o referencia CRM) cuando se identifique claramente.', schema: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' }, description: { type: 'string' }, crmRef: { type: 'string' } }, required: ['name'] } },
  { name: 'chat_get_context', description: 'Devuelve el contexto guardado de este chat: proyecto, notas, participantes y resumen.', schema: { type: 'object', properties: {} } },
  { name: 'schedule_reminder', description: 'Programa un mensaje o tarea futura en este chat. Usa fecha ISO 8601 con zona horaria.', schema: { type: 'object', properties: { runAt: { type: 'string', description: 'ISO 8601' }, message: { type: 'string' }, runAgent: { type: 'boolean', description: 'true si al ejecutarse debe razonar/usar herramientas' } }, required: ['runAt', 'message'] } },
];

export function builtinExecutor({ bot, chatId, actor }) {
  return async (name, args) => {
    const q = { botId: bot._id, chatId };
    switch (name) {
      case 'chat_save_note':
        await ChatContext.updateOne(q, { $push: { notes: { $each: [{ text: String(args.text).slice(0, 1000), at: new Date(), by: actor }], $slice: -50 } } });
        return { text: 'Nota guardada.' };
      case 'chat_set_project':
        await ChatContext.updateOne(q, { project: { name: args.name, code: args.code, description: args.description, crmRef: args.crmRef } });
        return { text: `Chat vinculado al proyecto ${args.name}.` };
      case 'chat_get_context': {
        const c = await ChatContext.findOne(q).lean();
        return { text: JSON.stringify({ title: c?.title, type: c?.type, project: c?.project, notes: c?.notes?.slice(-15), summary: c?.summary, participants: c?.participants?.slice(-20)?.map((p) => p.name) }) };
      }
      case 'schedule_reminder': {
        const runAt = new Date(args.runAt);
        if (Number.isNaN(+runAt) || runAt < new Date()) return { isError: true, text: 'Fecha inválida o en el pasado' };
        const count = await Task.countDocuments({ botId: bot._id, createdBy: 'bot', enabled: true });
        if (count >= 50) return { isError: true, text: 'Demasiados recordatorios activos' };
        const t = await Task.create({ tenantId: bot.tenantId, botId: bot._id, name: `Recordatorio: ${args.message.slice(0, 40)}`, type: 'once', runAt, action: args.runAgent ? 'agent' : 'message', prompt: args.message, chatIds: [chatId], createdBy: 'bot' });
        await Q.tasks.add('run', { taskId: String(t._id) }, { jobId: `task-once-${t._id}`, delay: runAt - Date.now() });
        return { text: `Programado para ${runAt.toISOString()}.` };
      }
      default: return null;
    }
  };
}
