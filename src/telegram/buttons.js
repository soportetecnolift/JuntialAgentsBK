import { redis } from '../lib/redis.js';
import { randomToken } from '../lib/crypto.js';

/**
 * Botones de Telegram:
 *  - inline (debajo del mensaje): opciones generadas por el agente, conjuntos fijos del panel o enviadas por reglas/API.
 *    callback_data tiene un límite de 64 bytes → se guarda un id corto y las opciones en Redis (7 días).
 *  - menú fijo (teclado bajo el campo de texto, solo chats privados): botones que envían su texto como mensaje.
 * Formato de cada botón: "Texto" o "Texto | https://enlace" (botón de enlace).
 */
const TTL = 7 * 86400;
export const MAX_OPTIONS = 12;

export function parseButtons(list) {
  return (list || []).map((b) => {
    if (b && typeof b === 'object') return { text: String(b.text || '').slice(0, 60), url: b.url && /^https?:\/\//.test(b.url) ? b.url : undefined, value: b.value ? String(b.value).slice(0, 200) : undefined };
    const [text, url] = String(b).split('|').map((x) => x.trim());
    return { text: text.slice(0, 60), url: url && /^https?:\/\//.test(url) ? url : undefined };
  }).filter((b) => b.text).slice(0, MAX_OPTIONS);
}

/** Distribuye en filas: opciones cortas de 2 o 3 por fila; largas, una por fila. */
function layout(buttons, columns) {
  const max = Math.max(...buttons.map((b) => b.text.length));
  const per = columns || (max <= 12 ? 3 : max <= 22 ? 2 : 1);
  const rows = []; for (let i = 0; i < buttons.length; i += per) rows.push(buttons.slice(i, i + per)); return rows;
}

export async function inlineKeyboard(botId, chatId, options, { columns, question = '' } = {}) {
  const buttons = parseButtons(options); if (!buttons.length) return null;
  const id = randomToken(6);
  await redis.set(`tg:cb:${botId}:${id}`, JSON.stringify({ options: buttons, chatId, q: question.slice(0, 300) }), 'EX', TTL);
  let n = -1;
  const markup = { inline_keyboard: layout(buttons, columns).map((row) => row.map((b) => { n++; return b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: `o|${id}|${n}` }; })) };
  return { id, markup };
}
/** Tras enviar, se guarda qué mensaje lleva los botones para poder marcar la elección. */
export async function attachMessage(botId, id, { messageId, html }) {
  const raw = await redis.get(`tg:cb:${botId}:${id}`); if (!raw) return;
  await redis.set(`tg:cb:${botId}:${id}`, JSON.stringify({ ...JSON.parse(raw), messageId, html }), 'EX', TTL);
}
export async function resolveCallback(botId, data) {
  const [kind, id, idx] = String(data || '').split('|');
  if (kind !== 'o' || !id) return null;
  const raw = await redis.get(`tg:cb:${botId}:${id}`); if (!raw) return { expired: true };
  const rec = JSON.parse(raw); return { id, rec, option: rec.options[Number(idx)] };
}
/** Una sola elección por grupo de botones (evita dobles pulsaciones o que dos personas elijan a la vez). */
export const claimChoice = (botId, id, userId) => redis.set(`tg:cbused:${botId}:${id}`, String(userId), 'EX', TTL, 'NX');

/** Menú fijo (ReplyKeyboard). Se envía la primera vez, al cambiar, con /start o /menu. */
export function replyKeyboard(buttons) {
  const b = parseButtons(buttons).filter((x) => !x.url); if (!b.length) return null;
  return { keyboard: layout(b).map((row) => row.map((x) => ({ text: x.text }))), resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Escribe o elige una opción' };
}
export async function menuNeeded(bot, chatId, text) {
  const m = bot.behavior?.buttons?.menu; if (!m?.enabled || !m.buttons?.length) return null;
  const ver = JSON.stringify(m.buttons); const key = `tg:menu:${bot._id}:${chatId}`;
  const force = /^\/(start|menu)\b/i.test(text || '');
  if (!force && (await redis.get(key)) === ver) return null;
  await redis.set(key, ver, 'EX', 180 * 86400);
  return replyKeyboard(m.buttons);
}

/** Herramientas del agente para mostrar botones. */
export function buttonTools(bot) {
  const cfg = bot.behavior?.buttons || {}; const tools = [];
  if (cfg.agent !== false) tools.push({ name: 'show_options', description: 'Añade botones bajo tu respuesta para que el usuario elija con un toque (2–8 opciones cortas). Úsalo cuando haya que decidir entre pocas alternativas: tipo de servicio, sí/no, franjas horarias, confirmar… Tu respuesta de texto DEBE incluir la pregunta o explicación a la que responden los botones (por ejemplo «¿Para qué tipo de instalación es?»), sin enumerar las opciones. Para un enlace usa "Texto | https://…".', schema: { type: 'object', properties: { options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 } }, required: ['options'] } });
  const sets = (cfg.sets || []).filter((s) => s.name && s.buttons?.length);
  if (sets.length) tools.push({ name: 'show_button_set', description: `Muestra uno de los conjuntos de botones predefinidos por la empresa: ${sets.map((s) => `"${s.name}"${s.when ? ` (${s.when})` : ''}`).join('; ')}.`, schema: { type: 'object', properties: { name: { type: 'string', enum: sets.map((s) => s.name) } }, required: ['name'] } });
  return tools;
}
export const buttonsPrompt = (bot) => (bot.behavior?.buttons?.agent === false && !(bot.behavior?.buttons?.sets || []).length ? ''
  : '\n## Botones\n- Cuando el usuario tenga que elegir entre pocas opciones, ofrécelas como botones (show_options o show_button_set) en vez de enumerarlas: es más rápido para él.\n- Cuando el usuario pulsa un botón te llega como «[Botón pulsado] opción»: trátalo como su respuesta y continúa.');
