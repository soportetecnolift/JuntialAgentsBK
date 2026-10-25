import { WebConversation, Tenant } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { emitEvent } from '../webhooks/dispatcher.js';
import { notify } from '../notifications/service.js';
import { botLog } from '../../lib/audit.js';
import { crmExecutor } from '../crm/agentTools.js';

/** Acciones deterministas del agente web: el modelo decide CUÁNDO, pero el CÓMO es siempre igual. */
export function webTools(bot) {
  const t = [
    { name: 'show_options', description: 'Añade botones de respuesta rápida bajo tu mensaje (2–5 opciones cortas) para guiar decisiones: tipo de servicio, sí/no, horarios… Tu texto DEBE incluir la pregunta a la que responden, sin enumerar las opciones.', schema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 } }, required: ['options'] } },
    { name: 'capture_lead', description: 'Guarda los datos de contacto que el visitante te haya dado en la conversación (nombre, email, teléfono, empresa, necesidad). Llámalo en cuanto los tengas; no inventes datos.', schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, company: { type: 'string' }, notes: { type: 'string', description: 'Qué necesita, en una frase' } } } },
  ];
  if (bot.web?.leadForm?.enabled && bot.web.leadForm.fields?.length) t.push({ name: 'request_contact_form', description: 'Muestra al visitante un formulario para que deje sus datos de contacto de forma ordenada. Úsalo cuando necesites sus datos y prefiera escribirlos en un formulario.', schema: { type: 'object', properties: { reason: { type: 'string' } } } });
  if (bot.web?.handoff?.enabled !== false) t.push({ name: 'handoff_human', description: 'Deriva la conversación a una persona del equipo cuando el visitante lo pida, esté molesto o la consulta supere lo que puedes resolver. Antes intenta tener sus datos de contacto.', schema: { type: 'object', properties: { reason: { type: 'string' }, summary: { type: 'string', description: 'Resumen de la conversación para la persona que atenderá' } }, required: ['reason'] } });
  return t;
}

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const validEmail = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export async function saveLead(bot, convId, data, source = 'agent') {
  const lead = { name: clean(data.name), email: clean(data.email)?.toLowerCase(), phone: clean(data.phone, 40), company: clean(data.company), notes: clean(data.notes, 1000), extra: data.extra, at: new Date() };
  if (!validEmail(lead.email)) return { ok: false, error: 'Email no válido' };
  Object.keys(lead).forEach((k) => lead[k] === undefined && delete lead[k]);
  const conv = await WebConversation.findByIdAndUpdate(convId, Object.fromEntries(Object.entries(lead).map(([k, v]) => [`lead.${k}`, v])), { new: true });
  emitEvent(bot, 'lead.captured', { conversationId: String(convId), source, lead: conv.lead, page: conv.meta?.url });
  const tenant = await Tenant.findById(bot.tenantId).lean();
  notify(tenant.ownerId, 'web.lead', { agent: bot.name, name: conv.lead.name, email: conv.lead.email, phone: conv.lead.phone, botId: String(bot._id) }).catch(() => {});
  botLog(bot._id, 'info', 'web.lead', `Contacto captado: ${conv.lead.name || ''} ${conv.lead.email || conv.lead.phone || ''}`);
  // También a la ficha CRM (dispara las reglas de flujo)
  if (bot.crm?.enabled !== false) {
    const fields = Object.fromEntries(['name', 'email', 'phone', 'company', 'notes'].map((k) => [k, lead[k]]).filter(([, v]) => v));
    if (Object.keys(fields).length) await crmExecutor({ bot, channel: { kind: 'web', conversationId: convId } })('crm_update_contact', { fields }).catch(() => {});
  }
  return { ok: true, conv };
}

export function webExecutor({ bot, convId, emit }) {
  return async (name, args = {}) => {
    switch (name) {
      case 'show_options': emit('options', { options: (args.options || []).map((o) => String(o).slice(0, 60)).slice(0, 5) }); return { text: 'Botones preparados: aparecerán debajo de tu mensaje. Asegúrate de que tu texto contiene la pregunta a la que responden; si ya la escribiste, no la repitas.' };
      case 'request_contact_form': emit('form', { title: bot.web.leadForm.title, fields: bot.web.leadForm.fields }); return { text: 'Formulario mostrado. Espera a que el visitante lo envíe.' };
      case 'capture_lead': { const r = await saveLead(bot, convId, args, 'agent'); return r.ok ? { text: 'Datos guardados.' } : { isError: true, text: r.error }; }
      case 'handoff_human': {
        const conv = await WebConversation.findByIdAndUpdate(convId, { handoff: { requested: true, reason: clean(args.reason, 300), summary: clean(args.summary, 2000), at: new Date() } }, { new: true });
        const contact = [conv.lead?.name, conv.lead?.email, conv.lead?.phone].filter(Boolean).join(' · ');
        emitEvent(bot, 'handoff.requested', { conversationId: String(convId), reason: args.reason, summary: args.summary, lead: conv.lead, page: conv.meta?.url });
        const tenant = await Tenant.findById(bot.tenantId).lean();
        notify(tenant.ownerId, 'web.handoff', { agent: bot.name, reason: args.reason, contact, botId: String(bot._id) }).catch(() => {});
        const tg = bot.web?.handoff?.telegram;
        if (tg?.botId && tg?.chatId) await Q.inbound.add('api-send', { botId: String(tg.botId), chatIds: [tg.chatId], mode: 'message', text: `🙋 *${bot.name}*: un visitante pide hablar con una persona.\n*Motivo:* ${args.reason}\n${contact ? `*Contacto:* ${contact}\n` : ''}${args.summary ? `*Resumen:* ${args.summary}` : ''}` }, { attempts: 3 });
        emit('handoff', { message: bot.web.handoff.message });
        botLog(bot._id, 'warn', 'web.handoff', `Derivación a humano: ${args.reason}`);
        return { text: 'Derivación registrada y equipo avisado. Despídete indicando que una persona le contactará.' };
      }
      default: return null;
    }
  };
}
