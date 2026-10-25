import { env } from '../config/env.js';
import { ALL_SCOPES } from './scopes.js';
import { EVENTS } from '../modules/webhooks/dispatcher.js';
import { PLATFORM_EVENTS } from '../modules/platform/events.js';

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const body = (schema, example) => ({ required: true, content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
const ok = (schema, d = 'OK') => ({ description: d, content: { 'application/json': { schema } } });
const errors = { 400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' } };
const id = (n = 'id') => ({ name: n, in: 'path', required: true, schema: { type: 'string' } });
const idem = { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Reintentos seguros: la misma clave devuelve la misma respuesta durante 24 h.' };
const op = (tag, summary, scope, extra = {}) => ({ tags: [tag], summary, description: `Permiso: \`${scope}\`${extra.desc ? `\n\n${extra.desc}` : ''}`, ...(extra.params ? { parameters: extra.params } : {}), ...(extra.body ? { requestBody: extra.body } : {}), responses: { 200: extra.res || ok({ type: 'object' }), ...errors } });

export function openapi() {
  const P = {
    '/me': { get: op('General', 'Información de la API key actual', 'cualquiera') },
    '/bots': { get: op('Bots', 'Listar bots', 'bots:read', { res: ok({ type: 'array', items: ref('Bot') }) }), post: op('Bots', 'Crear bot', 'bots:write', { body: body({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } }) }) },
    '/bots/{id}': { parameters: [id()], get: op('Bots', 'Obtener bot', 'bots:read', { res: ok(ref('Bot')) }), put: op('Bots', 'Actualizar instrucciones, comportamiento o protección anti-flood', 'bots:write', { body: body(ref('BotSettings')) }), delete: op('Bots', 'Eliminar bot', 'bots:write') },
    '/bots/{id}/telegram': { parameters: [id()], put: op('Bots', 'Conectar token de @BotFather', 'bots:write', { body: body({ type: 'object', properties: { token: { type: 'string' } } }) }), delete: op('Bots', 'Desconectar Telegram', 'bots:write') },
    '/bots/{id}/ai': { parameters: [id()], put: op('Bots', 'Configurar proveedor (Claude/GPT), modelo y clave', 'bots:write', { body: body({ type: 'object', properties: { provider: { enum: ['anthropic', 'openai'] }, model: { type: 'string' }, apiKey: { type: 'string' }, temperature: { type: 'number' }, maxTokens: { type: 'integer' } } }) }) },
    '/bots/{id}/status': { parameters: [id()], put: op('Bots', 'Activar o pausar', 'bots:write', { body: body({ type: 'object', properties: { status: { enum: ['active', 'paused'] } } }) }) },
    '/bots/{id}/mcp': { parameters: [id()], put: op('Bots', 'Asignar conectores MCP al bot', 'bots:write', { body: body({ type: 'object', properties: { serverIds: { type: 'array', items: { type: 'string' } } } }) }) },
    '/bots/{id}/logs': { parameters: [id()], get: op('Bots', 'Registro de actividad del bot', 'bots:read') },
    '/bots/{id}/messages': { parameters: [id(), idem], post: op('Mensajería', 'Enviar mensaje o tarea del agente a chats', 'messages:send', {
      desc: 'Asíncrono (202). Consulta el resultado en `/jobs/{jobId}`. Con `mode=agent` el bot razona con sus herramientas antes de escribir.',
      body: body({ type: 'object', required: ['chatIds', 'text'], properties: { chatIds: { type: 'array', items: { type: 'integer' } }, text: { type: 'string' }, mode: { enum: ['message', 'agent'], default: 'message' }, buttons: { type: 'array', description: 'Botones inline: "Texto", "Texto | https://url" o { text, url, value }. Al pulsarlos, la respuesta llega al agente.', items: {} } } }, { chatIds: [-1001234567890], text: '¿Confirmas la visita técnica del jueves a las 10:00?', buttons: ['✅ Confirmo', '📅 Cambiar fecha', '📞 Que me llamen'] }),
      res: ok({ type: 'object', properties: { jobId: { type: 'string' }, status: { type: 'string' }, statusUrl: { type: 'string' } } }, 'Aceptado') }) },
    '/jobs/{id}': { parameters: [id()], get: op('Mensajería', 'Estado de un envío asíncrono', 'el de la clave que lo creó') },
    '/bots/{id}/agent': { parameters: [id(), idem], post: op('Agente IA', 'Ejecutar el agente del bot desde tu sistema', 'agent:run', {
      desc: 'Síncrono. Usa el prompt, modelo y conectores MCP del bot. Con `chatId` usa además la memoria y el proyecto de ese chat. Consume 1 mensaje del plan.',
      body: body({ type: 'object', required: ['input'], properties: { input: { type: 'string' }, chatId: { type: 'integer' }, useTools: { type: 'boolean', default: true }, history: { type: 'array', items: { type: 'object', properties: { role: { enum: ['user', 'assistant'] }, content: { type: 'string' } } } }, images: { type: 'array', items: { type: 'object', properties: { mime: { type: 'string' }, data: { type: 'string', description: 'base64' } } } } } }, { input: 'Resume el estado de los tratos abiertos de esta semana', useTools: true }),
      res: ok({ type: 'object', properties: { output: { type: 'string' }, usage: { type: 'object' }, toolCalls: { type: 'array', items: { type: 'object' } }, model: { type: 'string' }, ms: { type: 'integer' } } }) }) },
    '/bots/{id}/chats': { parameters: [id()], get: op('Chats', 'Chats del bot con su contexto y proyecto', 'chats:read') },
    '/bots/{id}/chats/{chatId}': { parameters: [id(), id('chatId')], put: op('Chats', 'Vincular proyecto o editar notas del chat', 'chats:write', { body: body({ type: 'object', properties: { project: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' }, crmRef: { type: 'string' }, description: { type: 'string' } } }, notes: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } } } }) }) },
    '/bots/{id}/chats/{chatId}/messages': { parameters: [id(), id('chatId')], get: op('Chats', 'Historial reciente del chat', 'chats:read') },
    '/bots/{id}/tasks': { parameters: [id()], get: op('Tareas', 'Listar tareas programadas', 'tasks:read'), post: op('Tareas', 'Crear tarea (cron o única)', 'tasks:write', { body: body(ref('Task')) }) },
    '/bots/{id}/tasks/{taskId}': { parameters: [id(), id('taskId')], put: op('Tareas', 'Actualizar tarea', 'tasks:write', { body: body(ref('Task')) }), delete: op('Tareas', 'Eliminar tarea', 'tasks:write') },
    '/bots/{id}/tasks/{taskId}/run': { parameters: [id(), id('taskId')], post: op('Tareas', 'Ejecutar ahora', 'tasks:write') },
    '/bots/{id}/webhooks': { parameters: [id()], get: op('Webhooks', 'Listar webhooks del bot', 'webhooks:read'), post: op('Webhooks', 'Crear webhook entrante o saliente', 'webhooks:write', { desc: `Eventos salientes: ${EVENTS.map((e) => `\`${e}\``).join(', ')}` }) },
    '/bots/{id}/webhooks/{webhookId}': { parameters: [id(), id('webhookId')], put: op('Webhooks', 'Actualizar webhook', 'webhooks:write'), delete: op('Webhooks', 'Eliminar webhook', 'webhooks:write') },
    '/connectors': { get: op('Conectores MCP', 'Listar conectores', 'mcp:read'), post: op('Conectores MCP', 'Crear conector (none, bearer, api_key, basic, headers, oauth2_code, oauth2_client_credentials)', 'mcp:write') },
    '/connectors/{id}': { parameters: [id()], put: op('Conectores MCP', 'Actualizar conector', 'mcp:write'), delete: op('Conectores MCP', 'Eliminar conector', 'mcp:write') },
    '/connectors/{id}/test': { parameters: [id()], post: op('Conectores MCP', 'Probar conexión y listar herramientas', 'mcp:write') },
    '/crm/records': { get: op('CRM', 'Listar contactos (?q, ?status, ?agentId, ?page)', 'crm:read'), post: op('CRM', 'Crear contacto (dispara las reglas de flujo)', 'crm:write', { body: body({ type: 'object', properties: { data: { type: 'object' } } }, { data: { name: 'Ana García', email: 'ana@correo.es', presupuesto: 25000 } }) }) },
    '/crm/records/{id}': { parameters: [id()], get: op('CRM', 'Contacto con actividad y ejecuciones de reglas', 'crm:read'), put: op('CRM', 'Actualizar campos (dispara las reglas de flujo)', 'crm:write', { body: body({ type: 'object', properties: { data: { type: 'object' } } }, { data: { status: 'Cualificado' } }) }), delete: op('CRM', 'Eliminar contacto', 'crm:write') },
    '/crm/fields': { get: op('CRM · Configuración', 'Campos del módulo Contactos', 'crm_admin:read'), post: op('CRM · Configuración', 'Crear campo personalizado', 'crm_admin:write') },
    '/crm/workflows': { get: op('CRM · Configuración', 'Reglas de flujo', 'crm_admin:read'), post: op('CRM · Configuración', 'Crear regla de flujo', 'crm_admin:write') },
    '/crm/workflows/{id}': { parameters: [id()], put: op('CRM · Configuración', 'Actualizar regla', 'crm_admin:write'), delete: op('CRM · Configuración', 'Eliminar regla', 'crm_admin:write') },
    '/crm/functions': { get: op('CRM · Configuración', 'Funciones JavaScript', 'crm_admin:read'), post: op('CRM · Configuración', 'Crear función', 'crm_admin:write') },
    '/crm/functions/{id}/run': { parameters: [id()], post: op('CRM · Configuración', 'Ejecutar una función con un contacto o datos de ejemplo', 'crm_admin:write') },
    '/bots/{id}/worker/files': { parameters: [id()], get: op('Empleado digital', 'Bandeja de documentos (?status)', 'bots:read'), post: op('Empleado digital', 'Enviar un documento al empleado (archivo en base64 o enlace). Si tiene activado el procesamiento automático, lo procesa según sus reglas.', 'bots:write', { body: body({ type: 'object', properties: { name: { type: 'string' }, mime: { type: 'string' }, data: { type: 'string', description: 'Archivo en base64 (máx. 10 MB)' }, url: { type: 'string' }, note: { type: 'string' }, autoProcess: { type: 'boolean' } } }, { url: 'https://proveedor.com/facturas/FV-204.pdf', note: 'Recibida por email de compras' }) }) },
    '/bots/{id}/worker/files/{fileId}': { parameters: [id(), { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], get: op('Empleado digital', 'Documento con su análisis (tipo, datos extraídos, incidencias, acciones)', 'bots:read') },
    /* ── Empleado digital ── */
    '/bots/{id}/worker': { parameters: [id()], put: op('Empleado digital', 'Configurar puesto, entrenamiento, documentos, autonomía, área y canales', 'workers:write') },
    '/bots/{id}/worker/chat': { parameters: [id()], get: op('Empleado digital', 'Historial del chat', 'workers:read'), post: op('Empleado digital', 'Hablar con el empleado (respuesta en streaming text/event-stream: step, delta, done)', 'workers:write', { body: body({ type: 'object', properties: { text: { type: 'string' } } }, { text: '¿Qué tienes pendiente?' }) }) },
    '/bots/{id}/worker/run': { parameters: [id()], post: op('Empleado digital', 'Encargar una tarea (se ejecuta en segundo plano)', 'workers:write', { body: body({ type: 'object', properties: { instruction: { type: 'string' } } }, { instruction: 'Revisa los leads de esta semana' }) }) },
    '/bots/{id}/worker/runs': { parameters: [id()], get: op('Empleado digital', 'Registro de tareas', 'workers:read') },
    '/bots/{id}/worker/runs/{runId}': { parameters: [id(), id('runId')], get: op('Empleado digital', 'Traza completa de una tarea', 'workers:read') },
    '/bots/{id}/worker/routines': { parameters: [id()], get: op('Empleado digital', 'Rutinas', 'workers:read'), post: op('Empleado digital', 'Crear rutina (cron)', 'workers:write') },
    '/bots/{id}/worker/routines/{routineId}': { parameters: [id(), id('routineId')], put: op('Empleado digital', 'Modificar rutina', 'workers:write'), delete: op('Empleado digital', 'Eliminar rutina', 'workers:write') },
    '/bots/{id}/worker/docs': { parameters: [id()], get: op('Empleado digital', 'Documentos de formación', 'workers:read'), post: op('Empleado digital', 'Añadir formación (texto o URL)', 'workers:write') },
    '/bots/{id}/worker/memory': { parameters: [id()], put: op('Empleado digital', 'Reemplazar la memoria aprendida', 'workers:write') },
    '/bots/{id}/worker/tools': { parameters: [id()], get: op('Empleado digital', 'Herramientas con su categoría de riesgo y política efectiva', 'workers:read') },
    '/bots/{id}/worker/approvals': { parameters: [id()], get: op('Empleado digital', 'Aprobaciones del empleado', 'workers:read') },
    '/bots/{id}/worker/approvals/{approvalId}/decide': { parameters: [id(), id('approvalId')], post: op('Empleado digital', 'Aprobar o rechazar (remember=true: permitir siempre esa herramienta)', 'workers:write') },
    '/bots/{id}/worker/reporting/test': { parameters: [id()], post: op('Empleado digital', 'Diagnóstico de canales (kind: report | approval)', 'workers:write') },
    '/bots/{id}/logs': { parameters: [id()], get: op('Registro', 'Logs con filtros (level, event, q, traceId, chatId, since, before)', 'bots:read') },
    '/bots/{id}/logs/stats': { parameters: [id()], get: op('Registro', 'Resumen de 24 h e histograma', 'bots:read') },
    '/bots/{id}/logs/export': { parameters: [id()], get: op('Registro', 'Exportar logs (format=csv|ndjson)', 'bots:read') },
    '/crm/functions/{id}/versions': { parameters: [id()], get: op('CRM · Configuración', 'Historial de versiones de una función', 'crm_admin:read') },
    /* ── Juntial Center ── */
    '/center/me': { get: op('Juntial Center', 'Mis organizaciones, mi membresía y mis apps', 'center:read') },
    '/center/org': { get: op('Juntial Center', 'Organización activa', 'center:read'), put: op('Juntial Center', 'Modificar la organización', 'center:write') },
    '/center/members': { get: op('Juntial Center', 'Miembros con rol, áreas y acceso por app', 'center:read') },
    '/center/members/{id}': { parameters: [id()], put: op('Juntial Center', 'Cambiar rol, áreas, acceso a apps o Telegram de un miembro', 'center:write'), delete: op('Juntial Center', 'Quitar miembro', 'center:write') },
    '/center/invitations': { get: op('Juntial Center', 'Invitaciones pendientes', 'center:read'), post: op('Juntial Center', 'Invitar por email', 'center:write', { body: body({ type: 'object' }, { email: 'helena@empresa.com', orgRole: 'member', appRoles: { juntialagents: 'editor' } }) }) },
    '/center/departments': { get: op('Juntial Center', 'Áreas / departamentos', 'center:read'), post: op('Juntial Center', 'Crear área (con responsable)', 'center:write') },
    '/center/apps': { get: op('Juntial Center', 'Catálogo de apps y estado en la organización', 'center:read') },
    '/center/connections': { get: op('Juntial Center', 'Conexiones compartidas (sin secretos)', 'center:read'), post: op('Juntial Center', 'Crear conexión (api_key, bearer, basic, headers, oauth2_client_credentials)', 'center:write') },
    '/center/events': { get: op('Juntial Center', 'Eventos de la organización (?type=approval.)', 'center:read') },
    '/center/event-types': { get: op('Juntial Center', 'Tipos de evento disponibles por app', 'center:read') },
    '/center/subscriptions': { get: op('Juntial Center', 'Suscripciones a eventos (webhooks firmados)', 'center:read'), post: op('Juntial Center', 'Suscribirse a eventos', 'center:write') },
    '/center/policies': { get: op('Aprobaciones', 'Políticas de aprobación', 'center:read'), post: op('Aprobaciones', 'Crear política (match + cadena de pasos)', 'center:write') },
    '/center/policies/{id}': { parameters: [id()], put: op('Aprobaciones', 'Modificar política', 'center:write'), delete: op('Aprobaciones', 'Eliminar política', 'center:write') },
    '/center/policies/simulate': { post: op('Aprobaciones', '¿Quién aprobaría? (agentId, category, tool, amount)', 'center:read') },
    '/center/approvals': { get: op('Aprobaciones', 'Bandeja: lo que me toca (?scope=all para administradores, ?status=all)', 'approvals:read') },
    '/center/approvals/{id}/decide': { parameters: [id()], post: op('Aprobaciones', 'Aprobar o rechazar (registra tu voto en el paso actual)', 'approvals:write', { body: body({ type: 'object', properties: { approve: { type: 'boolean' }, feedback: { type: 'string' } } }, { approve: true }) }) },
    '/usage': { get: op('Plan y uso', 'Plan, límites y consumo del mes', 'usage:read') },
    '/support': { get: op('Soporte', 'Listar tickets', 'support:read · admin:support'), post: op('Soporte', 'Crear ticket', 'support:write') },
    '/support/{id}': { parameters: [id()], get: op('Soporte', 'Ticket con mensajes', 'support:read'), patch: op('Soporte', 'Cambiar estado/prioridad/asignado', 'support:write · admin:support') },
    '/support/{id}/messages': { parameters: [id()], post: op('Soporte', 'Responder', 'support:write · admin:support') },
    // Admin
    '/admin/stats': { get: op('Admin', 'Métricas globales y estado de colas', 'admin:read') },
    '/admin/users': { get: op('Admin', 'Buscar usuarios (?q, ?role, ?page)', 'admin:read'), post: op('Admin', 'Invitar usuario', 'admin:write') },
    '/admin/users/{id}': { parameters: [id()], patch: op('Admin', 'Cambiar rol/estado', 'admin:write') },
    '/admin/users/{id}/logout-all': { parameters: [id()], post: op('Admin', 'Cerrar todas las sesiones', 'admin:write') },
    '/admin/tenants': { get: op('Admin', 'Listar clientes con plan y nº de bots', 'admin:read') },
    '/admin/tenants/{id}': { parameters: [id()], patch: op('Admin', 'Suspender/reactivar cliente', 'admin:write') },
    '/admin/tenants/{id}/plan': { parameters: [id()], post: op('Admin', 'Asignar plan', 'admin:write', { body: body({ type: 'object', properties: { planId: { type: 'string' } } }) }) },
    '/admin/plans': { get: op('Admin', 'Listar planes', 'admin:read'), post: op('Admin', 'Crear plan', 'admin:write') },
    '/admin/plans/{id}': { parameters: [id()], put: op('Admin', 'Actualizar plan', 'admin:write') },
    '/admin/audit': { get: op('Admin', 'Auditoría (?action, ?actor)', 'admin:read') },
    '/admin/api-keys': { get: op('Admin', 'Todas las API keys (sin secretos)', 'admin:read') },
    '/admin/api-keys/{id}/revoke': { parameters: [id()], post: op('Admin', 'Revocar cualquier API key', 'admin:write') },
    '/admin/platform-webhooks': { get: op('Admin · Eventos', 'Webhooks de plataforma', 'platform:webhooks'), post: op('Admin · Eventos', 'Suscribirse a eventos de plataforma', 'platform:webhooks', { desc: `Eventos: ${PLATFORM_EVENTS.map((e) => `\`${e}\``).join(', ')}`, body: body({ type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } } }) }) },
    '/admin/platform-webhooks/{id}': { parameters: [id()], put: op('Admin · Eventos', 'Actualizar', 'platform:webhooks'), delete: op('Admin · Eventos', 'Eliminar', 'platform:webhooks') },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'JuntialAgents API', version: '1.0.0', description: `API REST para integraciones de clientes y desarrollos a medida de administradores.

**Autenticación**: \`Authorization: Bearer ja_live_…\` (o cabecera \`X-API-Key\`). Las claves \`ja_live_ck_\` son de cliente (solo su cuenta); \`ja_live_ak_\` son de administrador (toda la plataforma).

**Errores**: \`{ "error": { "code", "message", "details", "requestId" } }\`. Códigos: BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, PLAN_LIMIT (402), RATE_LIMITED (429, con \`Retry-After\`).

**Webhooks**: firma \`X-JuntialAgents-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>\`. Rechaza firmas con más de 5 minutos.

**Permisos disponibles**: ${Object.keys(ALL_SCOPES).map((s) => `\`${s}\``).join(', ')}.` },
    servers: [{ url: `${env.PUBLIC_API_URL}/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'ja_live_…' } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: ref('Error') } } } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } } } },
        Bot: { type: 'object', properties: { _id: { type: 'string' }, name: { type: 'string' }, status: { enum: ['active', 'paused', 'error'] }, telegram: { type: 'object', properties: { username: { type: 'string' }, connected: { type: 'boolean' } } }, ai: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } }, systemPrompt: { type: 'string' }, stats: { type: 'object' } } },
        BotSettings: { type: 'object', properties: { name: { type: 'string' }, systemPrompt: { type: 'string' }, behavior: { type: 'object', properties: { groupMode: { enum: ['mention', 'always', 'commands'] }, triggerKeywords: { type: 'array', items: { type: 'string' } }, progressMessages: { type: 'boolean' }, learnFromGroup: { type: 'boolean' }, historyTurns: { type: 'integer' }, allowedChatIds: { type: 'array', items: { type: 'integer' } } } }, flood: { type: 'object', properties: { perChatPerMinute: { type: 'integer' }, maxPending: { type: 'integer' }, debounceMs: { type: 'integer' } } } } },
        Task: { type: 'object', properties: { name: { type: 'string' }, type: { enum: ['cron', 'once'] }, cron: { type: 'string', example: '0 9 * * 1-5' }, runAt: { type: 'string', format: 'date-time' }, timezone: { type: 'string', example: 'Europe/Madrid' }, action: { enum: ['agent', 'message'] }, prompt: { type: 'string' }, chatIds: { type: 'array', items: { type: 'integer' } }, enabled: { type: 'boolean' } } },
      },
    },
    paths: P,
  };
}

export const docsHtml = () => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JuntialAgents API</title></head>
<body><script id="api-reference" data-url="/v1/openapi.json" data-configuration='{"theme":"default","layout":"modern","defaultHttpClient":{"targetKey":"node","clientKey":"fetch"}}'></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script></body></html>`;
