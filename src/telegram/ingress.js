import { redis, takeToken } from '../lib/redis.js';
import { Q } from '../lib/queues.js';
import { sha256, safeEqual } from '../lib/crypto.js';
import { tgUpdates, tgDropped } from '../lib/metrics.js';
import { ChatContext, Message, Bot, daysFromNow } from '../models/index.js';
import { getBotRuntime } from './runtime.js';
import { classify, slim } from './router.js';
import { emitEvent } from '../modules/webhooks/dispatcher.js';
import { logger } from '../config/logger.js';
import { resolveCallback, claimChoice } from './buttons.js';

/**
 * Webhook de Telegram. Solo hace trabajo O(1) en Redis y responde 200 (Telegram reintenta si no).
 *
 * Mitigación de flood (100 mensajes seguidos en un chat) SIN cambiar la lógica del bot:
 *  1. Deduplicación por update_id (reintentos de Telegram).
 *  2. Buffer por chat acotado (maxPending): si se desborda se descartan los más antiguos.
 *  3. Debounce + coalescing: la ráfaga se procesa como UN solo turno del agente.
 *  4. Serialización por chat (lock distribuido): nunca 2 respuestas simultáneas al mismo chat;
 *     chats distintos se procesan en paralelo en todos los workers.
 *  5. Bucket por remitente: un único usuario no puede monopolizar el bot.
 *  6. Salida con límites oficiales de Telegram + manejo de 429 (ver api.js).
 */
export async function telegramWebhook(req, res) {
  const rt = await getBotRuntime(req.params.botId);
  if (!rt) return res.sendStatus(404);
  const header = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (!rt.bot.telegram.webhookSecretHash || !safeEqual(sha256(header), rt.bot.telegram.webhookSecretHash)) return res.sendStatus(401);

  const update = req.body || {};
  try {
    const fresh = await redis.set(`tg:upd:${rt.bot._id}:${update.update_id}`, 1, 'EX', 86400, 'NX');
    if (!fresh) { tgUpdates.inc({ outcome: 'duplicate' }); return res.sendStatus(200); }
    await route(rt, update);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err, botId: req.params.botId }, 'ingress error');
    res.sendStatus(500); // Telegram reintentará
  }
}

export async function route(rt, update) {
  const { bot } = rt;
  if (update.my_chat_member) {
    const m = update.my_chat_member; const status = m.new_chat_member?.status;
    await ChatContext.updateOne({ botId: bot._id, chatId: m.chat.id }, { $set: { tenantId: bot.tenantId, type: m.chat.type, title: m.chat.title, muted: ['left', 'kicked'].includes(status) } }, { upsert: true });
    emitEvent(bot, 'bot.membership', { chatId: m.chat.id, title: m.chat.title, status });
    return tgUpdates.inc({ outcome: 'membership' });
  }
  if (update.callback_query) {
    if (bot.status !== 'active') return rt.api?.call('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {});
    await onCallback(rt, update.callback_query); return tgUpdates.inc({ outcome: 'callback' });
  }
  const msg = update.message || update.edited_message;
  if (!msg || bot.status !== 'active') return tgUpdates.inc({ outcome: 'ignored' });
  if (bot.behavior?.allowedChatIds?.length && !bot.behavior.allowedChatIds.includes(msg.chat.id)) return tgUpdates.inc({ outcome: 'not_allowed' });

  // Migración de grupo a supergrupo: mover el contexto
  if (msg.migrate_to_chat_id) {
    await ChatContext.updateOne({ botId: bot._id, chatId: msg.chat.id }, { chatId: msg.migrate_to_chat_id }).catch(() => {});
    return;
  }

  const { action, text } = classify(bot, msg);
  if (action === 'ignore') return tgUpdates.inc({ outcome: 'ignored' });

  if (action === 'context') {
    if (!text) return;
    await Message.create({ botId: bot._id, chatId: msg.chat.id, threadId: msg.message_thread_id, role: 'context', from: { id: msg.from.id, name: msg.from.first_name }, text: text.slice(0, 2000), tgMessageId: msg.message_id, expiresAt: daysFromNow(7) });
    return tgUpdates.inc({ outcome: 'context' });
  }

  // ¿Este bot de Telegram es también la «voz» de un empleado digital? Si escribe alguien de su equipo (o el chat
  // de informes), la conversación es con el empleado, no con el bot de Telegram normal.
  if (action === 'respond' && text && !text.startsWith('/')) {
    const { workerForTelegramBot, identifyPerson } = await import('../modules/worker/conversation.js');
    const w = await workerForTelegramBot(bot._id);
    if (w) {
      const fromTeam = identifyPerson(w, { telegramChatId: msg.chat.type === 'private' ? msg.chat.id : null, telegramUsername: msg.from?.username });
      const reportChat = w.worker?.reporting?.chatId && Number(w.worker.reporting.chatId) === Number(msg.chat.id);
      if (fromTeam || reportChat) {
        if ((await takeToken(`tg:wk:${bot._id}:${msg.from.id}`, 0.2, 5)) > 0) return;
        await Q.workers.add('talk', { workerId: String(w._id), tgBotId: String(bot._id), chatId: msg.chat.id, from: { id: msg.from.id, username: msg.from.username, first_name: msg.from.first_name }, text: text.slice(0, 4000) }, { attempts: 1 });
        rt.api?.call('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
        return tgUpdates.inc({ outcome: 'worker' });
      }
    }
  }

  const key = `${bot._id}:${msg.chat.id}`;
  // Bucket por remitente: 30/min con ráfaga de 10
  if ((await takeToken(`tg:in:user:${key}:${msg.from.id}`, 0.5, 10)) > 0) {
    tgDropped.inc({ reason: 'sender_rate' });
    if (await redis.set(`tg:floodwarn:${key}:${msg.from.id}`, 1, 'EX', 120, 'NX')) {
      rt.api?.call('sendMessage', { chat_id: msg.chat.id, text: `⏳ ${msg.from.first_name}, estás enviando muchos mensajes. Los proceso en orden; espera un momento.`, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }, { isGroup: msg.chat.type !== 'private' }).catch(() => {});
    }
    return;
  }

  await enqueue(bot, msg.chat.id, slim(msg, text));
}

/** Añade un mensaje a la cola del chat (buffer acotado + debounce + lock por chat). */
async function enqueue(bot, chatId, item) {
  const key = `${bot._id}:${chatId}`;
  const max = bot.flood?.maxPending || 15;
  const pend = `tg:pend:${key}`;
  const [[, len]] = await redis.multi().rpush(pend, JSON.stringify(item)).ltrim(pend, -max, -1).expire(pend, 3600).exec();
  if (len > max) tgDropped.inc({ reason: 'buffer_overflow' }, len - max);
  if (await redis.set(`tg:sched:${key}`, 1, 'EX', 300, 'NX')) {
    await Q.chat.add('drain', { botId: String(bot._id), chatId }, {
      jobId: `drain-${key}-${Date.now()}`.replace(/:/g, '_'), delay: bot.flood?.debounceMs ?? 1200, attempts: 3, backoff: { type: 'exponential', delay: 3000 },
    });
  }
  Bot.updateOne({ _id: bot._id }, { $inc: { 'stats.messagesIn': 1 }, 'stats.lastActivityAt': new Date() }).catch(() => {});
  tgUpdates.inc({ outcome: 'queued' });
}

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Pulsación de un botón inline: confirmar al instante, marcar la elección y pasarla al agente como respuesta. */
async function onCallback(rt, cq) {
  const { bot, api } = rt; const answer = (text) => api.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: false } : {}) }).catch(() => {});
  // Aprobaciones del empleado digital: a|<id>|y/n
  if (String(cq.data).startsWith('a|')) {
    const [, id, yn] = cq.data.split('|');
    const { WorkerApproval } = await import('../models/index.js'); const { decideApproval } = await import('../modules/worker/engine.js');
    const ap = await WorkerApproval.findById(id).lean().catch(() => null);
    if (!ap || String(ap.tenantId) !== String(bot.tenantId)) return answer('Aprobación no encontrada');
    const who = cq.from.username ? `@${cq.from.username}` : cq.from.first_name;
    // ¿Quién pulsa? Aprobador del equipo del empleado → vota; administrador de la organización (Telegram vinculado
    // en Juntial Center) → decide; cualquier otro → solo si el empleado no tiene aprobadores definidos.
    const { Bot: BotM, Membership } = await import('../models/index.js'); const { voteApproval } = await import('../modules/worker/engine.js'); const { identifyPerson } = await import('../modules/worker/conversation.js');
    const wbot = await BotM.findById(ap.botId).lean();
    const person = identifyPerson(wbot, { telegramChatId: cq.message?.chat?.type === 'private' ? cq.message.chat.id : null, telegramUsername: cq.from.username });
    const admin = !person && cq.from.username ? await Membership.findOne({ orgId: bot.tenantId, telegramUsername: String(cq.from.username).toLowerCase(), status: 'active', orgRole: { $in: ['owner', 'admin'] } }).lean() : null;
    const except = { chatId: cq.message?.chat?.id, messageId: cq.message?.message_id };
    const out = await voteApproval(id, { approve: yn === 'y', person, by: person?.name || admin?.name || who, via: 'telegram', actor: { telegramUsername: cq.from.username }, override: !!admin, syncExcept: except });
    if (out.ok && out.status === 'pending') { answer(`🗳 ${out.info}`.slice(0, 190)); api.call('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {}); api.call('sendMessage', { chat_id: cq.message.chat.id, reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true }, text: `🗳 ${out.info}` }).catch(() => {}); return; }
    answer(out.ok ? (yn === 'y' ? '✅ Aprobada' : '❌ Rechazada') : out.error);
    if (out.ok || out.status === 'failed') api.call('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (out.ok || out.status === 'failed') api.call('sendMessage', { chat_id: cq.message.chat.id, reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true }, text: yn === 'y' ? (out.status === 'executed' ? `✅ Aprobada por ${person?.name || admin?.name || who} y ejecutada.` : `⚠️ Aprobada pero falló: ${out.error}`) : `❌ Rechazada por ${person?.name || admin?.name || who}. Lo tendrá en cuenta para la próxima.` }).catch(() => {});
    return;
  }
  const r = await resolveCallback(bot._id, cq.data);
  if (!r) return answer();
  if (r.expired || !r.option) return answer('Esta opción ha caducado. Escríbeme lo que necesitas.');
  if (!(await claimChoice(bot._id, r.id, cq.from.id))) return answer('Ya se eligió una opción en este mensaje.');
  answer(`✓ ${r.option.text}`);
  const msg = cq.message; const isGroup = msg?.chat?.type !== 'private';
  const who = isGroup ? ` (${escHtml(cq.from.first_name || '')})` : '';
  if (msg && r.rec.html) api.call('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${r.rec.html}\n\n✅ <b>${escHtml(r.option.text)}</b>${who}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } }, { isGroup }).catch(() => {});
  else if (msg) api.call('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, { isGroup }).catch(() => {});
  if (!msg) return;
  // ¿Respuesta a una pregunta de un empleado digital? Vuelve a él como tarea, no al chat del bot
  const workerId = await redis.get(`wk:q:${bot._id}:${r.id}`);
  if (workerId) { await Q.workers.add('answer', { botId: workerId, question: r.rec.q, answer: r.option.value || r.option.text }, { attempts: 2 }); return; }
  const q = r.rec.q ? ` (a tu mensaje: «${r.rec.q.replace(/\s+/g, ' ').slice(0, 160)}»)` : '';
  await enqueue(bot, msg.chat.id, {
    id: msg.message_id, date: Math.floor(Date.now() / 1000), threadId: msg.is_topic_message ? msg.message_thread_id : undefined,
    from: { id: cq.from.id, name: [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') || cq.from.username, username: cq.from.username },
    chat: { id: msg.chat.id, type: msg.chat.type, title: msg.chat.title, username: msg.chat.username },
    text: `[Botón pulsado] ${r.option.value || r.option.text}${q}`,
  });
}
