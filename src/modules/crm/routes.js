import { Router } from 'express';
import { z } from 'zod';
import { FieldDef, CrmRecord, CrmActivity, Workflow, WorkflowRun, CrmFunction, FunctionRun, FunctionVersion, Bot } from '../../models/index.js';
import { asyncH, notFound, badRequest, forbidden } from '../../lib/errors.js';
import { validate } from '../../middleware/common.js';
import { encrypt, randomToken, decrypt } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { assertLimit } from '../plans/limits.js';
import { getFields, invalidateFields, FIELD_TYPES } from './fields.js';
import { saveRecord, deleteRecord } from './records.js';
import { OPERATORS } from './conditions.js';
import { invalidateRules, dryRun, executeRule } from './engine.js';
import { runFunction } from './sandbox.js';

/** CRM del cliente: /api/crm (panel) y /v1/crm (API pública con scope crm:*) */
const r = Router();
const tid = (req) => { if (!req.user.tenantId) throw forbidden('Solo disponible para cuentas de cliente'); return req.user.tenantId; };
const key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Nombre API: minúsculas, números y _ (ej. fecha_visita)');

r.get('/meta', asyncH(async (_req, res) => res.json({
  fieldTypes: FIELD_TYPES, operators: OPERATORS,
  triggers: { create: 'Se crea un contacto', edit: 'Se edita un contacto', create_or_edit: 'Se crea o edita', field_update: 'Se actualiza un campo concreto', delete: 'Se elimina', date: 'Fecha / hora de un campo' },
  actions: { email: 'Enviar email', telegram: 'Mensaje de Telegram', webhook: 'Webhook', field_update: 'Actualizar campo', notify: 'Aviso en la plataforma', function: 'Función JavaScript', agent_task: 'Encargar a un empleado digital' },
})));

/* ── Campos ── */
r.get('/fields', asyncH(async (req, res) => res.json(await getFields(tid(req)))));
const fieldSchema = z.object({ key, label: z.string().min(1).max(60), type: z.enum(FIELD_TYPES), options: z.array(z.string().min(1).max(60)).max(100).default([]), required: z.boolean().default(false), agentWritable: z.boolean().default(true), aiHint: z.string().max(300).default(''), order: z.number().int().optional() });
r.post('/fields', validate(fieldSchema), asyncH(async (req, res) => {
  const t = tid(req); await getFields(t);
  if ((await FieldDef.countDocuments({ tenantId: t })) >= 120) throw badRequest('Máximo 120 campos');
  if (['picklist', 'multiselect'].includes(req.body.type) && !req.body.options.length) throw badRequest('Añade al menos una opción');
  const f = await FieldDef.create({ ...req.body, tenantId: t, module: 'contacts', system: false, order: req.body.order ?? 100 });
  await invalidateFields(t); audit(req, 'crm.field.create', { kind: 'field', id: f.key }); res.status(201).json(f);
}));
r.put('/fields/:id', validate(fieldSchema.partial().omit({ key: true, type: true })), asyncH(async (req, res) => {
  const t = tid(req); const f = await FieldDef.findOneAndUpdate({ _id: req.params.id, tenantId: t }, req.body, { new: true }); if (!f) throw notFound();
  await invalidateFields(t); res.json(f);
}));
r.delete('/fields/:id', asyncH(async (req, res) => {
  const t = tid(req); const f = await FieldDef.findOne({ _id: req.params.id, tenantId: t }); if (!f) throw notFound(); if (f.system) throw badRequest('Los campos de sistema no se pueden eliminar');
  await f.deleteOne(); await invalidateFields(t); audit(req, 'crm.field.delete', { kind: 'field', id: f.key }); res.json({ ok: true });
}));

/* ── Contactos ── */
r.get('/records', asyncH(async (req, res) => {
  const t = tid(req); const q = { tenantId: t };
  if (req.query.q) { const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); q.$or = ['name', 'email', 'phone', 'company'].map((k) => ({ [`data.${k}`]: rx })); }
  if (req.query.status) q['data.status'] = req.query.status;
  if (req.query.agentId) q.agentIds = req.query.agentId;
  const page = Math.max(1, +req.query.page || 1); const limit = Math.min(+req.query.limit || 50, 200);
  const [items, total] = await Promise.all([CrmRecord.find(q).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), CrmRecord.countDocuments(q)]);
  res.json({ items, total, page });
}));
r.get('/records/:id', asyncH(async (req, res) => {
  const t = tid(req); const rec = await CrmRecord.findOne({ _id: req.params.id, tenantId: t }).populate('agentIds', 'name kind').lean(); if (!rec) throw notFound();
  const [activity, runs] = await Promise.all([CrmActivity.find({ recordId: rec._id }).sort({ createdAt: -1 }).limit(60).lean(), WorkflowRun.find({ recordId: rec._id }).sort({ createdAt: -1 }).limit(30).populate('ruleId', 'name').lean()]);
  res.json({ record: rec, activity, runs });
}));
r.post('/records', validate(z.object({ data: z.record(z.any()) })), asyncH(async (req, res) => {
  const out = await saveRecord({ tenantId: tid(req), data: { source: 'Manual', status: 'Nuevo', ...req.body.data }, by: req.apiKey ? 'api' : 'user' });
  res.status(201).json(out.record);
}));
r.put('/records/:id', validate(z.object({ data: z.record(z.any()) })), asyncH(async (req, res) => {
  const out = await saveRecord({ tenantId: tid(req), id: req.params.id, data: req.body.data, by: req.apiKey ? 'api' : 'user' });
  res.json({ record: out.record, changes: out.changes });
}));
r.delete('/records/:id', asyncH(async (req, res) => { await deleteRecord({ tenantId: tid(req), id: req.params.id, by: req.apiKey ? 'api' : 'user' }); audit(req, 'crm.record.delete', { kind: 'record', id: req.params.id }); res.json({ ok: true }); }));
r.post('/records/:id/notes', validate(z.object({ text: z.string().min(1).max(5000) })), asyncH(async (req, res) => {
  const t = tid(req); if (!(await CrmRecord.exists({ _id: req.params.id, tenantId: t }))) throw notFound();
  res.status(201).json(await CrmActivity.create({ recordId: req.params.id, tenantId: t, type: 'note', by: req.user.email, text: req.body.text }));
}));

/* ── Reglas de flujo ── */
const actionSchema = z.object({ type: z.enum(['email', 'telegram', 'webhook', 'field_update', 'notify', 'function', 'agent_task']), config: z.record(z.any()).default({}), delayMinutes: z.number().int().min(0).max(525600).default(0) });
const ruleSchema = z.object({
  name: z.string().min(2).max(100), description: z.string().max(500).default(''), enabled: z.boolean().default(true), order: z.number().int().default(0),
  scope: z.object({ type: z.enum(['all', 'agents']), agentIds: z.array(z.string()).default([]) }).default({ type: 'all', agentIds: [] }),
  trigger: z.object({ event: z.enum(['create', 'edit', 'create_or_edit', 'field_update', 'delete', 'date']), fields: z.array(z.string()).default([]), repeat: z.boolean().default(false), dateField: z.string().optional(), offsetMinutes: z.number().int().default(0) }),
  conditions: z.object({ match: z.enum(['all', 'any']).default('all'), rules: z.array(z.object({ field: z.string(), op: z.enum(Object.keys(OPERATORS)), value: z.any().optional() })).max(25).default([]) }).default({ match: 'all', rules: [] }),
  actions: z.array(actionSchema).min(1, 'Añade al menos una acción').max(20),
});
async function checkRule(t, body) {
  const fields = (await getFields(t)).map((f) => f.key);
  for (const c of body.conditions?.rules || []) if (!fields.includes(c.field)) throw badRequest(`Condición: el campo "${c.field}" no existe`);
  if (body.trigger?.event === 'date' && !(await getFields(t)).some((f) => f.key === body.trigger.dateField && ['date', 'datetime'].includes(f.type))) throw badRequest('Elige un campo de tipo fecha');
  if (body.scope?.type === 'agents') { if (!body.scope.agentIds.length) throw badRequest('Selecciona al menos un agente'); if ((await Bot.countDocuments({ _id: { $in: body.scope.agentIds }, tenantId: t })) !== body.scope.agentIds.length) throw badRequest('Agente no válido'); }
  for (const a of body.actions || []) {
    if (a.type === 'field_update' && !fields.includes(a.config.field)) throw badRequest('Actualizar campo: elige un campo válido');
    if (a.type === 'function' && !(await CrmFunction.exists({ _id: a.config.functionId, tenantId: t }))) throw badRequest('Elige una función válida');
    if (a.type === 'telegram' && !(await Bot.exists({ _id: a.config.botId, tenantId: t }))) throw badRequest('Elige un bot de Telegram');
    if (a.type === 'webhook' && !/^https:\/\//.test(a.config.url || '')) throw badRequest('El webhook debe ser una URL https');
    if (a.type === 'agent_task' && !(await Bot.exists({ _id: a.config.agentId, tenantId: t, kind: 'worker' }))) throw badRequest('Elige un empleado digital');
  }
}
r.get('/workflows', asyncH(async (req, res) => res.json(await Workflow.find({ tenantId: tid(req) }).sort({ order: 1, createdAt: 1 }).populate('scope.agentIds', 'name kind').lean())));
r.get('/workflows/:id', asyncH(async (req, res) => { const w = await Workflow.findOne({ _id: req.params.id, tenantId: tid(req) }).select('+webhookSecretEnc').lean(); if (!w) throw notFound(); w.webhookSecret = decrypt(w.webhookSecretEnc); delete w.webhookSecretEnc; res.json(w); }));
r.post('/workflows', validate(ruleSchema), asyncH(async (req, res) => {
  const t = tid(req); await assertLimit(t, 'workflows', await Workflow.countDocuments({ tenantId: t })); await checkRule(t, req.body);
  const w = await Workflow.create({ ...req.body, tenantId: t, webhookSecretEnc: encrypt(`whsec_${randomToken(24)}`) });
  await invalidateRules(t); audit(req, 'crm.workflow.create', { kind: 'workflow', id: w.id }); res.status(201).json(w);
}));
r.put('/workflows/:id', validate(ruleSchema.partial()), asyncH(async (req, res) => {
  const t = tid(req); const cur = await Workflow.findOne({ _id: req.params.id, tenantId: t }).lean(); if (!cur) throw notFound();
  await checkRule(t, { ...cur, ...req.body, scope: { ...cur.scope, ...req.body.scope, agentIds: (req.body.scope?.agentIds ?? cur.scope.agentIds).map(String) } });
  const w = await Workflow.findByIdAndUpdate(cur._id, req.body, { new: true }); await invalidateRules(t);
  audit(req, 'crm.workflow.update', { kind: 'workflow', id: w.id }); res.json(w);
}));
r.delete('/workflows/:id', asyncH(async (req, res) => { const t = tid(req); await Workflow.deleteOne({ _id: req.params.id, tenantId: t }); await invalidateRules(t); audit(req, 'crm.workflow.delete', { kind: 'workflow', id: req.params.id }); res.json({ ok: true }); }));
r.get('/workflows/:id/runs', asyncH(async (req, res) => { const t = tid(req); res.json(await WorkflowRun.find({ ruleId: req.params.id, tenantId: t }).sort({ createdAt: -1 }).limit(100).lean()); }));
r.post('/workflows/:id/test', validate(z.object({ recordId: z.string(), execute: z.boolean().default(false) })), asyncH(async (req, res) => {
  const t = tid(req); const rule = await Workflow.findOne({ _id: req.params.id, tenantId: t }).lean(); const rec = await CrmRecord.findOne({ _id: req.body.recordId, tenantId: t }).lean();
  if (!rule || !rec) throw notFound();
  const dry = await dryRun(rule, rec);
  if (req.body.execute) dry.execution = await executeRule(rule, rec, { event: 'manual', changes: {}, old: {}, by: req.user.email, depth: 0 });
  res.json(dry);
}));

/* ── Funciones (espacio de desarrollador) ── */
const fnSchema = z.object({ name: z.string().min(2).max(80), apiName: key, description: z.string().max(500).default(''), code: z.string().max(100000), timeoutMs: z.number().int().min(1000).max(30000).default(10000), env: z.record(z.string().max(4000)).optional(), testCases: z.array(z.object({ name: z.string().min(1).max(60), record: z.record(z.any()) })).max(30).optional() });
const fnView = (f) => { const o = f.toObject ? f.toObject() : f; delete o.envEnc; return o; };
r.get('/functions', asyncH(async (req, res) => res.json(await CrmFunction.find({ tenantId: tid(req) }).sort({ name: 1 }).lean())));
r.get('/functions/:id', asyncH(async (req, res) => { const f = await CrmFunction.findOne({ _id: req.params.id, tenantId: tid(req) }).lean(); if (!f) throw notFound(); res.json(f); }));
r.post('/functions', validate(fnSchema), asyncH(async (req, res) => {
  const t = tid(req); await assertLimit(t, 'functions', await CrmFunction.countDocuments({ tenantId: t }));
  const { env, ...b } = req.body;
  const f = await CrmFunction.create({ ...b, tenantId: t, envEnc: env ? encrypt(JSON.stringify(env)) : undefined, envKeys: Object.keys(env || {}) });
  audit(req, 'crm.function.create', { kind: 'function', id: f.apiName }); res.status(201).json(fnView(f));
}));
r.put('/functions/:id', validate(fnSchema.partial()), asyncH(async (req, res) => {
  const t = tid(req); const f = await CrmFunction.findOne({ _id: req.params.id, tenantId: t }).select('+envEnc'); if (!f) throw notFound();
  const { env, ...b } = req.body;
  // Historial de versiones: cada guardado con cambios de código crea una versión (se conservan 50)
  if (b.code !== undefined && b.code !== f.code) {
    await FunctionVersion.create({ functionId: f._id, version: f.version || 1, code: f.code, savedBy: req.user.email });
    f.version = (f.version || 1) + 1;
    const old = await FunctionVersion.find({ functionId: f._id }).sort({ createdAt: -1 }).skip(50).select('_id').lean();
    if (old.length) await FunctionVersion.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  }
  Object.assign(f, b);
  if (env) { const cur = f.envEnc ? JSON.parse(decrypt(f.envEnc)) : {}; const next = Object.fromEntries(Object.entries({ ...cur, ...env }).filter(([, v]) => v !== '')); f.envEnc = encrypt(JSON.stringify(next)); f.envKeys = Object.keys(next); }
  await f.save(); audit(req, 'crm.function.update', { kind: 'function', id: f.apiName }); res.json(fnView(f));
}));
r.delete('/functions/:id', asyncH(async (req, res) => { await CrmFunction.deleteOne({ _id: req.params.id, tenantId: tid(req) }); await FunctionVersion.deleteMany({ functionId: req.params.id }); res.json({ ok: true }); }));
r.get('/functions/:id/versions', asyncH(async (req, res) => { const f = await CrmFunction.exists({ _id: req.params.id, tenantId: tid(req) }); if (!f) throw notFound(); res.json(await FunctionVersion.find({ functionId: req.params.id }).sort({ createdAt: -1 }).limit(50).lean()); }));
r.get('/functions/:id/runs', asyncH(async (req, res) => res.json(await FunctionRun.find({ functionId: req.params.id, tenantId: tid(req) }).sort({ createdAt: -1 }).limit(50).lean())));
// Ejecutar desde el editor: con un contacto real o con datos de ejemplo (sin guardar el código)
r.post('/functions/:id/run', validate(z.object({ code: z.string().max(100000).optional(), recordId: z.string().optional(), sample: z.record(z.any()).optional() })), asyncH(async (req, res) => {
  const t = tid(req); const f = await CrmFunction.findOne({ _id: req.params.id, tenantId: t }).select('+envEnc').lean(); if (!f) throw notFound();
  let record = req.body.sample || {};
  if (req.body.recordId) { const rec = await CrmRecord.findOne({ _id: req.body.recordId, tenantId: t }).lean(); if (!rec) throw notFound('Contacto'); record = { id: String(rec._id), ...rec.data }; }
  const out = await runFunction({ fn: { ...f, code: req.body.code ?? f.code }, tenantId: t, recordId: req.body.recordId, trigger: 'manual', input: { record, ctx: { event: 'manual', changes: {}, by: req.user.email } } });
  res.json(out);
}));
export default r;
