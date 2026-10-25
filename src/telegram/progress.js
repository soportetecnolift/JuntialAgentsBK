import { mdToTgHtml, splitMessage } from './api.js';

/**
 * Mensaje "vivo": se envía un placeholder y se EDITA el mismo mensaje con cada paso
 * interno del agente, hasta sustituirlo por la respuesta final.
 * Ediciones con throttle (≥1.5 s) y baja prioridad: si Telegram limita, se omiten pasos
 * intermedios pero la respuesta final siempre se entrega.
 */
export class ProgressMessage {
  constructor(api, { chatId, threadId, replyTo, isGroup, enabled = true }) {
    Object.assign(this, { api, chatId, threadId, replyTo, isGroup, enabled });
    this.steps = []; this.messageId = null; this.lastEdit = 0; this.timer = null; this.typing = null;
  }
  base(extra = {}) {
    return { chat_id: this.chatId, ...(this.threadId ? { message_thread_id: this.threadId } : {}), ...extra };
  }
  render() {
    if (this.partial) return `${mdToTgHtml(this.partial.slice(-3500))} ▍`;
    const lines = this.steps.slice(-6).map((s, i, a) => `${i === a.length - 1 ? '⏳' : '✅'} ${s}`);
    return `<i>Procesando…</i>\n${lines.join('\n')}`;
  }
  async start(label = 'Pensando') {
    this.typing = setInterval(() => this.api.call('sendChatAction', this.base({ action: 'typing' })).catch(() => {}), 4500);
    this.api.call('sendChatAction', this.base({ action: 'typing' })).catch(() => {});
    if (!this.enabled) return;
    this.steps.push(label);
    const m = await this.api.call('sendMessage', this.base({ text: this.render(), parse_mode: 'HTML', ...(this.replyTo ? { reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true } } : {}) }), { isGroup: this.isGroup });
    this.messageId = m?.message_id; this.lastEdit = Date.now();
  }
  /** Texto que el modelo está escribiendo: se muestra en vivo (ediciones con throttle, nunca bloquean). */
  stream(text) {
    if (!this.enabled || !this.messageId || !text) return;
    this.partial = text; this.schedule(1200);
  }
  schedule(minGap) {
    if (this.timer) return;
    const due = minGap - (Date.now() - this.lastEdit);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(0, due));
  }
  step(label) {
    if (!this.enabled || !this.messageId) return;
    this.partial = null;
    this.steps.push(label);
    this.schedule(1500);
  }
  async flush() {
    this.lastEdit = Date.now();
    await this.api.call('editMessageText', this.base({ message_id: this.messageId, text: this.render(), parse_mode: 'HTML' }), { isGroup: this.isGroup, lowPriority: true }).catch(() => {});
  }
  /** Respuesta final: edita el placeholder con la 1ª parte y envía el resto como mensajes nuevos. */
  async finish(markdown, { replyMarkup } = {}) {
    clearTimeout(this.timer); this.timer = null; clearInterval(this.typing);
    const parts = splitMessage(markdown || '…');
    const ids = [];
    // El teclado de menú fijo no se puede añadir editando: se sustituye el mensaje de espera por uno nuevo
    if (replyMarkup?.keyboard && this.messageId) { await this.api.call('deleteMessage', this.base({ message_id: this.messageId }), { isGroup: this.isGroup }).catch(() => {}); this.messageId = null; }
    for (let i = 0; i < parts.length; i++) {
      const html = mdToTgHtml(parts[i]); const last = i === parts.length - 1;
      if (last) this.lastHtml = html;
      const send = async (useHtml) => {
        const payload = this.base({ text: useHtml ? html : parts[i], ...(useHtml ? { parse_mode: 'HTML' } : {}), link_preview_options: { is_disabled: true }, ...(last && replyMarkup ? { reply_markup: replyMarkup } : {}) });
        if (i === 0 && this.messageId) { await this.api.call('editMessageText', { ...payload, message_id: this.messageId }, { isGroup: this.isGroup }); return this.messageId; }
        const m = await this.api.call('sendMessage', { ...payload, ...(i === 0 && this.replyTo ? { reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true } } : {}) }, { isGroup: this.isGroup });
        return m?.message_id;
      };
      try { ids.push(await send(true)); } catch (e) { if (/parse entities/i.test(e.message)) ids.push(await send(false)); else throw e; }
    }
    return ids;
  }
  async fail(text) { return this.finish(`⚠️ ${text}`); }
}
