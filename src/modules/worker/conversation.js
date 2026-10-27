/**
 * Conversaciones con el empleado digital fuera del panel: Telegram, su página web personal (una por persona del
 * equipo) y la API/webhook. Cada persona y canal tiene su propio hilo (WorkerMessage.conv), y el empleado sabe
 * quién le habla y si esa persona puede aprobar sus cambios.
 */
import { Bot, WorkerMessage, WorkerLink, daysFromNow } from '../../models/index.js';
import { Q } from '../../lib/queues.js';
import { sha256, randomToken } from '../../lib/crypto.js';
import { botLog } from '../../lib/audit.js';
import { runWorker } from './engine.js';

const norm = (x) => String(x || '').toLowerCase().replace(/^@/, '').trim();
const CHANNEL_LABEL = { telegram: 'Telegram', page: 'su página de chat', api: 'la API', email: 'email' };

/** Identifica a una persona del equipo por email, usuario/ID de Telegram o id. */
export function identifyPerson(bot, { email, telegramUsername, telegramChatId, personId } = {}) {
  const ppl = bot.worker?.people || [];
  if (personId) return ppl.find((p) => String(p._id) === String(personId)) || null;
  if (telegramChatId) { const p = ppl.find((x) => x.telegramChatId && Number(x.telegramChatId) === Number(telegramChatId)); if (p) return p; }
  if (telegramUsername) { const p = ppl.find((x) => x.telegramUsername && norm(x.telegramUsername) === norm(telegramUsername)); if (p) return p; }
  if (email) { const p = ppl.find((x) => x.email && norm(x.email) === norm(email)); if (p) return p; }
  return null;
}

/** Habla con el empleado como una persona concreta, por un canal concreto. Devuelve la respuesta. */
export async function talkToWorker(botId, { text, person, channel, conv, fromName }) {
  const hist = (await WorkerMessage.find({ botId, conv }).sort({ createdAt: -1 }).limit(12).lean()).reverse();
  const chatHistory = hist.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', parts: [{ type: 'text', text: m.text }] }));
  const name = person?.name || fromName || 'Alguien de fuera del equipo';
  await WorkerMessage.create({ botId, conv, channel, from: name, role: 'user', text: String(text).slice(0, 8000), expiresAt: daysFromNow(90) });
  const actor = { name, role: person?.role, channel: CHANNEL_LABEL[channel] || channel, canApprove: !!person?.canApprove, email: person?.email, telegramUsername: person?.telegramUsername, userId: person?.userId, personId: person?._id };
  const out = await runWorker({ botId, trigger: { type: 'chat', label: `${name} por ${actor.channel}` }, instruction: String(text), chatHistory, actor });
  const reply = out.skipped ? `Ahora mismo no puedo responder (${out.skipped}).` : (out.text || '…');
  await WorkerMessage.create({ botId, conv, channel, from: 'agent', role: 'assistant', text: reply, runId: out.run?._id, expiresAt: daysFromNow(90) });
  return { reply, runId: out.run?._id };
}

/** Envía un mensaje del empleado a una persona del equipo por su mejor canal disponible. */
export async function sendToPerson(bot, person, text) {
  const tgBot = bot.worker?.reporting?.telegramBotId;
  if (tgBot && person.telegramChatId) {
    await Q.inbound.add('api-send', { botId: String(tgBot), chatIds: [Number(person.telegramChatId)], mode: 'message', text }, { attempts: 3 });
    await WorkerMessage.create({ botId: bot._id, conv: `telegram:${person.telegramChatId}`, channel: 'telegram', from: 'agent', role: 'assistant', text, expiresAt: daysFromNow(90) }).catch(() => {});
    botLog(bot._id, 'info', 'worker.message', `→ ${person.name} (Telegram): ${text.slice(0, 120)}`);
    return { ok: true, channel: 'Telegram' };
  }
  if (person.email) {
    await Q.email.add('send', { to: person.email, subject: `${bot.worker?.title || bot.name}`, title: bot.worker?.title || bot.name, body: String(text).replace(/\n/g, '<br>') }, { attempts: 4 });
    botLog(bot._id, 'info', 'worker.message', `→ ${person.name} (email): ${text.slice(0, 120)}`);
    return { ok: true, channel: 'email' };
  }
  if (tgBot && person.telegramUsername) return { ok: false, error: `${person.name} aún no ha escrito al bot de Telegram (hace falta que le escriba una vez para poder contestarle)` };
  return { ok: false, error: `${person.name} no tiene Telegram ni email configurados` };
}

/* ───────── Telegram: el bot de informes también sirve para conversar ───────── */
/** Mensaje de Telegram dirigido al empleado (lo encola la entrada de Telegram). */
export async function handleTalkJob({ workerId, tgBotId, chatId, from, text }) {
  const bot = await Bot.findById(workerId).lean(); if (!bot) return;
  let person = identifyPerson(bot, { telegramChatId: chatId, telegramUsername: from?.username });
  // Primera vez que escribe alguien conocido por su usuario: se aprende su chat para poder escribirle después
  if (person && !person.telegramChatId && from?.username && chatId > 0) {
    await Bot.updateOne({ _id: bot._id, 'worker.people._id': person._id }, { $set: { 'worker.people.$.telegramChatId': chatId } }); person = { ...person, telegramChatId: chatId };
  }
  const { reply } = await talkToWorker(workerId, { text, person, channel: 'telegram', conv: `telegram:${chatId}`, fromName: from?.first_name });
  await Q.inbound.add('api-send', { botId: String(tgBotId), chatIds: [Number(chatId)], mode: 'message', text: reply }, { attempts: 3 });
}

/** ¿Este bot de Telegram es la «voz» de algún empleado? (cacheado en memoria 60 s) */
const voiceCache = new Map();
export async function workerForTelegramBot(tgBotId) {
  const k = String(tgBotId); const hit = voiceCache.get(k); if (hit && hit.exp > Date.now()) return hit.bot;
  const bot = await Bot.findOne({ kind: 'worker', status: 'active', 'worker.reporting.telegramBotId': tgBotId, 'worker.channels.telegramChat': true }).select('_id worker.people worker.reporting worker.title name').lean();
  voiceCache.set(k, { bot, exp: Date.now() + 60000 }); return bot;
}

/* ───────── Página de chat personal (HTML) ───────── */
export async function createPersonLink(bot, personId) {
  const raw = `wl_${randomToken(24)}`;
  await WorkerLink.deleteMany({ botId: bot._id, personId });
  await WorkerLink.create({ botId: bot._id, personId, tokenHash: sha256(raw) });
  return raw;
}
export async function resolveLink(raw) {
  const l = await WorkerLink.findOne({ tokenHash: sha256(String(raw || '')) }).lean(); if (!l) return null;
  const bot = await Bot.findById(l.botId).lean(); if (!bot || bot.kind !== 'worker') return null;
  const person = identifyPerson(bot, { personId: l.personId }); if (!person) return null;
  if (bot.worker?.channels?.pages === false) return null;
  WorkerLink.updateOne({ _id: l._id }, { lastUsedAt: new Date() }).catch(() => {});
  return { bot, person, conv: `page:${person._id}` };
}
