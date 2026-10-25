import { Bot, CrmRecord, CrmFunction, Tenant, WorkerRun, WorkerApproval, WorkerRoutine, WorkerMessage, WorkerFile, daysFromNow } from '../../models/index.js';
import { analyzeDocument, storeDocument, docRef, isSupported, guessMime } from './documents.js';
import { Q } from '../../lib/queues.js';
import { redis, acquireLock, releaseLock, extendLock } from '../../lib/redis.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { runAgent } from '../../ai/agent.js';
import { getBotRuntime } from '../../telegram/runtime.js';
import { loadTools, callTool } from '../mcp/client.js';
import { getFields, agentFieldSchema } from '../crm/fields.js';
import { saveRecord } from '../crm/records.js';
import { runFunction } from '../crm/sandbox.js';
import { consumeMessage } from '../plans/limits.js';
import { notify } from '../notifications/service.js';
import { botLog } from '../../lib/audit.js';
import { searchKnowledge } from './knowledge.js';
import { CATEGORIES } from './roles.js';
import { fanOutApproval, fanOutReport, syncDecision, newDecisionToken } from './channels.js';
import { matchPolicy, startPolicyApproval, decidePolicyStep, findAmount } from '../center/approvals.js';
import { publish } from '../center/events.js';

/* ───────── Clasificación de riesgo de cada acción (autonomía calibrada por tipo de acción) ───────── */
const BUILTIN_CATEGORY = {
  test_approval: 'internal', search_knowledge: 'read', crm_search: 'read', crm_get: 'read', analyze_document: 'read', list_documents: 'read', mark_document: 'internal',
  save_memory: 'internal', report: 'internal', schedule_followup: 'internal', ask_human: 'internal',
  crm_update: 'data', crm_create: 'data', run_function: 'data',
  send_email: 'external', send_telegram: 'external',
};
/* Verbos por categoría. Se buscan en CUALQUIER parte del nombre (ZohoCRM_getTasksRecords → zoho · crm · get · tasks · records). */
const VERBS = {
  destructive: ['delete', 'remove', 'void', 'cancel', 'destroy', 'purge', 'writeoff', 'refund', 'revoke', 'terminate', 'trash', 'erase', 'wipe', 'drop'],
  read: ['get', 'list', 'search', 'find', 'read', 'fetch', 'retrieve', 'query', 'count', 'describe', 'check', 'lookup', 'view', 'show', 'export', 'download', 'preview', 'autocomplete', 'poll', 'validate', 'verify', 'calculate', 'estimate', 'analyze', 'summarize', 'browse', 'inspect', 'status', 'info', 'details', 'history', 'report', 'stats', 'metadata', 'meta'],
  external: ['send', 'email', 'emails', 'sms', 'whatsapp', 'message', 'notify', 'post', 'reply', 'publish', 'invite', 'remind', 'reminder', 'resend', 'call', 'tweet', 'broadcast', 'mail', 'dm', 'share'],
  data: ['create', 'add', 'insert', 'update', 'edit', 'set', 'mark', 'assign', 'approve', 'apply', 'upload', 'import', 'move', 'copy', 'clone', 'merge', 'convert', 'submit', 'enable', 'disable', 'deactivate', 'archive', 'reject', 'decline', 'unsubscribe', 'untrack', 'track', 'map', 'upsert', 'patch', 'put', 'save', 'register', 'attach', 'link', 'tag', 'schedule', 'execute', 'run', 'trigger', 'deploy', 'generate', 'restore', 'reorder', 'publish_function'],
};
// Prefijos de producto que no son verbos (zoho, crm, books…) para no confundirlos
const NOISE = new Set(['bulk', 'zoho', 'zohocrm', 'zohobooks', 'crm', 'books', 'desk', 'creator', 'analytics', 'workdrive', 'mcp', 'api', 'v1', 'v2', 'tool', 'google', 'gmail', 'notion', 'slack', 'hubspot', 'salesforce', 'make', 'by', 'from', 'to', 'for', 'of', 'the', 'a', 'an', 'all']);
export const nameTokens = (name) => String(name).split('__').pop()
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !NOISE.has(t));
/** Categoría de riesgo de una acción. Prioridad: anotaciones oficiales MCP → propias → verbo del nombre. */
export function categorize(name, annotations) {
  if (BUILTIN_CATEGORY[name]) return BUILTIN_CATEGORY[name];
  if (annotations?.readOnlyHint === true) return 'read';
  if (annotations?.destructiveHint === true) return 'destructive';
  const toks = nameTokens(name);
  // 'write_off' / 'writeoff' es destructivo; 'write' a secas es escritura normal
  const joined = toks.join(' ');
  if (/\bwrite ?off\b/.test(joined)) return 'destructive';
  // Lo irreversible manda aunque no sea la primera palabra (mark_invoice_void, set_status_cancelled…)
  if (toks.some((t) => VERBS.destructive.includes(t))) return 'destructive';
  for (const t of toks) {
    if (t === 'write') return 'data';
    for (const cat of ['destructive', 'external', 'read', 'data']) if (VERBS[cat].includes(t)) return cat;
  }
  if (annotations?.openWorldHint === false && annotations?.destructiveHint === false) return 'data';
  return 'data'; // desconocido: lo prudente es tratarlo como cambio de datos (pide aprobación por defecto)
}
export function policyFor(bot, name, category) {
  const o = bot.worker?.autonomy?.toolOverrides?.[name]; if (o) return o;
  return bot.worker?.autonomy?.policy?.[category] || (category === 'read' || category === 'internal' ? 'auto' : 'approve');
}
const short = (v, n = 600) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? `${s.slice(0, n)}…` : s; };
const LABELS = { send_email: 'Enviar email', send_telegram: 'Enviar mensaje de Telegram', crm_update: 'Actualizar contacto', crm_create: 'Crear contacto', run_function: 'Ejecutar función' };
const humanLabel = (name, args) => {
  if (name === 'send_email') return `Enviar email a ${args?.to}: «${String(args?.subject || '').slice(0, 80)}»`;
  if (name === 'send_telegram') return `Enviar por Telegram: «${String(args?.text || '').slice(0, 100)}»`;
  if (name === 'crm_update') return `Actualizar contacto ${args?.id}: ${Object.entries(args?.fields || {}).map(([k, v]) => `${k} = ${short(v, 40)}`).join(', ')}`;
  if (name === 'crm_create') return `Crear contacto ${args?.fields?.name || args?.fields?.email || ''}`;
  return `${LABELS[name] || name.replace('__', ' › ')} ${short(args, 160)}`;
};

/* ───────── Herramientas propias del empleado digital ───────── */
async function workerTools(bot) {
  const fields = await getFields(bot.tenantId);
  return [
    { name: 'search_knowledge', description: 'Busca en los documentos de formación de la empresa (procedimientos, catálogos, políticas). Úsalo antes de responder dudas de negocio.', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'analyze_document', description: 'Lee y analiza un documento (PDF, también escaneado; imagen; Word; Excel/CSV; texto) con el contexto de tu puesto y tus reglas de documentos. Devuelve tipo, datos extraídos, incidencias y acciones sugeridas. Usa "ref" (doc:…) para documentos de tu bandeja o adjuntos que te devolvió un conector, o "url" para un enlace.', schema: { type: 'object', properties: { ref: { type: 'string' }, url: { type: 'string' }, goal: { type: 'string', description: 'Qué necesitas saber o hacer con él (opcional)' } } } },
    { name: 'list_documents', description: 'Lista los documentos de tu bandeja (por defecto, los pendientes).', schema: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'analyzed', 'processed', 'ignored', 'error', 'all'] } } } },
    { name: 'mark_document', description: 'Marca un documento como procesado o ignorado, con una nota de lo que hiciste.', schema: { type: 'object', properties: { ref: { type: 'string' }, status: { type: 'string', enum: ['processed', 'ignored'] }, note: { type: 'string' } }, required: ['ref', 'status'] } },
    { name: 'save_memory', description: 'Guarda un aprendizaje duradero para tu trabajo futuro (preferencias del responsable, excepciones, contexto). Escríbelo claro y en una frase.', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'report', description: 'Envía un aviso o informe a tu responsable por su canal (panel y Telegram). Úsalo para lo importante, no para cada paso.', schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['title', 'body'] } },
    { name: 'ask_human', description: 'Pregunta a tu responsable cuando necesites una decisión o un dato que no tienes. Ofrece 2–4 opciones si es posible.', schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
    { name: 'schedule_followup', description: 'Prográmate para retomar algo más tarde (por ejemplo, comprobar en 2 días si un cliente respondió).', schema: { type: 'object', properties: { runAt: { type: 'string', description: 'ISO 8601' }, instruction: { type: 'string' } }, required: ['runAt', 'instruction'] } },
    { name: 'crm_search', description: 'Busca contactos del CRM por texto (nombre, email, teléfono, empresa) y/o estado, o los que llevan N días sin actualizarse.', schema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string' }, staleDays: { type: 'number' }, limit: { type: 'number' } } } },
    { name: 'crm_get', description: 'Lee un contacto del CRM por id.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'crm_update', description: 'Actualiza campos de un contacto del CRM (dispara las reglas de flujo).', schema: { type: 'object', properties: { id: { type: 'string' }, fields: agentFieldSchema(fields) }, required: ['id', 'fields'] } },
    { name: 'crm_create', description: 'Crea un contacto en el CRM.', schema: { type: 'object', properties: { fields: agentFieldSchema(fields) }, required: ['fields'] } },
    { name: 'send_email', description: 'Envía un email a una persona.', schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
    { name: 'send_telegram', description: 'Envía un mensaje de Telegram a un chat con uno de los bots de la empresa (por defecto, el canal de informes).', schema: { type: 'object', properties: { chatId: { type: 'number' }, botId: { type: 'string' }, text: { type: 'string' }, buttons: { type: 'array', items: { type: 'string' } } }, required: ['text'] } },
    { name: 'run_function', description: 'Ejecuta una función JavaScript de la empresa por su nombre API, opcionalmente con un contacto.', schema: { type: 'object', properties: { apiName: { type: 'string' }, recordId: { type: 'string' } }, required: ['apiName'] } },
  ];
}

/** Ejecuta la acción de verdad (ya autorizada). */
async function performTool(bot, name, args, { routes, runId }) {
  const tid = bot.tenantId;
  switch (name) {
    case 'search_knowledge': { const hits = await searchKnowledge(bot._id, args.query); return hits.length ? hits.map((h, i) => `[${i + 1}] ${h.title}: ${h.text}`).join('\n\n') : 'Sin resultados en los documentos de formación.'; }
    case 'test_approval': return 'Aprobación de prueba completada: los canales funcionan. No se ha cambiado nada.';
    case 'analyze_document': {
      let id = args.ref ? docRef(args.ref) : null;
      if (!id && args.url) id = String((await storeDocument(bot, { url: args.url, source: 'url', autoProcess: false }))._id);
      if (!id) throw new Error('Indica ref o url');
      const rt = await getBotRuntime(bot._id); const a = await analyzeDocument(rt, id, args.goal);
      await WorkerFile.updateOne({ _id: id }, { $addToSet: { runIds: runId } });
      return JSON.stringify(a);
    }
    case 'list_documents': {
      const st = args.status || 'new'; const q = { botId: bot._id, ...(st === 'all' ? {} : { status: st === 'new' ? { $in: ['new', 'analyzed'] } : st }) };
      const rows = await WorkerFile.find(q).sort({ createdAt: -1 }).limit(30).lean();
      return rows.length ? JSON.stringify(rows.map((f) => ({ ref: `doc:${f._id}`, name: f.name, mime: f.mime, status: f.status, source: f.source, type: f.analysis?.documentType, summary: f.analysis?.summary?.slice(0, 200), at: f.createdAt }))) : 'No hay documentos con ese estado.';
    }
    case 'mark_document': await WorkerFile.updateOne({ _id: docRef(args.ref), botId: bot._id }, { status: args.status, note: args.note ? String(args.note).slice(0, 1000) : undefined }); return 'Documento marcado.';
    case 'save_memory': await Bot.updateOne({ _id: bot._id }, { $push: { 'worker.memory': { $each: [{ text: String(args.text).slice(0, 500), source: 'agent', at: new Date() }], $slice: -200 } } }); return 'Aprendizaje guardado.';
    case 'report': await deliverReport(bot, { title: args.title, body: args.body, urgent: args.urgent, runId }); return 'Aviso enviado al responsable.';
    case 'ask_human': await deliverReport(bot, { title: `❓ ${String(args.question).slice(0, 120)}`, body: args.question, buttons: args.options, question: true, runId }); return 'Pregunta enviada. Su respuesta te llegará como nueva tarea; no la esperes en esta ejecución.';
    case 'schedule_followup': {
      const at = new Date(args.runAt); if (Number.isNaN(+at) || at < new Date()) return 'Fecha inválida o pasada.';
      await Q.workers.add('followup', { botId: String(bot._id), instruction: String(args.instruction).slice(0, 2000) }, { delay: at - Date.now(), attempts: 2 });
      return `Seguimiento programado para ${at.toLocaleString('es-ES', { timeZone: bot.worker?.autonomy?.workingHours?.tz || 'Europe/Madrid' })}.`;
    }
    case 'crm_search': {
      const q = { tenantId: tid };
      if (args.status) q['data.status'] = args.status;
      if (args.staleDays) q.updatedAt = { $lt: new Date(Date.now() - Number(args.staleDays) * 86400000) };
      if (args.query) { const rx = new RegExp(String(args.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); q.$or = ['name', 'email', 'phone', 'company'].map((k) => ({ [`data.${k}`]: rx })); }
      const rows = await CrmRecord.find(q).sort({ updatedAt: -1 }).limit(Math.min(Number(args.limit) || 20, 50)).lean();
      return JSON.stringify(rows.map((r) => ({ id: String(r._id), ...r.data, updatedAt: r.updatedAt })));
    }
    case 'crm_get': { const r = await CrmRecord.findOne({ _id: args.id, tenantId: tid }).lean(); return r ? JSON.stringify({ id: String(r._id), ...r.data, updatedAt: r.updatedAt }) : 'No existe.'; }
    case 'crm_update': { const r = await saveRecord({ tenantId: tid, id: args.id, data: args.fields || {}, by: 'agent', agentId: bot._id }); return `Actualizado (${Object.keys(r.changes).join(', ') || 'sin cambios'}).`; }
    case 'crm_create': { const r = await saveRecord({ tenantId: tid, data: { source: 'Manual', status: 'Nuevo', ...args.fields }, by: 'agent', agentId: bot._id }); return `Creado contacto ${r.record._id}.`; }
    case 'send_email': await Q.email.add('send', { to: args.to, subject: String(args.subject).slice(0, 200), title: String(args.subject).slice(0, 200), body: String(args.body).slice(0, 20000).replace(/\n/g, '<br>') }, { attempts: 4 }); return `Email a ${args.to} en cola.`;
    case 'send_telegram': {
      const botId = args.botId || bot.worker?.reporting?.telegramBotId; const chatId = args.chatId || bot.worker?.reporting?.chatId;
      const tg = botId ? await Bot.findOne({ _id: botId, tenantId: tid, kind: 'telegram' }).lean() : null; if (!tg || !chatId) throw new Error('No hay bot/chat de Telegram configurado');
      await Q.inbound.add('api-send', { botId: String(tg._id), chatIds: [Number(chatId)], mode: 'message', text: String(args.text).slice(0, 4000), buttons: args.buttons }, { attempts: 3 });
      return 'Mensaje de Telegram en cola.';
    }
    case 'run_function': {
      const fn = await CrmFunction.findOne({ tenantId: tid, apiName: args.apiName }).select('+envEnc').lean(); if (!fn) throw new Error('Función no encontrada');
      let record = {}; if (args.recordId) { const r = await CrmRecord.findOne({ _id: args.recordId, tenantId: tid }).lean(); if (r) record = { id: String(r._id), ...r.data }; }
      const out = await runFunction({ fn, tenantId: tid, recordId: args.recordId, trigger: 'worker', input: { record, ctx: { event: 'worker', by: 'agent', agentId: String(bot._id) } } });
      if (out.status === 'error') throw new Error(out.error); return short(out.result, 2000);
    }
    default: {
      const route = routes?.get(name); if (!route) throw new Error(`Herramienta desconocida ${name}`);
      const r = await callTool(route, args); if (r.isError) throw new Error(r.text);
      const refs = [];
      for (const f of (r.files || []).slice(0, 5)) {
        try {
          const mime = guessMime(f.name || 'archivo', f.mime);
          if (f.data && isSupported(mime)) refs.push({ name: f.name, ref: `doc:${(await storeDocument(bot, { name: f.name, mime, buffer: Buffer.from(f.data, 'base64'), source: 'connector', note: `Devuelto por ${name}`, autoProcess: false }))._id}` });
          else if (f.uri && /^https?:\/\//.test(f.uri)) refs.push({ name: f.name, url: f.uri });
        } catch (e) { refs.push({ name: f.name, error: e.message }); }
      }
      return refs.length ? `${r.text}\n\nDocumentos encontrados (puedes analizarlos con analyze_document): ${JSON.stringify(refs)}` : r.text;
    }
  }
}

/* ───────── Informes y aprobaciones por el canal del responsable ───────── */
async function deliverReport(bot, { title, body, urgent, buttons, question, runId }) {
  let markup;
  if (question && buttons?.length && bot.worker?.reporting?.telegramBotId) {
    const { inlineKeyboard } = await import('../../telegram/buttons.js');
    // Las respuestas a preguntas del empleado vuelven a él como tarea
    const kb = await inlineKeyboard(bot.worker.reporting.telegramBotId, bot.worker.reporting.chatId, buttons, { question: String(body) });
    if (kb) { markup = kb.markup; await redis.set(`wk:q:${bot.worker.reporting.telegramBotId}:${kb.id}`, String(bot._id), 'EX', 7 * 86400); }
  }
  const results = await fanOutReport(bot, { title, body: `${body}${question && buttons?.length ? `\n\nOpciones: ${buttons.join(' · ')}` : ''}`, urgent, kind: question ? 'questions' : 'reports', markup }).catch((e) => [{ channel: 'todos', ok: false, error: e.message }]);
  const bad = (results || []).filter((r) => !r.ok && !r.skipped);
  botLog(bot._id, bad.length ? 'warn' : 'info', 'worker.report', `Informe «${String(title).slice(0, 80)}» → ${(results || []).map((r) => `${r.channel} ${r.ok ? '✓' : `✗ ${r.error}`}`).join(' · ')}`);
  await WorkerMessage.create({ botId: bot._id, role: 'assistant', text: `**${title}**\n${body}`, runId, expiresAt: daysFromNow(90) }).catch(() => {});
  return (results || []).map((r) => ({ channel: r.channel, ok: !!r.ok, info: r.info, error: r.error }));
}
async function requestApproval(bot, { runId, name, args, category, reason }) {
  const ttl = bot.worker?.autonomy?.approvalTtlHours || 48; const tok = newDecisionToken();
  const amount = findAmount(args); const departmentId = bot.worker?.departmentId;
  const policy = await matchPolicy(bot.tenantId, { app: 'juntialagents', agentId: bot._id, departmentId, category, tool: name, amount }).catch(() => null);
  const a = await WorkerApproval.create({ tenantId: bot.tenantId, botId: bot._id, runId, status: 'pending', tool: name, label: humanLabel(name, args), category, args, reason: String(reason || '').slice(0, 1500), tokenHash: tok.hash, amount, departmentId, expiresAt: new Date(Date.now() + Math.max(ttl, policy ? policy.steps.reduce((t, x) => t + (x.timeoutHours || 24) * 3, 0) : 0) * 3600000) });
  // Con política: cadena de aprobadores con enlaces personales. Sin política: decide cualquier responsable.
  if (policy) await startPolicyApproval(a, policy, { bot, departmentId, amount }).catch((e) => logger.warn({ err: e.message }, 'Política de aprobación falló'));
  await fanOutApproval(bot, await WorkerApproval.findById(a._id).lean(), tok.raw, { policy: !!policy }).catch((e) => logger.warn({ err: e.message }, 'Aprobación: algún canal falló'));
  return a;
}

/** Aprobar o rechazar (desde el panel, la API o el botón de Telegram). El rechazo se convierte en aprendizaje. */
/** Aprobación de prueba: llega a todos los canales y se puede decidir desde cualquiera; aprobarla no cambia nada. */
export async function sendTestApproval(bot) {
  const tok = newDecisionToken();
  const a = await WorkerApproval.create({ tenantId: bot.tenantId, botId: bot._id, status: 'pending', tool: 'test_approval', label: 'Aprobación de prueba (no cambia nada)', category: 'internal', args: { prueba: true }, reason: 'Comprobar que los canales de aprobación funcionan.', tokenHash: tok.hash, expiresAt: new Date(Date.now() + 24 * 3600000) });
  const { fanOutApproval } = await import('./channels.js');
  return { approvalId: String(a._id), results: await fanOutApproval(bot, a, tok.raw, { direct: true }) };
}

export async function decideApproval(approvalId, { approve, by, via = 'panel', feedback, remember, actor, system }) {
  // Aprobaciones con política: cada persona vota en su paso; solo al completarse la cadena se ejecuta (o se rechaza)
  const pre = await WorkerApproval.findById(approvalId).lean();
  if (pre?.steps?.length && !system) {
    const r = await decidePolicyStep(pre, { approve, actor: actor || {}, via, feedback, bot: await Bot.findById(pre.botId).lean() });
    if (!r.ok) return r;
    if (r.final === null) return { ok: true, status: 'pending', info: r.info, by: r.by };
    approve = r.final === 'approved'; by = r.by;
  }
  const a = await WorkerApproval.findOneAndUpdate({ _id: approvalId, status: 'pending', expiresAt: { $gt: new Date() } }, { status: approve ? 'approved' : 'rejected', decidedBy: by, decidedVia: via, decidedAt: new Date(), feedback }, { new: true });
  if (!a) return { ok: false, error: 'Ya decidida o caducada' };
  if (approve && remember && a.tool !== 'test_approval') await Bot.updateOne({ _id: a.botId }, { $set: { [`worker.autonomy.toolOverrides.${a.tool}`]: 'auto' } });
  const bot = await Bot.findById(a.botId).lean();
  if (!approve) {
    const lesson = feedback ? `El responsable rechazó «${a.label.slice(0, 120)}»: ${feedback}` : `El responsable rechazó «${a.label.slice(0, 160)}». Evita proponer acciones parecidas sin un motivo claro.`;
    await Bot.updateOne({ _id: a.botId }, { $push: { 'worker.memory': { $each: [{ text: lesson, source: 'feedback', at: new Date() }], $slice: -200 } } });
    await WorkerRun.updateOne({ _id: a.runId }, { $push: { steps: { t: Date.now(), kind: 'decision', name: a.tool, result: `Rechazada por ${by} (${via})${feedback ? `: ${feedback}` : ''}` } } });
    syncDecision(a, { status: 'rejected', by, via }).catch(() => {});
    publish(a.tenantId, 'approval.decided', { approvalId: String(a._id), label: a.label, status: 'rejected', by, via }, { app: 'juntialagents', actor: by });
    return { ok: true, status: 'rejected' };
  }
  const { routes } = await loadTools(bot.mcpServerIds || []);
  try {
    const result = await performTool(bot, a.tool, a.args, { routes, runId: a.runId });
    await WorkerApproval.updateOne({ _id: a._id }, { status: 'executed', result: short(result, 2000) });
    await WorkerRun.updateOne({ _id: a.runId }, { $push: { steps: { t: Date.now(), kind: 'decision', name: a.tool, result: `Aprobada por ${by} (${via}) y ejecutada: ${short(result, 300)}` } } });
    botLog(bot._id, 'info', 'worker.approved', `Aprobada por ${by} (${via}) y ejecutada: ${a.label}`);
    syncDecision(a, { status: 'executed', by, via, result: short(result, 500) }).catch(() => {});
    publish(a.tenantId, 'approval.decided', { approvalId: String(a._id), label: a.label, status: 'executed', by, via }, { app: 'juntialagents', actor: by });
    return { ok: true, status: 'executed', result };
  } catch (e) {
    await WorkerApproval.updateOne({ _id: a._id }, { status: 'failed', result: e.message });
    syncDecision(a, { status: 'failed', by, via, error: e.message }).catch(() => {});
    // El responsable ya dio el visto bueno a la intención: el empleado corrige los parámetros y lo reintenta
    if (a.tool !== 'test_approval') await Q.workers.add('followup', { botId: String(a.botId), instruction: `Tu responsable aprobó «${a.label}», pero al ejecutarla falló con este error: ${e.message}\nParámetros usados: ${JSON.stringify(a.args).slice(0, 1500)}\nCorrige los parámetros (revisa los obligatorios del esquema) y vuelve a intentarlo. Si sigue requiriendo aprobación, propónla de nuevo explicando la corrección.` }, { attempts: 1 }).catch(() => {});
    return { ok: false, status: 'failed', error: e.message };
  }
}

/* ───────── Instrucciones del puesto ───────── */
function systemFor(bot, { trigger, recent, pending, memory, chat }) {
  const w = bot.worker || {}; const pol = w.autonomy?.policy || {};
  const P = { auto: 'puedes hacerlo por tu cuenta', approve: 'debes proponerlo: se pedirá aprobación automáticamente al usarlo', off: 'PROHIBIDO, no lo intentes' };
  const tz = w.autonomy?.workingHours?.tz || 'Europe/Madrid';
  const now = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date());
  const fixed = [
    `Eres ${w.title || bot.name}, un empleado digital de la empresa. Trabajas de forma proactiva, como un profesional responsable.`,
    w.mission ? `## Misión\n${w.mission}` : '', w.responsibilities ? `## Responsabilidades\n${w.responsibilities}` : '', w.kpis ? `## Objetivos\n${w.kpis}` : '',
    `## Autonomía (respétala siempre)\n${Object.entries(CATEGORIES).map(([k, c]) => `- ${c.label} (${c.desc}): ${P[pol[k] || 'approve']}.`).join('\n')}`,
    '## Documentos\n- Si te encuentras un documento (adjunto de un conector, enlace a un PDF, archivo en tu bandeja), analízalo con analyze_document antes de decidir y procésalo según tus reglas de documentos. Comprueba las incidencias que detecte antes de actuar.',
    '## Cómo trabajas\n- Piensa el plan, consulta datos reales antes de decidir y nunca inventes información.\n- Agrupa: no hagas más acciones de las necesarias.\n- Cuando una acción requiera aprobación, explica brevemente en tu texto POR QUÉ la propones justo antes de usarla.\n- Si te falta información o la decisión es delicada, usa ask_human.\n- Si algo requiere volver más tarde, usa schedule_followup.\n- Termina SIEMPRE con un resumen breve para tu responsable: qué revisaste, qué hiciste, qué propusiste y qué queda pendiente. Ese resumen ES el informe que recibe: escríbelo completo en tu último mensaje, no lo dejes en un paso intermedio.\n- Solo si no hay absolutamente nada que reportar, empieza tu resumen con [SIN_NOVEDADES].\n- Si una consulta falla por parámetros, corrígelos según el error y reinténtala antes de rendirte; si los resultados vienen cortados, filtra o pagina.',
    w.knowledge?.instructions ? `## Manual del puesto (procedimientos de la empresa)\n${w.knowledge.instructions}` : '',
    w.knowledge?.examples?.length ? `## Ejemplos de cómo actuar\n${w.knowledge.examples.map((e) => `- Si: ${e.situation}\n  Haz: ${e.action}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const dyn = [
    `## Ahora\n- Fecha y hora: ${now} (${tz}).\n- Motivo de esta ejecución: ${trigger.label}.${chat ? '\n- Estás hablando directamente con tu responsable en el panel: responde de forma conversacional.' : ''}`,
    memory?.length ? `## Lo que has aprendido (memoria)\n${memory.slice(-30).map((m) => `- ${m.text}`).join('\n')}` : '',
    recent?.length ? `## Tus últimas ejecuciones\n${recent.map((r) => `- ${new Date(r.createdAt).toLocaleString('es-ES', { timeZone: tz })} · ${r.trigger?.label}: ${String(r.summary || '').slice(0, 220)}`).join('\n')}` : '',
    pending?.length ? `## Aprobaciones pendientes (no las repitas)\n${pending.map((p) => `- ${p.label}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return { static: fixed, dynamic: dyn };
}

function inWorkingHours(bot) {
  const h = bot.worker?.autonomy?.workingHours; if (!h?.enabled) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: h.tz || 'Europe/Madrid', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[parts.weekday]; const hm = `${parts.hour}:${parts.minute}`;
  return (h.days || []).includes(day) && hm >= (h.start || '00:00') && hm <= (h.end || '23:59');
}

/**
 * Una "jornada" del empleado digital: entiende el motivo, planifica, consulta, actúa según su autonomía y
 * deja trazado cada paso. trigger.type: schedule | event | followup | answer | manual | chat
 */
import { withTrace, getTrace } from '../../lib/trace.js';
export function runWorker(args) { return withTrace({ source: `empleado:${args.trigger?.type}` }, () => runWorkerInner(args)); }
async function runWorkerInner({ botId, trigger, instruction, chatHistory = [], onText, onStep, signal }) {
  const rt = await getBotRuntime(botId); if (!rt || rt.bot.kind !== 'worker') throw new Error('Empleado digital no encontrado');
  const { bot } = rt; const isChat = trigger.type === 'chat';
  const skip = async (why) => { const r = await WorkerRun.create({ tenantId: bot.tenantId, botId, trigger, instruction, status: 'skipped', summary: why, steps: [], expiresAt: daysFromNow(30) }); return { run: r, skipped: why }; };
  if (!rt.aiKey) return skip('Falta la API key de IA');
  if (!isChat && (bot.worker?.paused || bot.status !== 'active')) return skip('Empleado en pausa');
  if (['schedule', 'event'].includes(trigger.type) && !inWorkingHours(bot)) { botLog(botId, 'info', 'worker.skipped', `${trigger.label}: fuera del horario laboral`); return skip('Fuera del horario laboral configurado'); }
  const day = new Date().toISOString().slice(0, 10); const runsKey = `wk:runs:${botId}:${day}`;
  if (!isChat) { const n = await redis.incr(runsKey); if (n === 1) await redis.expire(runsKey, 90000); if (n > (bot.worker?.autonomy?.maxRunsPerDay || 48)) return skip('Límite diario de ejecuciones alcanzado'); }
  const q = await consumeMessage(bot.tenantId); if (!q.allowed) return skip('Cuota de mensajes agotada');
  const lockKey = `wk:lock:${botId}`; const lock = isChat ? null : await acquireLock(lockKey, 600000);
  if (!isChat && !lock) { if (trigger.type === 'schedule') return skip('Ya había otra ejecución en curso'); const e = new Error('ocupado'); e.busy = true; throw e; }
  const keep = lock ? setInterval(() => extendLock(lockKey, lock, 600000), 60000) : null;

  const t0 = Date.now(); const steps = []; const fullResults = new Map(); let actions = 0; let approvals = 0; let lastThought = '';
  const run = await WorkerRun.create({ tenantId: bot.tenantId, botId, trigger: { ...trigger, ref: trigger.ref || getTrace()?.traceId }, instruction, status: 'running', steps: [], expiresAt: daysFromNow(90) });
  const step = (s) => { steps.push({ t: Date.now() - t0, ...s }); onStep?.(s); if (s.kind !== 'thought') botLog(botId, s.kind === 'error' ? 'warn' : 'info', `worker.${s.kind}`, `${s.name || ''}${s.result ? ` → ${String(s.result).slice(0, 200)}` : ''}`, { category: s.category, policy: s.policy, ms: s.ms }); };
  try {
    const [recent, pending, { tools: mcpTools, routes }, own] = await Promise.all([
      WorkerRun.find({ botId, status: { $in: ['done', 'waiting'] }, _id: { $ne: run._id } }).sort({ createdAt: -1 }).limit(5).select('trigger summary createdAt').lean(),
      WorkerApproval.find({ botId, status: 'pending' }).sort({ createdAt: -1 }).limit(15).select('label').lean(),
      loadTools(bot.mcpServerIds || []), workerTools(bot),
    ]);
    // Herramientas prohibidas por la autonomía ni siquiera se ofrecen (menos tentación, menos tokens)
    const annot = new Map(mcpTools.map((t) => [t.name, t.annotations]));
    const allowed = (t) => policyFor(bot, t.name, categorize(t.name, t.annotations)) !== 'off';
    const maxActions = bot.worker?.autonomy?.maxActionsPerRun || 15;
    const exec = async (name, args) => {
      const category = categorize(name, annot.get(name)); const policy = policyFor(bot, name, category); const t1 = Date.now();
      if (policy === 'off') { step({ kind: 'blocked', name, category, policy, args }); return { isError: true, text: 'Acción prohibida por tu configuración de autonomía.' }; }
      if (category !== 'read' && ++actions > maxActions) { step({ kind: 'blocked', name, category, result: 'Límite de acciones por ejecución' }); return { isError: true, text: `Límite de ${maxActions} acciones por ejecución alcanzado. Resume y termina.` }; }
      if (policy === 'approve') {
        const a = await requestApproval(bot, { runId: run._id, name, args, category, reason: lastThought }); approvals++;
        step({ kind: 'approval', name, category, policy, args, result: `Pendiente de aprobación (#${String(a._id).slice(-6)})` });
        return { text: `Acción enviada a tu responsable para aprobación (#${String(a._id).slice(-6)}). No la repitas; continúa con lo demás.` };
      }
      try { const out = await performTool(bot, name, args, { routes, runId: run._id }); step({ kind: 'tool', name, category, policy, args, result: short(out), ms: Date.now() - t1 }); fullResults.set(steps.length - 1, String(out)); return { text: String(out) }; }
      catch (e) { step({ kind: 'error', name, category, args, result: e.message, ms: Date.now() - t1 }); return { isError: true, text: `${e.message}\nRevisa los parámetros obligatorios del esquema de la herramienta y vuelve a intentarlo con los datos corregidos (si no es posible, explica por qué).` }; }
    };
    const turns = [...chatHistory, { role: 'user', parts: [{ type: 'text', text: instruction }] }];
    const result = await runAgent({
      bot: { ...bot, ai: { ...bot.ai, maxToolSteps: Math.max(bot.ai?.maxToolSteps || 8, 16), maxTokens: Math.max(bot.ai?.maxTokens || 1500, 8000) } },
      apiKey: rt.aiKey, system: systemFor(bot, { trigger, recent, pending, memory: bot.worker?.memory, chat: isChat }),
      turns, tools: own.filter(allowed), mcpTools: mcpTools.filter(allowed), hot: { bot: `hot:bot:${botId}`, chat: `hot:worker:${botId}` },
      exec, signal, onText,
      onStep: (s) => { lastThought = s; step({ kind: 'thought', result: s }); },
    });
    // Resumen vacío (p. ej. agotó los pasos consultando): se le pide el informe final sin herramientas con lo obtenido
    if (result.text.trim().length < 400 && /^(las respuestas|voy a|vuelvo a|procedo a|ahora voy)/i.test(result.text.trim())) { botLog(botId, 'warn', 'worker.summary.incomplete', `Resumen incompleto («${result.text.trim().slice(0, 80)}»): se genera el informe con lo consultado`); result.text = ''; }
    if (!result.text.trim() && !signal?.aborted) {
      const digest = steps.map((x, i) => ({ ...x, full: fullResults.get(i) })).filter((x) => ['tool', 'error', 'approval', 'blocked'].includes(x.kind)).map((x) => `- ${x.kind} ${x.name || ''}: ${String(x.full || x.result || '').slice(0, 6000)}`).join('\n').slice(0, 60000);
      try {
        const fin = await runAgent({ bot: { ...bot, ai: { ...bot.ai, maxToolSteps: 0, maxTokens: Math.max(bot.ai?.maxTokens || 1500, 8000) } }, apiKey: rt.aiKey, system: systemFor(bot, { trigger, recent: [], pending: [], memory: bot.worker?.memory, chat: isChat }),
          turns: [{ role: 'user', parts: [{ type: 'text', text: `Encargo: ${instruction}\n\nEsto es lo que obtuviste en tus consultas:\n${digest || '(nada)'}\n\nRedacta AHORA el informe final para tu responsable con lo que tienes (sin usar herramientas). Si algún dato no se pudo obtener, indícalo.` }] }], tools: [], mcpTools: [], exec: async () => ({ text: '' }) });
        result.text = fin.text || ''; botLog(botId, 'warn', 'worker.summary.recovered', 'La tarea terminó sin resumen; se generó el informe final a partir de lo consultado');
      } catch (e) { botLog(botId, 'error', 'worker.summary.failed', e.message); }
    }
    // [SIN_NOVEDADES] solo cuenta si el resumen es de verdad breve: si trae avisos, se ignora la marca y se informa
    const NO_NEWS = /^\s*\[SIN_NOVEDADES\]\s*/i; const marked = NO_NEWS.test(result.text); result.text = result.text.replace(NO_NEWS, '').replace(/^(no aplica|n\/a)[.:]?\s*/i, '');
    const noNews = marked && result.text.length < 300 && !/\b(HOY|URGENTE|ESTA SEMANA|vencid|atrasad|falta)/i.test(result.text);
    const status = approvals ? 'waiting' : 'done';
    await WorkerRun.updateOne({ _id: run._id }, { status, summary: result.text.slice(0, 6000), steps, actions, approvals, usage: result.usage, ms: Date.now() - t0, endedAt: new Date() });
    // Informe al responsable (si hubo algo relevante o si lo pide la configuración)
    // Las rutinas, encargos y eventos SIEMPRE informan (revisar e informar es su trabajo). Con «solo si es relevante»,
    // únicamente se omite cuando el propio empleado indica [SIN_NOVEDADES] y no hizo ni propuso nada.
    const quiet = bot.worker?.reporting?.onlyWhenRelevant !== false && noNews && !actions && !approvals;
    let report = { sent: false, noNews, delivery: [] };
    if (!isChat && !quiet && result.text.trim()) { report.delivery = await deliverReport(bot, { title: trigger.label, body: `${result.text.slice(0, 3500)}${approvals ? `\n\n🟡 ${approvals} acción(es) esperan tu aprobación.` : ''}`, runId: run._id }) || []; report.sent = report.delivery.some((d) => d.ok); }
    else if (!isChat) { report.reason = quiet ? 'Sin novedades' : 'Sin texto que enviar'; botLog(botId, 'info', 'worker.report.skipped', `${trigger.label}: ${report.reason.toLowerCase()}`); }
    else report.reason = 'Conversación en el panel';
    await WorkerRun.updateOne({ _id: run._id }, { report });
    publish(bot.tenantId, 'worker.run.completed', { agentId: String(botId), runId: String(run._id), trigger: trigger.label, status, actions, approvals }, { app: 'juntialagents' });
    botLog(bot._id, 'info', 'worker.run', `${trigger.label}: ${steps.filter((s) => s.kind === 'tool').length} acciones, ${approvals} aprobaciones, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return { run: { ...run.toObject(), status, summary: result.text, steps }, text: result.text };
  } catch (e) {
    await WorkerRun.updateOne({ _id: run._id }, { status: 'error', summary: e.message, steps, ms: Date.now() - t0, endedAt: new Date() });
    botLog(bot._id, 'error', 'worker.error', e.message); throw e;
  } finally { clearInterval(keep); if (lock) await releaseLock(lockKey, lock); }
}

/* ───────── Programación de rutinas ───────── */
export async function syncRoutine(r) {
  await Q.workers.removeJobScheduler(`wr-${r._id}`).catch(() => {});
  if (r.enabled) await Q.workers.upsertJobScheduler(`wr-${r._id}`, { pattern: r.cron, tz: r.timezone || 'Europe/Madrid' }, { name: 'routine', data: { routineId: String(r._id) }, opts: { attempts: 1 } });
}
export async function processWorkerJob(job, token) {
  const d = job.data;
  try {
    if (job.name === 'routine') {
      const r = await WorkerRoutine.findById(d.routineId).lean(); if (!r?.enabled) return;
      const out = await runWorker({ botId: r.botId, trigger: { type: 'schedule', label: `Rutina «${r.name}»`, ref: String(r._id) }, instruction: r.instruction });
      await WorkerRoutine.updateOne({ _id: r._id }, { lastRunAt: new Date(), lastStatus: out.skipped ? `omitida: ${out.skipped}` : 'ok', $inc: { runs: 1 } });
    }
    if (job.name === 'approval-timeouts') { const { processApprovalTimeouts } = await import('../center/approvals.js'); return processApprovalTimeouts(); }
    if (job.name === 'event') return await runWorker({ botId: d.botId, trigger: { type: d.manual ? 'manual' : 'event', label: d.label || 'Evento del CRM', ref: d.recordId }, instruction: d.instruction });
    if (job.name === 'followup') return await runWorker({ botId: d.botId, trigger: { type: 'followup', label: 'Seguimiento programado' }, instruction: d.instruction });
    if (job.name === 'answer') return await runWorker({ botId: d.botId, trigger: { type: 'answer', label: 'Respuesta de tu responsable' }, instruction: `Tu responsable ha respondido a tu pregunta «${d.question}»: ${d.answer}. Continúa con lo que corresponda.` });
  } catch (e) {
    // Empleado ocupado con otra tarea: esta espera su turno (cada 30 s, hasta 2 h) en vez de perderse
    if (e.busy) {
      const tries = (d.waits || 0) + 1;
      if (tries > 240) { botLog(d.botId, 'error', 'worker.dropped', `«${d.label || job.name}» descartada: el empleado estuvo ocupado más de 2 horas`); return { dropped: true }; }
      if (tries === 1) botLog(d.botId, 'info', 'worker.queued', `«${d.label || job.name}» en espera: el empleado está terminando otra tarea`);
      await job.updateData({ ...d, waits: tries });
      const { DelayedError } = await import('bullmq'); await job.moveToDelayed(Date.now() + 30000, token); throw new DelayedError();
    }
    throw e;
  }
}
