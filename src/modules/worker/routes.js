import { env } from '../../config/env.js';
import { Router } from 'express';
import { z } from 'zod';
import { Bot, WorkerRoutine, WorkerDoc, WorkerRun, WorkerApproval, WorkerMessage, WorkerFile, WorkerLink, daysFromNow } from '../../models/index.js';
import { storeDocument, analyzeDocument, MAX_BYTES } from './documents.js';
import { getBotRuntime } from '../../telegram/runtime.js';
import { asyncH, notFound, badRequest } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { tenantScope } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { encrypt, decrypt, randomToken } from '../../lib/crypto.js';
import { fanOutReport } from './channels.js';
import { Q } from '../../lib/queues.js';
import { bumpBotVersion } from '../../telegram/runtime.js';
import { loadTools } from '../mcp/client.js';
import { safeUrl } from '../crm/net.js';
import { validateCron } from '../tasks/scheduler.js';
import { ROLES, AUTONOMY_PRESETS, CATEGORIES } from './roles.js';
import { chunkText, htmlToText } from './knowledge.js';
import { runWorker, decideApproval, syncRoutine, categorize, policyFor, sendTestApproval } from './engine.js';
import { renderBlueprint, blueprintCompleteness, BLUEPRINT_SECTIONS } from './blueprint.js';
import { runOnboardingCheck, saveOnboardingResult } from './onboarding.js';

/** Panel del empleado digital: /api/bots/:botId/worker/* */
const r = Router({ mergeParams: true });
const SECRET = '+worker.reporting.webhook.secretEnc';
const find = async (req, sel = '') => { const b = await Bot.findOne({ _id: req.params.botId, kind: 'worker', ...tenantScope(req) }).select(sel); if (!b) throw notFound('Empleado digital'); return b; };
const done = async (b) => { await b.save(); await bumpBotVersion(b._id); return b; };

r.get('/meta', asyncH(async (_req, res) => res.json({ roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, icon: v.icon, preset: v.preset }])), presets: AUTONOMY_PRESETS, categories: CATEGORIES })));

r.put('/', validate(z.object({
  title: z.string().max(80), mission: z.string().max(2000), responsibilities: z.string().max(5000), kpis: z.string().max(2000), paused: z.boolean(),
  documents: z.object({ autoProcess: z.boolean(), fallback: z.string().max(2000), rules: z.array(z.object({ type: z.string().min(1).max(80), how: z.string().min(1).max(3000), fields: z.array(z.string().max(60)).max(40).default([]) })).max(30) }).partial(),
  knowledge: z.object({ instructions: z.string().max(30000), examples: z.array(z.object({ situation: z.string().max(500), action: z.string().max(1000) })).max(50) }).partial(),
  autonomy: z.object({
    preset: z.string(), policy: z.object(Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, z.enum(['auto', 'approve', 'off'])]))).partial(),
    toolOverrides: z.record(z.enum(['auto', 'approve', 'off'])), maxActionsPerRun: z.number().int().min(1).max(100), maxRunsPerDay: z.number().int().min(1).max(500), approvalTtlHours: z.number().int().min(1).max(720),
    workingHours: z.object({ enabled: z.boolean(), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), days: z.array(z.number().int().min(0).max(6)), tz: z.string() }).partial(),
  }).partial(),
  departmentId: z.string().nullable(),
  proactive: z.object({ enabled: z.boolean(), everyHours: z.number().min(1).max(24) }).partial(),
  channels: z.object({ telegramChat: z.boolean(), pages: z.boolean(), api: z.boolean() }).partial(),
  style: z.enum(['corto', 'detallado']),
  approvalRule: z.object({ mode: z.enum(['any', 'all', 'quorum']), quorum: z.number().int().min(1).max(20), onlyApprovers: z.boolean() }).partial(),
  reporting: z.object({
    telegramBotId: z.string().nullable(), chatId: z.number().nullable(), notifyPanel: z.boolean(), onlyWhenRelevant: z.boolean(),
    email: z.object({ enabled: z.boolean(), to: z.array(z.string().email()).max(10), events: z.array(z.enum(['approvals', 'reports', 'questions'])) }).partial(),
    webhook: z.object({ enabled: z.boolean(), url: z.string().url().startsWith('https://', 'El webhook debe ser https').or(z.literal('')), events: z.array(z.enum(['approvals', 'decisions', 'reports', 'questions'])) }).partial(),
  }).partial(),
}).partial()), asyncH(async (req, res) => {
  const b = await find(req, SECRET); const w = b.worker.toObject ? b.worker.toObject() : b.worker; const body = req.body;
  if (body.reporting?.telegramBotId && !(await Bot.exists({ _id: body.reporting.telegramBotId, tenantId: b.tenantId, kind: 'telegram' }))) throw badRequest('Bot de Telegram no válido');
  b.worker = {
    ...w, ...(body.departmentId !== undefined ? { departmentId: body.departmentId || undefined } : {}), ...['title', 'mission', 'responsibilities', 'kpis', 'paused'].reduce((o, k) => (body[k] !== undefined ? { ...o, [k]: body[k] } : o), {}),
    knowledge: { ...w.knowledge, ...body.knowledge },
    approvalRule: { ...w.approvalRule, ...body.approvalRule }, proactive: { ...w.proactive, ...body.proactive }, channels: { ...w.channels, ...body.channels }, ...(body.style ? { style: body.style } : {}),
    documents: { ...w.documents, ...body.documents },
    autonomy: { ...w.autonomy, ...body.autonomy, policy: { ...w.autonomy?.policy, ...body.autonomy?.policy }, workingHours: { ...w.autonomy?.workingHours, ...body.autonomy?.workingHours }, toolOverrides: body.autonomy?.toolOverrides ?? w.autonomy?.toolOverrides },
    reporting: { ...w.reporting, ...body.reporting,
      telegramBotId: body.reporting?.telegramBotId === null ? undefined : body.reporting?.telegramBotId ?? w.reporting?.telegramBotId,
      chatId: body.reporting?.chatId === null ? undefined : body.reporting?.chatId ?? w.reporting?.chatId,
      email: { ...w.reporting?.email, ...body.reporting?.email },
      webhook: { ...w.reporting?.webhook, ...body.reporting?.webhook, secretEnc: w.reporting?.webhook?.secretEnc || (body.reporting?.webhook?.enabled ? encrypt(`whsec_${randomToken(24)}`) : undefined) } },
  };
  b.markModified('worker'); await done(b); audit(req, 'worker.update', { kind: 'bot', id: b.id }, { fields: Object.keys(body) });
  if (body.proactive) { const { syncHeartbeat } = await import('./engine.js'); await syncHeartbeat(b.toObject()); }
  const out = b.toObject(); if (out.worker?.reporting?.webhook) delete out.worker.reporting.webhook.secretEnc; res.json(out);
}));

/* Equipo: compañeros y colaboradores del empleado, con sus canales */
const personSchema = z.object({
  _id: z.string().optional(), name: z.string().min(1).max(80), role: z.string().max(80).optional().default(''),
  relation: z.enum(['responsable', 'compañero', 'colaborador', 'externo']).default('compañero'),
  email: z.string().email().or(z.literal('')).optional(), telegramUsername: z.string().max(40).optional().default(''), telegramChatId: z.number().nullable().optional(),
  phone: z.string().max(30).optional().default(''), canApprove: z.boolean().default(false), notes: z.string().max(400).optional().default(''),
});
r.get('/people', asyncH(async (req, res) => {
  const b = await find(req); const links = await WorkerLink.find({ botId: b._id }).select('personId lastUsedAt').lean();
  res.json((b.worker?.people || []).map((p) => { const o = p.toObject ? p.toObject() : p; const l = links.find((x) => String(x.personId) === String(o._id)); return { ...o, hasLink: !!l, linkLastUsedAt: l?.lastUsedAt }; }));
}));
r.put('/people', validate(z.object({ people: z.array(personSchema).max(100) })), asyncH(async (req, res) => {
  const b = await find(req);
  b.worker.people = req.body.people.map((p) => ({ ...p, email: p.email || undefined, telegramUsername: (p.telegramUsername || '').replace(/^@/, '').toLowerCase() || undefined, telegramChatId: p.telegramChatId || undefined }));
  b.markModified('worker'); await done(b);
  const ids = new Set(b.worker.people.map((p) => String(p._id))); await WorkerLink.deleteMany({ botId: b._id, personId: { $nin: [...ids] } });
  audit(req, 'worker.people.update', { kind: 'bot', id: b.id }, { count: b.worker.people.length }); res.json(b.worker.people);
}));
r.post('/people/:pid/link', asyncH(async (req, res) => {
  const b = await find(req); if (!(b.worker?.people || []).some((p) => String(p._id) === req.params.pid)) throw notFound('Persona');
  const { createPersonLink } = await import('./conversation.js'); const raw = await createPersonLink(b, req.params.pid);
  audit(req, 'worker.people.link', { kind: 'bot', id: b.id }); res.json({ url: `${env.PUBLIC_API_URL}/w/${raw}` });
}));
r.delete('/people/:pid/link', asyncH(async (req, res) => { const b = await find(req); await WorkerLink.deleteMany({ botId: b._id, personId: req.params.pid }); res.json({ ok: true }); }));

/* Memoria de trabajo: pendientes abiertos y diario */
r.get('/memory/work', asyncH(async (req, res) => { const b = await find(req); res.json({ threads: (b.worker?.threads || []).slice(-100).reverse(), journal: (b.worker?.journal || []).slice(-60).reverse() }); }));
r.post('/threads/:tid/close', asyncH(async (req, res) => {
  const b = await find(req); await Bot.updateOne({ _id: b._id, 'worker.threads._id': req.params.tid }, { $set: { 'worker.threads.$.status': 'done', 'worker.threads.$.closedAt': new Date(), 'worker.threads.$.note': `Cerrado por ${req.user.email}` } }); res.json({ ok: true });
}));

/* Hablar con el empleado por API / webhook (respuesta en la misma llamada). Útil desde Make, n8n, un ERP… */
r.post('/message', validate(z.object({ text: z.string().min(1).max(8000), from: z.object({ name: z.string().max(80), email: z.string().email(), telegram: z.string().max(40) }).partial().default({}), conversation: z.string().max(80).optional() })), asyncH(async (req, res) => {
  const b = await find(req); if (b.worker?.channels?.api === false) throw badRequest('La API de conversación está desactivada para este empleado');
  const { identifyPerson, talkToWorker } = await import('./conversation.js');
  const person = identifyPerson(b.toObject(), { email: req.body.from.email, telegramUsername: req.body.from.telegram });
  const conv = `api:${req.body.conversation || person?._id || req.body.from.email || req.body.from.name || 'anon'}`;
  const out = await talkToWorker(b._id, { text: req.body.text, person, channel: 'api', conv, fromName: req.body.from.name });
  res.json({ reply: out.reply, runId: out.runId, person: person ? { id: person._id, name: person.name, canApprove: person.canApprove } : null });
}));

/* El «guion»: configurador estructurado del manual, por secciones en vez de texto libre */
r.get('/blueprint/meta', asyncH(async (_req, res) => res.json({ sections: BLUEPRINT_SECTIONS })));
const blueprintSchema = z.object({
  context: z.string().max(4000), autonomyNotes: z.string().max(4000), reportFormat: z.string().max(2000), queryHints: z.string().max(4000), notes: z.string().max(6000),
  stateField: z.string().max(80), allStateValues: z.string().max(3000), completionRule: z.string().max(1000), automations: z.string().max(4000), dataQuirks: z.string().max(4000),
  variants: z.array(z.object({ name: z.string().min(1).max(80), rule: z.string().min(1).max(1000) })).max(20),
  stages: z.array(z.object({ from: z.string().min(1).max(80), to: z.string().min(1).max(80), requirement: z.string().min(1).max(1000) })).max(40),
  priorities: z.array(z.string().max(300)).max(15),
}).partial();
r.get('/blueprint', asyncH(async (req, res) => { const b = await find(req); const bp = b.worker?.blueprint?.toObject ? b.worker.blueprint.toObject() : (b.worker?.blueprint || {}); res.json({ blueprint: bp, completeness: blueprintCompleteness(bp), preview: renderBlueprint(bp) }); }));
r.put('/blueprint', validate(blueprintSchema), asyncH(async (req, res) => {
  const b = await find(req); const bp = { ...(b.worker.blueprint?.toObject ? b.worker.blueprint.toObject() : b.worker.blueprint || {}), ...req.body };
  b.worker.blueprint = bp; b.worker.knowledge = { ...b.worker.knowledge, instructions: renderBlueprint(bp) };
  b.markModified('worker'); await done(b); audit(req, 'worker.blueprint.update', { kind: 'bot', id: b.id });
  res.json({ blueprint: bp, completeness: blueprintCompleteness(bp), preview: renderBlueprint(bp) });
}));

/* Puesta a punto: verifica contra el conector real qué campos del manual existen de verdad, antes de confiar en el empleado sin supervisión */
r.post('/onboarding/check', asyncH(async (req, res) => {
  const b = await find(req); const result = await runOnboardingCheck(b._id); await saveOnboardingResult(b._id, result); res.json(result);
}));
r.get('/onboarding', asyncH(async (req, res) => { const b = await find(req); res.json(b.worker?.onboarding || null); }));

/* Canales: secreto del webhook y prueba de entrega */
r.get('/reporting/webhook-secret', asyncH(async (req, res) => { const b = await find(req, SECRET); res.json({ secret: decrypt(b.worker?.reporting?.webhook?.secretEnc) || null }); }));
r.post('/reporting/webhook-secret/rotate', asyncH(async (req, res) => {
  const b = await find(req, SECRET); const secret = `whsec_${randomToken(24)}`; b.worker.reporting.webhook.secretEnc = encrypt(secret); b.markModified('worker'); await done(b);
  audit(req, 'worker.webhook.rotate', { kind: 'bot', id: b.id }); res.json({ secret });
}));
// Diagnóstico: envía de verdad a cada canal activo, en el momento, y devuelve qué funcionó y por qué falló cada uno
const forceEvent = (b, ev) => { const r = b.worker?.reporting || {}; return { ...b, worker: { ...b.worker, reporting: { ...r, email: r.email?.enabled ? { ...r.email, events: [...new Set([...(r.email.events || []), ev])] } : r.email, webhook: r.webhook?.enabled ? { ...r.webhook, events: [...new Set([...(r.webhook.events || []), ev])] } : r.webhook } } }; };
r.post('/reporting/test', validate(z.object({ kind: z.enum(['report', 'approval']).default('report') })), asyncH(async (req, res) => {
  const b = (await find(req)).toObject();
  if (req.body.kind === 'approval') { const out = await sendTestApproval(forceEvent(b, 'approvals')); return res.json(out); }
  res.json({ results: await fanOutReport(forceEvent(b, 'reports'), { title: 'Prueba de canales', body: 'Si recibes esto, este canal está bien configurado para avisos y aprobaciones.', kind: 'reports' }, { direct: true }) });
}));

/* Memoria aprendida (legible y editable, como un cuaderno del empleado) */
r.put('/memory', validate(z.object({ memory: z.array(z.object({ text: z.string().min(1).max(500), source: z.string().optional(), at: z.coerce.date().optional() })).max(200) })), asyncH(async (req, res) => {
  const b = await find(req, SECRET); b.worker.memory = req.body.memory.map((m) => ({ text: m.text, source: m.source || 'manual', at: m.at || new Date() })); await done(b); res.json(b.worker.memory);
}));

/* Documentos de formación */
r.get('/docs', asyncH(async (req, res) => { const b = await find(req); res.json(await WorkerDoc.find({ botId: b._id }).select('title source chars createdAt').sort({ createdAt: -1 }).lean()); }));
r.post('/docs', validate(z.object({ title: z.string().max(120).optional(), text: z.string().max(2_000_000).optional(), url: z.string().url().optional() })), asyncH(async (req, res) => {
  const b = await find(req); let { text, title } = req.body; let source = 'texto';
  if (req.body.url) {
    await safeUrl(req.body.url);
    const resp = await fetch(req.body.url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'JuntialAgents-Knowledge/1.0' } });
    if (!resp.ok) throw badRequest(`No se pudo leer la página (${resp.status})`);
    const raw = (await resp.text()).slice(0, 3_000_000); text = /html/i.test(resp.headers.get('content-type') || '') ? htmlToText(raw) : raw; source = req.body.url;
    title ||= raw.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || req.body.url;
  }
  if (!text?.trim()) throw badRequest('El documento está vacío');
  if ((await WorkerDoc.countDocuments({ botId: b._id })) >= 100) throw badRequest('Máximo 100 documentos por empleado');
  const d = await WorkerDoc.create({ tenantId: b.tenantId, botId: b._id, title: (title || 'Documento').slice(0, 120), source, chunks: chunkText(text), chars: text.length });
  res.status(201).json({ _id: d._id, title: d.title, source, chars: d.chars, chunks: d.chunks.length });
}));
r.delete('/docs/:id', asyncH(async (req, res) => { const b = await find(req); await WorkerDoc.deleteOne({ _id: req.params.id, botId: b._id }); res.json({ ok: true }); }));

/* Bandeja de documentos: subir (archivo en base64 o enlace), ver análisis, descargar, reprocesar */
r.get('/files', asyncH(async (req, res) => { const b = await find(req); res.json(await WorkerFile.find({ botId: b._id, ...(req.query.status ? { status: req.query.status } : {}) }).sort({ createdAt: -1 }).limit(200).lean()); }));
r.post('/files', validate(z.object({ name: z.string().max(200).optional(), mime: z.string().max(120).optional(), data: z.string().max(Math.ceil(MAX_BYTES * 1.37)).optional(), url: z.string().url().optional(), note: z.string().max(1000).optional(), source: z.enum(['upload', 'chat', 'api']).optional(), autoProcess: z.boolean().optional() })), asyncH(async (req, res) => {
  const b = (await find(req)).toObject(); if (!req.body.data && !req.body.url) throw badRequest('Envía el archivo (data en base64) o un enlace (url)');
  if ((await WorkerFile.countDocuments({ botId: b._id })) >= 2000) throw badRequest('La bandeja está llena (2.000 documentos)');
  try {
    const f = await storeDocument(b, { name: req.body.name, mime: req.body.mime, buffer: req.body.data ? Buffer.from(req.body.data, 'base64') : null, url: req.body.url, note: req.body.note, source: req.body.source || (req.apiKey ? 'api' : req.body.url ? 'url' : 'upload'), autoProcess: req.body.source === 'chat' ? false : req.body.autoProcess });
    const o = f.toObject(); delete o.data; res.status(201).json(o);
  } catch (e) { throw badRequest(e.message); }
}));
r.get('/files/:id', asyncH(async (req, res) => { const b = await find(req); const f = await WorkerFile.findOne({ _id: req.params.id, botId: b._id }).lean(); if (!f) throw notFound(); res.json(f); }));
r.get('/files/:id/download', asyncH(async (req, res) => {
  const b = await find(req); const f = await WorkerFile.findOne({ _id: req.params.id, botId: b._id }).select('+data').lean(); if (!f) throw notFound();
  res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.send(Buffer.from(f.data.buffer || f.data));
}));
r.post('/files/:id/analyze', asyncH(async (req, res) => { const b = await find(req); const rt = await getBotRuntime(b._id); if (!rt?.aiKey) throw badRequest('Configura antes la API key de IA'); res.json(await analyzeDocument(rt, req.params.id, req.body?.goal)); }));
r.post('/files/:id/process', asyncH(async (req, res) => {
  const b = await find(req); const f = await WorkerFile.findOne({ _id: req.params.id, botId: b._id }).lean(); if (!f) throw notFound();
  await Q.workers.add('event', { botId: String(b._id), label: `Procesar documento: ${f.name}`, manual: true, instruction: `Procesa el documento «${f.name}» (ref doc:${f._id}) según tus reglas de documentos y tu autonomía. Analízalo con analyze_document y márcalo con mark_document al terminar.${req.body?.instruction ? `\nIndicación: ${req.body.instruction}` : ''}` }, { attempts: 2 });
  res.json({ ok: true });
}));
r.delete('/files/:id', asyncH(async (req, res) => { const b = await find(req); await WorkerFile.deleteOne({ _id: req.params.id, botId: b._id }); res.json({ ok: true }); }));

/* Rutinas (diarias, semanales, mensuales…) */
const routineSchema = z.object({ name: z.string().min(2).max(100), cron: z.string(), timezone: z.string().default('Europe/Madrid'), instruction: z.string().min(5).max(8000), enabled: z.boolean().default(true) });
r.get('/routines', asyncH(async (req, res) => { const b = await find(req); res.json(await WorkerRoutine.find({ botId: b._id }).sort({ createdAt: 1 }).lean()); }));
r.post('/routines', validate(routineSchema), asyncH(async (req, res) => {
  const b = await find(req); validateCron(req.body.cron, req.body.timezone);
  const rt = await WorkerRoutine.create({ ...req.body, tenantId: b.tenantId, botId: b._id }); await syncRoutine(rt); res.status(201).json(rt);
}));
r.put('/routines/:id', validate(routineSchema.partial()), asyncH(async (req, res) => {
  const b = await find(req); const rt = await WorkerRoutine.findOne({ _id: req.params.id, botId: b._id }); if (!rt) throw notFound();
  Object.assign(rt, req.body); validateCron(rt.cron, rt.timezone); await rt.save(); await syncRoutine(rt); res.json(rt);
}));
r.delete('/routines/:id', asyncH(async (req, res) => { const b = await find(req); const rt = await WorkerRoutine.findOneAndDelete({ _id: req.params.id, botId: b._id }); if (rt) await syncRoutine({ ...rt.toObject(), enabled: false }); res.json({ ok: true }); }));
r.post('/routines/:id/run', asyncH(async (req, res) => {
  const b = await find(req); const rt = await WorkerRoutine.findOne({ _id: req.params.id, botId: b._id }).lean(); if (!rt) throw notFound();
  await Q.workers.add('event', { botId: String(b._id), instruction: rt.instruction, label: `Rutina «${rt.name}» (manual)`, manual: true }, { attempts: 1 }); res.json({ ok: true });
}));
r.post('/run', validate(z.object({ instruction: z.string().min(3).max(8000) })), asyncH(async (req, res) => {
  const b = await find(req); await Q.workers.add('event', { botId: String(b._id), instruction: req.body.instruction, label: 'Tarea encargada desde el panel', manual: true }, { attempts: 1 }); res.json({ ok: true });
}));

/* Herramientas disponibles con su riesgo y política efectiva (para la matriz de autonomía) */
r.get('/tools', asyncH(async (req, res) => {
  const b = (await find(req)).toObject(); const { tools } = await loadTools(b.mcpServerIds || []);
  const own = ['search_knowledge', 'save_memory', 'report', 'ask_human', 'schedule_followup', 'crm_search', 'crm_get', 'crm_update', 'crm_create', 'send_email', 'send_telegram', 'run_function'];
  res.json([...own.map((n) => ({ name: n, source: 'JuntialAgents' })), ...tools.map((t) => ({ name: t.name, source: t.description.match(/^\[([^\]]+)\]/)?.[1] || 'MCP' }))]
    .map((t) => { const c = categorize(t.name, tools.find((x) => x.name === t.name)?.annotations); return { ...t, category: c, policy: policyFor(b, t.name, c), override: b.worker?.autonomy?.toolOverrides?.[t.name] || null }; }));
}));

/* Registro de trabajo y aprobaciones */
r.get('/runs', asyncH(async (req, res) => {
  const b = await find(req); const q = { botId: b._id };
  const kinds = { routine: { 'trigger.type': 'schedule' }, manual: { 'trigger.type': 'manual' }, event: { 'trigger.type': { $in: ['event', 'followup', 'answer'] } }, chat: { 'trigger.type': 'chat' }, errors: { status: { $in: ['error'] } }, skipped: { status: 'skipped' } };
  Object.assign(q, kinds[req.query.kind] || {});
  if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
  res.json(await WorkerRun.find(q).sort({ createdAt: -1 }).limit(Math.min(+req.query.limit || 100, 200)).select('-steps').lean());
}));
// Resumen de trabajo: lo que ha hecho hoy y esta semana, y lo próximo que hará
r.get('/overview', asyncH(async (req, res) => {
  const b = (await find(req)).toObject(); const now = Date.now(); const day = new Date(now - 864e5); const week = new Date(now - 7 * 864e5);
  const [runsWeek, pending, routines] = await Promise.all([
    WorkerRun.find({ botId: b._id, createdAt: { $gte: week } }).select('status trigger actions approvals ms usage report createdAt').lean(),
    WorkerApproval.countDocuments({ botId: b._id, status: 'pending' }), WorkerRoutine.find({ botId: b._id }).lean(),
  ]);
  const stat = (list) => ({ runs: list.length, done: list.filter((r) => ['done', 'waiting'].includes(r.status)).length, errors: list.filter((r) => r.status === 'error').length, skipped: list.filter((r) => r.status === 'skipped').length,
    reports: list.filter((r) => r.report?.sent).length, actions: list.reduce((a, r) => a + (r.actions || 0), 0), approvals: list.reduce((a, r) => a + (r.approvals || 0), 0),
    avgMs: Math.round(list.filter((r) => r.ms).reduce((a, r) => a + r.ms, 0) / Math.max(1, list.filter((r) => r.ms).length)),
    tokens: list.reduce((a, r) => a + (r.usage?.in || 0) + (r.usage?.out || 0) + (r.usage?.cacheRead || 0) + (r.usage?.cacheWrite || 0), 0) });
  const next = [];
  for (const rt of routines) {
    let nextAt = null; if (rt.enabled) { try { const js = await Q.workers.getJobScheduler(`wr-${rt._id}`); nextAt = js?.next ? new Date(js.next) : null; } catch { /* sin programación */ } }
    next.push({ id: rt._id, name: rt.name, cron: rt.cron, enabled: rt.enabled, nextAt, lastRunAt: rt.lastRunAt, lastStatus: rt.lastStatus, runs: rt.runs });
  }
  next.sort((a, c) => (a.nextAt ? +new Date(a.nextAt) : Infinity) - (c.nextAt ? +new Date(c.nextAt) : Infinity));
  const wh = b.worker?.autonomy?.workingHours;
  res.json({ today: stat(runsWeek.filter((r) => r.createdAt >= day)), week: stat(runsWeek), pendingApprovals: pending, routines: next, paused: !!b.worker?.paused,
    workingHours: wh?.enabled ? `${(wh.days || []).map((d) => 'DLMXJVS'[d]).join('')} ${wh.start}–${wh.end} (${wh.tz})` : 'Sin restricción',
    channels: ['panel', b.worker?.reporting?.telegramBotId && 'telegram', b.worker?.reporting?.email?.enabled && 'email', b.worker?.reporting?.webhook?.enabled && 'webhook'].filter(Boolean) });
}));
r.get('/runs/:id', asyncH(async (req, res) => { const b = await find(req); const run = await WorkerRun.findOne({ _id: req.params.id, botId: b._id }).lean(); if (!run) throw notFound(); res.json(run); }));
r.get('/approvals', asyncH(async (req, res) => {
  const b = await find(req);
  await WorkerApproval.updateMany({ botId: b._id, status: 'pending', expiresAt: { $lt: new Date() } }, { status: 'expired' });
  res.json(await WorkerApproval.find({ botId: b._id, ...(req.query.status ? { status: req.query.status } : {}) }).sort({ createdAt: -1 }).limit(100).lean());
}));
r.post('/approvals/:id/decide', validate(z.object({ approve: z.boolean(), feedback: z.string().max(1000).optional(), remember: z.boolean().optional() })), asyncH(async (req, res) => {
  const b = await find(req); if (!(await WorkerApproval.exists({ _id: req.params.id, botId: b._id }))) throw notFound();
  const out = await decideApproval(req.params.id, { approve: req.body.approve, by: req.user.email, via: 'panel', feedback: req.body.feedback, remember: req.body.remember, actor: { userId: req.user.id } });
  if (req.body.remember) await bumpBotVersion(b._id);
  audit(req, req.body.approve ? 'worker.approval.approve' : 'worker.approval.reject', { kind: 'approval', id: req.params.id }); res.json(out);
}));

/* Chat con el empleado (streaming) */
r.get('/chat', asyncH(async (req, res) => { const b = await find(req); res.json((await WorkerMessage.find({ botId: b._id }).sort({ createdAt: -1 }).limit(60).lean()).reverse()); }));
r.delete('/chat', asyncH(async (req, res) => { const b = await find(req); await WorkerMessage.deleteMany({ botId: b._id }); res.json({ ok: true }); }));
r.post('/chat', validate(z.object({ text: z.string().min(1).max(8000) })), asyncH(async (req, res) => {
  const b = await find(req);
  const hist = (await WorkerMessage.find({ botId: b._id }).sort({ createdAt: -1 }).limit(20).lean()).reverse().filter((m) => m.text?.trim()).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', parts: [{ type: 'text', text: m.text }] }));
  await WorkerMessage.create({ botId: b._id, userId: req.user.id, role: 'user', text: req.body.text, expiresAt: daysFromNow(90) });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const emit = (e, d) => { if (!res.writableEnded) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); };
  try {
    const out = await runWorker({ botId: b._id, trigger: { type: 'chat', label: `Conversación con ${req.user.email}` }, instruction: req.body.text, chatHistory: hist, actor: { userId: req.user.id, email: req.user.email, name: req.user.name || req.user.email, canApprove: true },
      onText: (t) => emit('delta', { text: t }), onStep: (s) => emit('step', { kind: s.kind, name: s.name, category: s.category, result: s.result }), signal: ac.signal });
    const text = out.text || out.skipped || '';
    await WorkerMessage.create({ botId: b._id, role: 'assistant', text, runId: out.run?._id, expiresAt: daysFromNow(90) });
    emit('done', { text, runId: out.run?._id });
  } catch (e) { if (!ac.signal.aborted) emit('error', { message: e.status === 401 ? 'La clave de IA no es válida.' : e.message }); }
  res.end();
}));
export default r;
