import { env } from '../../config/env.js';
// Catálogo de notificaciones transaccionales estándar en SaaS (onboarding, seguridad, facturación/uso, operación, soporte).
const W = env.WEB_URL;
export const TEMPLATES = {
  'account.welcome':        { email: true, severity: 'success', title: () => 'Registro completado', body: (d) => `Hola ${d.name || ''}, tu cuenta está lista. Crea tu primer bot en minutos.`, link: () => `${W}/bots` },
  'auth.otp':               { email: true, inApp: false, title: () => 'Tu código de acceso', body: (d) => `Tu código es <b style="font-size:22px;letter-spacing:4px">${d.code}</b>. Caduca en 10 minutos. Si no lo solicitaste, ignora este correo.` },
  'auth.new_login':         { email: true, severity: 'warning', title: () => 'Nuevo inicio de sesión', body: (d) => `Se inició sesión desde ${d.userAgent || 'un dispositivo nuevo'} (IP ${d.ip}). Si no fuiste tú, cierra las sesiones desde Ajustes.`, link: () => `${W}/settings` },
  'auth.password_changed':  { email: true, severity: 'warning', title: () => 'Contraseña actualizada', body: () => 'Tu contraseña se cambió y se cerraron las demás sesiones.' },
  'auth.session_expiring':  { email: true, severity: 'info', title: () => 'Tu sesión caduca pronto', body: (d) => `Por seguridad, tu sesión caduca el ${d.date}. Tendrás que volver a iniciar sesión.` },
  'plan.changed':           { email: true, severity: 'success', title: (d) => `Plan actualizado a ${d.plan}`, body: (d) => `Tus nuevos límites ya están activos: ${d.summary}.`, link: () => `${W}/plans` },
  'plan.limit_warning':     { email: true, severity: 'warning', title: () => 'Has usado el 80% de tu plan', body: (d) => `Llevas ${d.used} de ${d.limit} mensajes este mes.`, link: () => `${W}/plans` },
  'plan.limit_reached':     { email: true, severity: 'error', title: () => 'Límite de mensajes alcanzado', body: (d) => `Tus bots dejaron de responder: ${d.limit} mensajes este mes. Cambia de plan para reactivarlos.`, link: () => `${W}/plans` },
  'bot.connected':          { email: true, severity: 'success', title: (d) => `@${d.username} conectado`, body: () => 'Tu bot ya recibe mensajes de Telegram.', link: (d) => `${W}/bots/${d.botId}` },
  'bot.token_invalid':      { email: true, severity: 'error', title: (d) => `@${d.username}: token inválido`, body: () => 'Telegram rechazó el token. Genera uno nuevo en @BotFather y actualízalo.', link: (d) => `${W}/bots/${d.botId}` },
  'bot.ai_error':           { email: true, severity: 'error', title: (d) => `@${d.username}: el proveedor de IA falla`, body: (d) => `Error repetido: ${d.error}. Revisa la clave y el modelo.`, link: (d) => `${W}/bots/${d.botId}` },
  'bot.model_replaced':     { email: true, severity: 'warning', title: (d) => `@${d.username}: modelo actualizado`, body: (d) => `${d.from} ya no está disponible. El bot pasó automáticamente a ${d.to} y sigue respondiendo.`, link: (d) => `${W}/bots/${d.botId}?tab=ai` },
  'bot.model_unavailable':  { email: true, severity: 'error', title: (d) => `@${d.username}: el modelo ya no existe`, body: (d) => `${d.from} fue retirado. Mientras lo cambias, el bot responde con ${d.to}. Elige un modelo en el panel.`, link: (d) => `${W}/bots/${d.botId}?tab=ai` },
  'bot.model_newer':        { email: true, severity: 'info', title: (d) => `Nuevo modelo disponible: ${d.newer}`, body: (d) => `@${d.username} usa ${d.current}. Ya puedes cambiarlo a ${d.newer} desde el panel.`, link: (d) => `${W}/bots/${d.botId}?tab=ai` },
  'web.lead':               { email: true, severity: 'success', title: (d) => `Nuevo contacto en ${d.agent}`, body: (d) => `${d.name || 'Un visitante'} ${d.email ? `(${d.email})` : ''} ${d.phone ? `· ${d.phone}` : ''} dejó sus datos.`, link: (d) => `${W}/bots/${d.botId}?tab=conversations` },
  'web.handoff':            { email: true, severity: 'warning', title: (d) => `${d.agent}: un visitante quiere hablar con una persona`, body: (d) => `${d.reason || ''} ${d.contact ? `· Contacto: ${d.contact}` : '· Aún sin datos de contacto'}`, link: (d) => `${W}/bots/${d.botId}?tab=conversations` },
  'crm.workflow':           { email: true, severity: 'info', title: (d) => d.title, body: (d) => d.body || '', link: (d) => d.link || (d.recordId ? `${W}/crm/contacts?id=${d.recordId}` : `${W}/crm/contacts`) },
  'task.failed':            { email: true, severity: 'error', title: (d) => `La tarea "${d.name}" falló`, body: (d) => d.error, link: (d) => `${W}/bots/${d.botId}?tab=tasks` },
  'webhook.disabled':       { email: true, severity: 'error', title: (d) => `Webhook "${d.name}" desactivado`, body: () => 'Se desactivó tras 20 entregas fallidas seguidas. Corrige el destino y reactívalo.' },
  'mcp.oauth_expired':      { email: true, severity: 'warning', title: (d) => `Reconecta "${d.name}"`, body: () => 'La autorización OAuth del conector caducó.', link: (d) => `${W}/bots/${d.botId}?tab=mcp` },
  'ticket.created':         { email: false, severity: 'info', title: (d) => `Ticket #${d.short}: ${d.subject}`, body: () => 'Nuevo ticket de soporte.', link: (d) => `${W}/support/${d.ticketId}` },
  'ticket.replied':         { email: true, severity: 'info', title: (d) => `Respuesta en "${d.subject}"`, body: (d) => d.preview, link: (d) => `${W}/support/${d.ticketId}` },
  'ticket.status':          { email: true, severity: 'info', title: (d) => `Ticket "${d.subject}": ${d.status}`, body: () => 'El estado de tu solicitud cambió.', link: (d) => `${W}/support/${d.ticketId}` },
};
