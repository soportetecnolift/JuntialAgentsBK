import { ChatContext, Message } from '../models/index.js';

const PROJECT_RE = /\b([A-Z]{2,6}[-_ ]?\d{2,6})\b/;

/** Actualiza el contexto del chat (título, tipo, participantes) y detecta proyectos por el título. */
export async function touchChat(bot, items) {
  const first = items[items.length - 1];
  const q = { botId: bot._id, chatId: first.chat.id };
  const ctx = await ChatContext.findOneAndUpdate(q, {
    $set: { tenantId: bot.tenantId, type: first.chat.type, title: first.chat.title, username: first.chat.username, lastMessageAt: new Date() },
  }, { upsert: true, new: true });
  const seen = new Map(items.map((i) => [i.from.id, i.from.name]));
  (async () => { // en segundo plano: no retrasa la respuesta
    for (const [id, name] of seen) {
      const r = await ChatContext.updateOne({ ...q, 'participants.id': id }, { $set: { 'participants.$.lastSeen': new Date(), 'participants.$.name': name } });
      if (!r.matchedCount) await ChatContext.updateOne(q, { $push: { participants: { $each: [{ id, name, lastSeen: new Date() }], $slice: -200 } } });
    }
  })().catch(() => {});
  if (!ctx.project?.name && first.chat.title) {
    const m = first.chat.title.match(PROJECT_RE);
    if (m) { ctx.project = { name: first.chat.title, code: m[1].replace(/[_ ]/, '-') }; await ctx.save(); }
  }
  return ctx;
}

/** Playbooks: procedimientos que el agente sigue cuando se cumple su condición (marco agéntico con pasos controlados). */
export function playbooksSection(bot) {
  const list = (bot.playbooks || []).filter((p) => p.enabled !== false && p.name && p.steps);
  if (!list.length) return '';
  return ['', '## Procedimientos (playbooks)', 'Cuando la conversación encaje con uno, sigue sus pasos en orden, de forma natural y sin saltarte ninguno. Si el usuario se desvía, atiéndelo y retoma el procedimiento.',
    ...list.map((p, i) => `### ${i + 1}. ${p.name}\nCuándo: ${p.when || 'cuando aplique'}\nPasos:\n${p.steps}`)].join('\n');
}

/**
 * Devuelve { static, dynamic }:
 *  static  → instrucciones del bot + reglas (idénticas entre mensajes ⇒ se cachean en el proveedor)
 *  dynamic → fecha, chat, proyecto, notas y participantes (cambian ⇒ van después del punto de caché)
 */
export function buildSystemPrompt(bot, ctx, tz = 'Europe/Madrid') {
  const staticPart = [
    bot.systemPrompt,
    '',
    '## Reglas de respuesta (plataforma)',
    `- Canal: Telegram. Tu usuario es @${bot.telegram?.username || 'bot'}.`,
    '- Si llegan varios mensajes juntos, respóndelos de forma integrada en una sola respuesta.',
    '- Los mensajes marcados como [contexto] son conversación del grupo que no iba dirigida a ti: úsalos solo como contexto.',
    '- Si varias consultas a herramientas son independientes, pídelas a la vez en el mismo paso.',
    '- Formato: Markdown simple (negrita, listas, código). Sé conciso; nada de tablas.',
    `- Idioma por defecto: ${bot.behavior?.language || 'es'}, salvo que el usuario escriba en otro.`,
    playbooksSection(bot),
  ].filter(Boolean).join('\n');
  const now = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date());
  const d = ['## Contexto actual', `- Fecha y hora: ${now} (${tz}).`, `- Chat: ${ctx.type === 'private' ? 'conversación privada' : `grupo "${ctx.title}"`} (id ${ctx.chatId}).`];
  if (ctx.project?.name) d.push(`- Proyecto vinculado: ${ctx.project.name}${ctx.project.code ? ` [${ctx.project.code}]` : ''}${ctx.project.crmRef ? ` · CRM ${ctx.project.crmRef}` : ''}. ${ctx.project.description || ''}`);
  else if (ctx.type !== 'private') d.push('- Este grupo aún no tiene proyecto vinculado. Si el contexto lo deja claro, usa chat_set_project.');
  if (ctx.notes?.length) d.push('- Notas guardadas del chat:', ...ctx.notes.slice(-10).map((n) => `  • ${n.text}`));
  if (ctx.summary) d.push(`- Resumen previo: ${ctx.summary}`);
  if (ctx.participants?.length && ctx.type !== 'private') d.push(`- Participantes vistos: ${ctx.participants.slice(-15).map((p) => p.name).join(', ')}`);
  return { static: staticPart, dynamic: d.join('\n') };
}

/** Historial → turnos normalizados. Mensajes de contexto del grupo se agrupan dentro de turnos de usuario. */
export async function loadHistory(bot, chatId, threadId, limit) {
  const q = { botId: bot._id, chatId, ...(threadId ? { threadId } : {}) };
  const rows = (await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean()).reverse();
  const turns = [];
  for (const m of rows) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (!m.text || !String(m.text).trim()) continue; // un mensaje vacío nunca debe llegar al modelo
    const text = m.role === 'context' ? `[contexto] ${m.from?.name}: ${m.text}` : m.text;
    const last = turns[turns.length - 1];
    if (last?.role === role) last.parts[0].text += `\n${text}`; else turns.push({ role, parts: [{ type: 'text', text }] });
  }
  return turns;
}
