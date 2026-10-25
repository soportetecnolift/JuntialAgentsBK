import { CrmRecord, WebConversation } from '../../models/index.js';
import { getFields, agentFieldSchema } from './fields.js';
import { saveRecord, recordForChannel } from './records.js';

/** Herramientas CRM del agente: leer la ficha del contacto y rellenarla a medida que habla. Sus cambios disparan las reglas. */
export async function crmTools(bot) {
  if (bot.crm?.enabled === false) return [];
  const fields = await getFields(bot.tenantId);
  return [
    { name: 'crm_get_contact', description: 'Lee la ficha CRM del contacto con el que hablas (datos ya guardados de conversaciones anteriores).', schema: { type: 'object', properties: {} } },
    { name: 'crm_update_contact', description: 'Guarda o actualiza la ficha CRM del contacto en cuanto conozcas datos por la conversación. Envía solo los campos nuevos o que cambian. Nunca inventes ni supongas datos: solo lo que el usuario haya dicho.', schema: { type: 'object', properties: { fields: agentFieldSchema(fields) }, required: ['fields'] } },
  ];
}
export const crmPrompt = (bot) => (bot.crm?.enabled === false ? '' : '\n## Ficha del contacto (CRM)\n- Tienes una ficha del contacto. Al empezar, si es útil, consúltala con crm_get_contact para no volver a preguntar lo que ya sabes.\n- En cuanto el usuario te dé un dato que encaje con un campo, guárdalo con crm_update_contact sin anunciarlo de forma robótica.\n- No pidas todos los datos de golpe: recógelos con naturalidad a lo largo de la conversación.');

/** channel: { kind: 'telegram', userId, chatId, username, name } | { kind: 'web', conversationId } */
export function crmExecutor({ bot, channel }) {
  const tenantId = bot.tenantId;
  const locate = async () => {
    if (channel.kind === 'telegram') return recordForChannel({ tenantId, telegram: { userId: channel.userId } });
    const conv = await WebConversation.findById(channel.conversationId).select('recordId').lean();
    return conv?.recordId ? recordForChannel({ tenantId, web: { recordId: conv.recordId } }) : null;
  };
  return async (name, args) => {
    if (name === 'crm_get_contact') {
      const r = await locate();
      return { text: r ? JSON.stringify({ id: String(r._id), ...r.data }) : 'Aún no hay ficha de este contacto. Créala con crm_update_contact cuando tengas algún dato.' };
    }
    if (name !== 'crm_update_contact') return null;
    const data = { ...(args?.fields || {}) };
    try {
      let rec = await locate();
      // Evita duplicados: si el email ya existe en el CRM, se une a esa ficha
      if (!rec && data.email) rec = await CrmRecord.findOne({ tenantId, 'data.email': String(data.email).toLowerCase().trim() }).lean();
      if (!rec) { data.source ??= channel.kind === 'web' ? 'Web' : 'Telegram'; if (channel.kind === 'telegram' && channel.name) data.name ??= channel.name; data.status ??= 'Nuevo'; }
      const channels = channel.kind === 'telegram'
        ? { telegram: { botId: bot._id, userId: channel.userId, chatId: channel.chatId, username: channel.username } }
        : { web: { botId: bot._id, conversationId: channel.conversationId } };
      const out = await saveRecord({ tenantId, id: rec?._id, data, by: 'agent', agentId: bot._id, channels });
      if (channel.kind === 'web') await WebConversation.updateOne({ _id: channel.conversationId }, { recordId: out.record._id });
      const changed = Object.keys(out.changes);
      return { text: changed.length ? `Ficha guardada (${changed.join(', ')}).` : 'Sin cambios: esos datos ya estaban guardados.' };
    } catch (e) { return { isError: true, text: `No se pudo guardar: ${e.message}` }; }
  };
}
