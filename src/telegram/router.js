/**
 * Decide si un mensaje se responde, solo se guarda como contexto o se ignora.
 * Privado: siempre. Grupos (modo "mention", por defecto): @bot, respuesta a un mensaje del bot,
 * /comando@bot, o palabras clave configuradas.
 */
export function classify(bot, msg) {
  const chatType = msg.chat?.type;
  if (!msg.from || msg.from.is_bot) return { action: 'ignore' };
  const text = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  const uname = (bot.telegram.username || '').toLowerCase();
  if (chatType === 'private') return { action: 'respond', text };
  if (chatType === 'channel') return { action: 'ignore' };

  const mode = bot.behavior?.groupMode || 'mention';
  const ent = (e) => text.substr(e.offset, e.length);
  const mentioned = entities.some((e) => (e.type === 'mention' && ent(e).toLowerCase() === `@${uname}`) || (e.type === 'text_mention' && e.user?.id === bot.telegram.botId));
  const isReplyToBot = msg.reply_to_message?.from?.id === bot.telegram.botId;
  const cmd = entities.find((e) => e.type === 'bot_command' && e.offset === 0);
  const cmdForMe = cmd && (!ent(cmd).includes('@') || ent(cmd).toLowerCase().endsWith(`@${uname}`));
  const keyword = (bot.behavior?.triggerKeywords || []).some((k) => k && text.toLowerCase().includes(k.toLowerCase()));

  const addressed = mode === 'always' || (mode === 'commands' ? cmdForMe : mentioned || isReplyToBot || cmdForMe || keyword);
  if (addressed) {
    const clean = text.replace(new RegExp(`@${uname}\\b`, 'ig'), '').trim();
    return { action: 'respond', text: clean || text };
  }
  return { action: bot.behavior?.learnFromGroup ? 'context' : 'ignore', text };
}

/** Reduce el update a lo imprescindible para la cola (payload pequeño, sin datos innecesarios). */
export function slim(msg, text) {
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : null;
  const doc = msg.document ? { id: msg.document.file_id, mime: msg.document.mime_type, name: msg.document.file_name, size: msg.document.file_size } : null;
  return {
    id: msg.message_id, date: msg.date, threadId: msg.is_topic_message ? msg.message_thread_id : undefined,
    from: { id: msg.from.id, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username, username: msg.from.username },
    chat: { id: msg.chat.id, type: msg.chat.type, title: msg.chat.title, username: msg.chat.username },
    text, photo, doc,
    voice: msg.voice?.file_id || msg.audio?.file_id || msg.video_note?.file_id || null,
    replyText: msg.reply_to_message ? (msg.reply_to_message.text || msg.reply_to_message.caption || '').slice(0, 500) : undefined,
    replyFrom: msg.reply_to_message?.from?.first_name,
  };
}
