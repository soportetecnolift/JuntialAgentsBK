import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { verifyOAuthToken } from './server.js';
import { KEY_RE } from '../../api/keyAuth.js';

/**
 * MCP de Juntial: un único servidor para Claude, ChatGPT y cualquier cliente MCP (Streamable HTTP + OAuth 2.1).
 * Las herramientas llaman a la API v1 con el token de la persona → respetan su organización, su rol en la app,
 * los límites del plan, la auditoría y las mismas validaciones que el panel.
 */
const SELF = () => `http://127.0.0.1:${env.PORT}/v1`;
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DEL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const EXT = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function client(token) {
  return async (method, path, body) => {
    const r = await fetch(`${SELF()}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) { const e = new Error(data?.error?.message || data?.message || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
  };
}
// Chat en streaming del empleado digital → texto final
async function streamChat(token, botId, text) {
  const r = await fetch(`${SELF()}/bots/${botId}/worker/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`);
  const raw = await r.text(); let final = ''; const steps = [];
  for (const block of raw.split('\n\n')) { const ev = block.match(/^event: (.+)$/m)?.[1]; const d = block.match(/^data: (.+)$/m)?.[1]; if (!ev || !d) continue; const j = JSON.parse(d); if (ev === 'done') final = j.text; if (ev === 'step' && j.kind !== 'thought') steps.push(`${j.kind}: ${j.name}`); if (ev === 'error') throw new Error(j.message); }
  return { reply: final, actions: steps };
}
const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }], structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data } });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] }; } };
const slim = (b) => ({ id: b._id, name: b.name, kind: b.kind, status: b.status, title: b.worker?.title, telegram: b.telegram?.username ? `@${b.telegram.username}` : undefined, model: b.ai?.model });

function buildServer(token, ctx) {
  const api = client(token);
  const s = new McpServer({ name: 'juntial', version: '1.0.0', title: 'Juntial — JuntialAgents y Juntial Center' }, {
    instructions: `Acceso a la organización de ${ctx.user.email} en Juntial: agentes de IA (Telegram, web y empleados digitales), CRM con campos personalizados, reglas de flujo, funciones JavaScript, aprobaciones con políticas por rol y área, documentos, mensajería y registros. Usa search/fetch para encontrar cosas; las acciones que cambian datos respetan los permisos de la persona y quedan auditadas. Las acciones de los empleados digitales siguen su autonomía y pueden generar aprobaciones.`,
  });
  const T = (name, title, description, schema, annotations, fn) => s.registerTool(name, { title, description, inputSchema: schema, annotations: { title, ...annotations } }, wrap(fn));

  /* — Búsqueda universal (formato requerido por ChatGPT: search / fetch) — */
  T('search', 'Buscar en Juntial', 'Busca agentes, contactos del CRM, reglas de flujo, funciones y aprobaciones. Devuelve resultados con id para usar en fetch.', { query: z.string().describe('Texto a buscar') }, RO, async ({ query }) => {
    const q = query.toLowerCase(); const results = [];
    const [bots, recs, wfs, fns, aps] = await Promise.all([api('GET', '/bots').catch(() => []), api('GET', `/crm/records?q=${encodeURIComponent(query)}&limit=10`).catch(() => ({ items: [] })), api('GET', '/crm/workflows').catch(() => []), api('GET', '/crm/functions').catch(() => []), api('GET', '/center/approvals?status=all').catch(() => [])]);
    for (const b of bots) if (`${b.name} ${b.worker?.title || ''}`.toLowerCase().includes(q)) results.push({ id: `agent:${b._id}`, title: `Agente · ${b.name}`, url: `${env.WEB_URL}/bots/${b._id}` });
    for (const r of recs.items || []) results.push({ id: `contact:${r._id}`, title: `Contacto · ${r.data.name || r.data.email || r._id}`, url: `${env.WEB_URL}/crm/contacts?id=${r._id}` });
    for (const w of wfs) if (w.name.toLowerCase().includes(q)) results.push({ id: `workflow:${w._id}`, title: `Regla · ${w.name}`, url: `${env.WEB_URL}/crm/workflows/${w._id}` });
    for (const f of fns) if (`${f.name} ${f.apiName} ${f.description || ''}`.toLowerCase().includes(q)) results.push({ id: `function:${f._id}`, title: `Función · ${f.name}`, url: `${env.WEB_URL}/crm/functions/${f._id}` });
    for (const a of aps) if (a.label.toLowerCase().includes(q)) results.push({ id: `approval:${a._id}`, title: `Aprobación · ${a.label}`, url: `${env.WEB_URL}/center/approvals` });
    return { results: results.slice(0, 25) };
  });
  T('fetch', 'Abrir resultado', 'Devuelve el contenido completo de un resultado de search (agent:…, contact:…, workflow:…, function:…, approval:…).', { id: z.string() }, RO, async ({ id }) => {
    const [type, rid] = id.split(':');
    const map = { agent: () => api('GET', `/bots/${rid}`), contact: () => api('GET', `/crm/records/${rid}`), workflow: () => api('GET', `/crm/workflows/${rid}`), function: () => api('GET', `/crm/functions/${rid}`), approval: async () => (await api('GET', '/center/approvals?status=all')).find((a) => a._id === rid) };
    if (!map[type]) throw new Error('Id no reconocido');
    const data = await map[type](); return { id, title: data?.name || data?.label || data?.record?.data?.name || id, text: JSON.stringify(data, null, 2), url: `${env.WEB_URL}`, metadata: { type } };
  });

  /* — Agentes — */
  T('list_agents', 'Listar agentes', 'Lista los agentes de la organización: bots de Telegram, agentes web y empleados digitales.', {}, RO, async () => (await api('GET', '/bots')).map(slim));
  T('get_agent', 'Ver agente', 'Configuración completa de un agente.', { agent_id: z.string() }, RO, ({ agent_id }) => api('GET', `/bots/${agent_id}`));
  T('create_agent', 'Crear agente', 'Crea un agente. kind: telegram | web | worker. Para worker, role: comercial | soporte | finanzas | operaciones | asistente | personalizado.', { name: z.string(), kind: z.enum(['telegram', 'web', 'worker']), role: z.string().optional() }, RW, async (a) => slim(await api('POST', '/bots', a)));
  T('update_agent_instructions', 'Cambiar instrucciones del agente', 'Actualiza el prompt de sistema de un bot de Telegram o agente web.', { agent_id: z.string(), system_prompt: z.string() }, RW, ({ agent_id, system_prompt }) => api('PUT', `/bots/${agent_id}`, { systemPrompt: system_prompt }));
  T('ask_agent', 'Preguntar a un agente', 'Habla con un agente y devuelve su respuesta. Con empleados digitales, actúa con sus herramientas y su autonomía (puede generar aprobaciones).', { agent_id: z.string(), message: z.string() }, EXT, async ({ agent_id, message }) => {
    const b = await api('GET', `/bots/${agent_id}`);
    if (b.kind === 'worker') return streamChat(token, agent_id, message);
    return api('POST', `/bots/${agent_id}/agent`, { input: message });
  });
  T('assign_task', 'Encargar tarea a un empleado digital', 'Encarga una tarea a un empleado digital; se ejecuta en segundo plano según su autonomía. Consulta luego list_agent_activity.', { agent_id: z.string(), instruction: z.string() }, RW, ({ agent_id, instruction }) => api('POST', `/bots/${agent_id}/worker/run`, { instruction }));
  T('list_agent_activity', 'Actividad del empleado digital', 'Últimas tareas de un empleado digital con su estado y resumen.', { agent_id: z.string() }, RO, ({ agent_id }) => api('GET', `/bots/${agent_id}/worker/runs`));
  T('get_agent_run', 'Detalle de una tarea', 'Traza completa de una tarea: razonamiento, acciones, bloqueos, aprobaciones y resumen.', { agent_id: z.string(), run_id: z.string() }, RO, ({ agent_id, run_id }) => api('GET', `/bots/${agent_id}/worker/runs/${run_id}`));
  T('get_agent_logs', 'Registro de un agente', 'Logs del agente con filtros (nivel, evento, texto, traza).', { agent_id: z.string(), level: z.string().optional(), q: z.string().optional(), trace_id: z.string().optional() }, RO, ({ agent_id, level, q, trace_id }) => api('GET', `/bots/${agent_id}/logs?${new URLSearchParams(Object.entries({ level, q, traceId: trace_id }).filter(([, v]) => v))}`));
  T('send_telegram_message', 'Enviar mensaje de Telegram', 'Envía un mensaje (con botones opcionales) a chats de Telegram con un bot de la organización.', { agent_id: z.string(), chat_ids: z.array(z.number()), text: z.string(), buttons: z.array(z.string()).optional() }, EXT, ({ agent_id, chat_ids, text, buttons }) => api('POST', `/bots/${agent_id}/messages`, { chatIds: chat_ids, text, buttons }));

  /* — Aprobaciones — */
  T('list_approvals', 'Aprobaciones', 'Aprobaciones pendientes que te tocan (o todas con scope=all si eres administrador), con su política y pasos.', { scope: z.enum(['mine', 'all']).optional(), status: z.enum(['pending', 'all']).optional() }, RO, ({ scope, status }) => api('GET', `/center/approvals?scope=${scope || 'mine'}&status=${status || 'pending'}`));
  T('decide_approval', 'Decidir aprobación', 'Aprueba o rechaza (con comentario) una aprobación que te corresponde. Si la política tiene varios pasos, registra tu voto.', { approval_id: z.string(), decision: z.enum(['approve', 'reject']), comment: z.string().optional() }, RW, ({ approval_id, decision, comment }) => api('POST', `/center/approvals/${approval_id}/decide`, { approve: decision === 'approve', feedback: comment }));
  T('simulate_approval_policy', 'Simular quién aprobaría', 'Indica qué política y qué personas aprobarían una acción de un agente (tipo de acción, herramienta, importe).', { agent_id: z.string().optional(), category: z.enum(['data', 'external', 'destructive', 'internal', 'read']), tool: z.string().optional(), amount: z.number().optional() }, RO, (a) => api('POST', '/center/policies/simulate', { agentId: a.agent_id, category: a.category, tool: a.tool, amount: a.amount }));

  /* — CRM — */
  T('crm_search_contacts', 'Buscar contactos', 'Busca contactos por nombre, email, teléfono o empresa, y/o por estado.', { query: z.string().optional(), status: z.string().optional(), limit: z.number().max(200).optional() }, RO, ({ query, status, limit }) => api('GET', `/crm/records?q=${encodeURIComponent(query || '')}&status=${encodeURIComponent(status || '')}&limit=${limit || 50}`));
  T('crm_get_contact', 'Ver contacto', 'Ficha de un contacto con su actividad y las reglas ejecutadas.', { contact_id: z.string() }, RO, ({ contact_id }) => api('GET', `/crm/records/${contact_id}`));
  T('crm_create_contact', 'Crear contacto', 'Crea un contacto (data: claves de campo → valor). Dispara las reglas de flujo.', { data: z.record(z.any()) }, RW, ({ data }) => api('POST', '/crm/records', { data }));
  T('crm_update_contact', 'Actualizar contacto', 'Actualiza campos de un contacto. Dispara las reglas de flujo.', { contact_id: z.string(), data: z.record(z.any()) }, RW, ({ contact_id, data }) => api('PUT', `/crm/records/${contact_id}`, { data }));
  T('crm_delete_contact', 'Eliminar contacto', 'Elimina un contacto del CRM (irreversible).', { contact_id: z.string() }, DEL, ({ contact_id }) => api('DELETE', `/crm/records/${contact_id}`));
  T('crm_list_fields', 'Campos del CRM', 'Campos de contacto (claves, tipos, opciones) para saber qué datos se pueden usar.', {}, RO, () => api('GET', '/crm/fields'));
  T('crm_create_field', 'Crear campo', 'Crea un campo personalizado. type: text, textarea, email, phone, number, currency, boolean, date, datetime, picklist, multiselect, url.', { key: z.string(), label: z.string(), type: z.string(), options: z.array(z.string()).optional(), agentWritable: z.boolean().optional(), aiHint: z.string().optional() }, RW, (a) => api('POST', '/crm/fields', a));

  /* — Reglas de flujo — */
  T('list_workflows', 'Reglas de flujo', 'Lista las reglas de flujo con su disparador, alcance, acciones y estadísticas.', {}, RO, () => api('GET', '/crm/workflows'));
  T('get_workflow', 'Ver regla', 'Definición completa de una regla de flujo.', { workflow_id: z.string() }, RO, ({ workflow_id }) => api('GET', `/crm/workflows/${workflow_id}`));
  T('create_workflow', 'Crear regla de flujo', 'Crea una regla: { name, scope:{type:"all"|"agents",agentIds}, trigger:{event:"create"|"edit"|"create_or_edit"|"field_update"|"delete"|"date",fields,repeat,dateField,offsetMinutes}, conditions:{match:"all"|"any",rules:[{field,op,value}]}, actions:[{type:"email"|"telegram"|"webhook"|"field_update"|"notify"|"function"|"agent_task",config,delayMinutes}] }. Usa crm_list_fields para las claves.', { definition: z.record(z.any()) }, RW, ({ definition }) => api('POST', '/crm/workflows', definition));
  T('update_workflow', 'Modificar regla', 'Modifica campos de una regla de flujo.', { workflow_id: z.string(), patch: z.record(z.any()) }, RW, ({ workflow_id, patch }) => api('PUT', `/crm/workflows/${workflow_id}`, patch));
  T('set_workflow_enabled', 'Activar o pausar regla', 'Activa o pausa una regla de flujo.', { workflow_id: z.string(), enabled: z.boolean() }, RW, ({ workflow_id, enabled }) => api('PUT', `/crm/workflows/${workflow_id}`, { enabled }));
  T('test_workflow', 'Probar regla', 'Comprueba si un contacto cumple las condiciones de una regla; con execute=true ejecuta sus acciones de verdad.', { workflow_id: z.string(), contact_id: z.string(), execute: z.boolean().optional() }, EXT, ({ workflow_id, contact_id, execute }) => api('POST', `/crm/workflows/${workflow_id}/test`, { recordId: contact_id, execute: !!execute }));

  /* — Funciones — */
  T('list_functions', 'Funciones', 'Funciones JavaScript de la organización.', {}, RO, () => api('GET', '/crm/functions'));
  T('get_function', 'Ver función', 'Código y configuración de una función.', { function_id: z.string() }, RO, ({ function_id }) => api('GET', `/crm/functions/${function_id}`));
  T('create_function', 'Crear función', 'Crea una función JavaScript con main(record, ctx) y el SDK jx (síncrono): jx.records.get/update/create/search, jx.http.get/post, jx.email.send, jx.telegram.send, jx.notify, jx.connections.request, jx.env, jx.log.', { name: z.string(), api_name: z.string(), code: z.string(), description: z.string().optional() }, RW, (a) => api('POST', '/crm/functions', { name: a.name, apiName: a.api_name, code: a.code, description: a.description || '' }));
  T('update_function', 'Modificar función', 'Actualiza el código (crea versión) u otros datos de una función.', { function_id: z.string(), code: z.string().optional(), description: z.string().optional() }, RW, ({ function_id, ...b }) => api('PUT', `/crm/functions/${function_id}`, b));
  T('run_function', 'Ejecutar función', 'Ejecuta una función con un contacto real (contact_id) o datos de ejemplo (sample). Devuelve resultado, logs, traza de llamadas y errores con su línea.', { function_id: z.string(), contact_id: z.string().optional(), sample: z.record(z.any()).optional(), code: z.string().optional() }, EXT, ({ function_id, contact_id, sample, code }) => api('POST', `/crm/functions/${function_id}/run`, { recordId: contact_id, sample, code }));

  /* — Documentos — */
  T('send_document_to_agent', 'Enviar documento a un empleado', 'Envía un documento (enlace https o base64) a la bandeja de un empleado digital; lo procesará según sus reglas.', { agent_id: z.string(), url: z.string().optional(), base64: z.string().optional(), name: z.string().optional(), note: z.string().optional() }, RW, ({ agent_id, url, base64, name, note }) => api('POST', `/bots/${agent_id}/worker/files`, { url, data: base64, name, note }));
  T('list_agent_documents', 'Documentos de un empleado', 'Bandeja de documentos con su estado y análisis.', { agent_id: z.string() }, RO, ({ agent_id }) => api('GET', `/bots/${agent_id}/worker/files`));

  /* — Organización — */
  T('get_usage', 'Plan y consumo', 'Plan de la organización y consumo de cada recurso frente a su límite.', {}, RO, () => api('GET', '/usage'));
  T('list_members', 'Miembros', 'Miembros de la organización con su rol, área y acceso a cada app.', {}, RO, () => api('GET', '/center/members'));
  T('list_departments', 'Áreas', 'Áreas o departamentos de la organización.', {}, RO, () => api('GET', '/center/departments'));
  T('list_events', 'Eventos recientes', 'Eventos de la organización (aprobaciones, tareas de agentes, CRM, miembros…).', { type: z.string().optional() }, RO, ({ type }) => api('GET', `/center/events?limit=50${type ? `&type=${encodeURIComponent(type)}` : ''}`));
  return s;
}

export const mcpRouter = Router();
const challenge = (res, msg) => res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${env.PUBLIC_API_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${msg}"`).json({ jsonrpc: '2.0', error: { code: -32001, message: msg }, id: null });
mcpRouter.all('/', async (req, res) => {
  const h = req.headers.authorization || ''; const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return challenge(res, 'Se requiere autorización');
  let ctx = null;
  if (token.startsWith('ja_oat_')) ctx = await verifyOAuthToken(token);
  else if (KEY_RE.test(token)) ctx = { user: { email: 'API key' } }; // también vale una API key de cliente (la valida la API v1)
  if (!ctx) return challenge(res, 'Token inválido o caducado');
  if (req.method === 'GET') return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Usa POST (servidor sin estado)' }, id: null });
  try {
    const server = buildServer(token, ctx); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport); await transport.handleRequest(req, res, req.body);
  } catch (e) { logger.error({ err: e.message }, 'MCP'); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null }); }
});
