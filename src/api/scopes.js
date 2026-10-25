/** Catálogo de permisos (scopes) de la API pública. Formato recurso:acción */
export const CLIENT_SCOPES = {
  'bots:read': 'Ver bots y su configuración', 'bots:write': 'Crear y modificar bots',
  'messages:send': 'Enviar mensajes a chats de Telegram', 'agent:run': 'Ejecutar el agente IA de un bot',
  'chats:read': 'Leer chats, contexto e historial', 'chats:write': 'Editar proyecto/notas de chats y borrar historial',
  'tasks:read': 'Ver tareas programadas', 'tasks:write': 'Gestionar tareas programadas',
  'webhooks:read': 'Ver webhooks', 'webhooks:write': 'Gestionar webhooks',
  'mcp:read': 'Ver conectores MCP', 'mcp:write': 'Gestionar conectores MCP',
  'crm:read': 'Leer contactos y su actividad', 'crm:write': 'Crear, editar y borrar contactos (dispara las reglas)',
  'crm_admin:read': 'Ver campos, reglas de flujo y funciones', 'crm_admin:write': 'Gestionar campos, reglas de flujo y funciones',
  'workers:read': 'Ver empleados digitales: actividad, documentos, rutinas y aprobaciones', 'workers:write': 'Gestionar empleados digitales: encargos, chat, documentos, rutinas y autonomía',
  'approvals:read': 'Ver aprobaciones de la organización', 'approvals:write': 'Decidir aprobaciones que te corresponden',
  'center:read': 'Ver Juntial Center: miembros, áreas, apps, conexiones, eventos y políticas', 'center:write': 'Gestionar Juntial Center',
  'usage:read': 'Ver plan y consumo', 'support:read': 'Ver tickets', 'support:write': 'Crear tickets y responder',
};
export const ADMIN_SCOPES = {
  'admin:read': 'Leer usuarios, clientes, planes, estadísticas y auditoría',
  'admin:write': 'Gestionar usuarios, clientes y planes',
  'admin:support': 'Gestionar la bandeja de soporte de todos los clientes',
  'platform:webhooks': 'Suscribirse a eventos de toda la plataforma',
};
export const ALL_SCOPES = { ...CLIENT_SCOPES, ...ADMIN_SCOPES };
export const hasScope = (scopes, s) => scopes.includes('*') || scopes.includes(s) || (s.endsWith(':read') && scopes.includes(s.replace(':read', ':write')));
