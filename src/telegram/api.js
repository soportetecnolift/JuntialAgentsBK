import { redis, waitToken, takeToken } from '../lib/redis.js';
import { tgOut429 } from '../lib/metrics.js';

/**
 * Cliente Bot API con límites oficiales de Telegram aplicados de forma distribuida (Redis):
 *  - ~1 msg/s por chat privado · 20 msg/min por grupo · ~30 msg/s global por bot
 *  - Respeta 429 retry_after con "cooldown" compartido entre workers.
 */
export class TokenInvalidError extends Error { constructor() { super('Telegram token inválido'); this.code = 'TG_TOKEN_INVALID'; } }
const SEND_METHODS = new Set(['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument', 'sendVoice', 'sendChatAction', 'deleteMessage']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TgApi {
  constructor(token, botKey) { this.token = token; this.botKey = botKey || token.split(':')[0]; this.root = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'; this.base = `${this.root}/bot${token}`; }

  async limit(chatId, isGroup, lowPriority) {
    const cdKey = `tg:cd:${this.botKey}:${chatId ?? 'global'}`;
    const cd = await redis.pttl(cdKey); if (cd > 0) { if (lowPriority) return false; await sleep(cd); }
    const chatKey = `tg:out:${this.botKey}:${chatId}`;
    const [rate, cap] = isGroup ? [20 / 60, 4] : [1, 3];
    if (lowPriority) { // ediciones de progreso: si no hay hueco, se omiten (nunca bloquean la respuesta final)
      if ((await takeToken(chatKey, rate, cap)) > 0) return false;
    } else if (chatId != null) await waitToken(chatKey, rate, cap, 120000);
    await waitToken(`tg:out:${this.botKey}`, 25, 30, 30000);
    return true;
  }

  async call(method, params = {}, { isGroup = false, lowPriority = false, retries = 3 } = {}) {
    const chatId = params.chat_id;
    if (SEND_METHODS.has(method) && method !== 'sendChatAction') {
      const ok = await this.limit(chatId, isGroup, lowPriority);
      if (!ok) return { skipped: true };
    }
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (data.ok) return data.result;
    if (data.error_code === 401 || data.error_code === 404) throw new TokenInvalidError();
    if (data.error_code === 429) {
      tgOut429.inc();
      const ra = (data.parameters?.retry_after || 3) * 1000;
      await redis.set(`tg:cd:${this.botKey}:${chatId ?? 'global'}`, 1, 'PX', ra);
      if (lowPriority || retries <= 0) return { skipped: true };
      await sleep(ra); return this.call(method, params, { isGroup, retries: retries - 1 });
    }
    if (/message is not modified/i.test(data.description)) return { notModified: true };
    if (data.parameters?.migrate_to_chat_id) { const e = new Error('chat migrated'); e.migrateTo = data.parameters.migrate_to_chat_id; throw e; }
    const e = new Error(`Telegram ${method}: ${data.description}`); e.tg = data; throw e;
  }

  getMe() { return this.call('getMe'); }
  setWebhook(url, secret) {
    return this.call('setWebhook', { url, secret_token: secret, max_connections: 100, drop_pending_updates: false,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'my_chat_member', 'chat_member'] });
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: false }); }
  async downloadFile(fileId, maxBytes = 20 * 1024 * 1024) {
    const f = await this.call('getFile', { file_id: fileId });
    if (f.file_size > maxBytes) throw new Error('Archivo demasiado grande');
    const res = await fetch(`${this.root}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
    return { buffer: Buffer.from(await res.arrayBuffer()), path: f.file_path };
  }
}

/* ── Formato: Markdown del LLM → HTML de Telegram (seguro) ── */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function mdToTgHtml(md = '') {
  const blocks = [];
  let s = md.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(code.trim())}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/** Divide respetando el máximo de 4096 caracteres, cortando en saltos de línea. */
export function splitMessage(text, max = 3900) {
  if (text.length <= max) return [text];
  const parts = []; let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max); if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max); if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
