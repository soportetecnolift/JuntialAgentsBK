import { DelayedError } from 'bullmq';
import { redis, acquireLock, releaseLock, extendLock } from '../lib/redis.js';
import { Bot, Message, daysFromNow } from '../models/index.js';
import { getBotRuntime, bumpBotVersion } from './runtime.js';
import { TokenInvalidError } from './api.js';
import { ProgressMessage } from './progress.js';
import { touchChat, buildSystemPrompt, loadHistory } from './context.js';
import { runAgent } from '../ai/agent.js';
import { applyModelChange } from '../ai/modelWatch.js';
import { transcribe } from '../ai/transcribe.js';
import { BUILTIN_TOOLS, builtinExecutor } from '../ai/builtins.js';
import { loadTools, callTool } from '../modules/mcp/client.js';
import { consumeMessage, getTenantPlan, limitOf } from '../modules/plans/limits.js';
import { emitEvent } from '../modules/webhooks/dispatcher.js';
import { notify } from '../modules/notifications/service.js';
import { botLog } from '../lib/audit.js';
import { agentStage } from '../lib/metrics.js';
import { crmTools, crmExecutor, crmPrompt } from '../modules/crm/agentTools.js';
import { buttonTools, buttonsPrompt, inlineKeyboard, attachMessage, menuNeeded, parseButtons } from './buttons.js';

const LOCK_MS = 180000;

/** Job "drain": procesa TODO lo pendiente de un chat, en serie, coalesciendo ráfagas. */
import { withTrace } from '../lib/trace.js';
export function drainChat(job, token) { return withTrace({ source: 'telegram', chatId: job.data.chatId }, () => drainChatInner(job, token)); }
async function drainChatInner(job, token) {
  const { botId, chatId } = job.data;
  const key = `${botId}:${chatId}`;
  const lockKey = `tg:lock:${key}`;
  const lock = await acquireLock(lockKey, LOCK_MS);
  if (!lock) { await job.moveToDelayed(Date.now() + 2000, token); throw new DelayedError(); }
  const keepAlive = setInterval(() => extendLock(lockKey, lock, LOCK_MS), 30000);
  try {
    for (let round = 0; round < 20; round++) {
      await redis.del(`tg:sched:${key}`);
      const [[, items]] = await redis.multi().lrange(`tg:pend:${key}`, 0, -1).del(`tg:pend:${key}`).exec();
      if (!items.length) break;
      await processBatch(botId, items.map((s) => JSON.parse(s)));
    }
  } finally {
    clearInterval(keepAlive); await releaseLock(lockKey, lock);
  }
}

async function mediaParts(rt, items) {
  // Descargas y transcripciones en paralelo; se respeta el orden de los mensajes
  let imgBudget = 5;
  const plan = items.map((it) => ({ it, img: (it.photo || it.doc?.mime?.startsWith('image/')) && imgBudget-- > 0 }));
  const per = await Promise.all(plan.map(async ({ it, img }) => {
    const parts = [];
    const who = `[${it.from.name}${it.from.username ? ` @${it.from.username}` : ''}]`;
    let text = it.text || '';
    if (it.replyText) text = `(respondiendo a ${it.replyFrom}: "${it.replyText.slice(0, 200)}")\n${text}`;
    try {
      if (it.photo && img) { const f = await rt.api.downloadFile(it.photo); parts.push({ type: 'image', mime: 'image/jpeg', data: f.buffer.toString('base64') }); text ||= '(imagen)'; }
      if (it.doc) {
        if (it.doc.mime === 'application/pdf' && it.doc.size < 15e6) { const f = await rt.api.downloadFile(it.doc.id); parts.push({ type: 'pdf', name: it.doc.name, data: f.buffer.toString('base64') }); }
        else if (it.doc.mime?.startsWith('image/') && img) { const f = await rt.api.downloadFile(it.doc.id); parts.push({ type: 'image', mime: it.doc.mime, data: f.buffer.toString('base64') }); }
        else if (/^text\/|json|csv|xml/.test(it.doc.mime || '') && it.doc.size < 2e5) { const f = await rt.api.downloadFile(it.doc.id); text += `\n[archivo ${it.doc.name}]\n${f.buffer.toString('utf8').slice(0, 30000)}`; }
        else text += `\n[archivo adjunto no legible: ${it.doc.name} (${it.doc.mime})]`;
      }
      if (it.voice) {
        const f = await rt.api.downloadFile(it.voice);
        const t = await transcribe(f.buffer, f.path.split('/').pop() || 'audio.ogg', rt.transcribeKey);
        text += t ? `\n🎤 (audio transcrito): ${t}` : '\n[audio recibido: transcripción no disponible, configura una clave OpenAI]';
      }
    } catch (e) { text += `\n[no se pudo leer el adjunto: ${e.message}]`; }
    parts.push({ type: 'text', text: `${who} ${text}`.trim() });
    return parts;
  }));
  return per.flat();
}

async function processBatch(botId, items) {
  const rt = await getBotRuntime(botId);
  if (!rt?.api || rt.bot.status !== 'active') return;
  const { bot, api } = rt;
  const last = items[items.length - 1];
  const chatId = last.chat.id; const isGroup = last.chat.type !== 'private';

  const quota = await consumeMessage(bot.tenantId);
  if (!quota.allowed) {
    if (await redis.set(`tg:quota:${botId}:${chatId}`, 1, 'EX', 3600, 'NX')) await api.call('sendMessage', { chat_id: chatId, text: 'Este asistente está temporalmente fuera de servicio.' }, { isGroup }).catch(() => {});
    return botLog(botId, 'warn', 'quota', 'Mensaje no procesado: cuota agotada o cuenta suspendida', { reason: quota.reason }, chatId);
  }

  const progress = new ProgressMessage(api, { chatId, threadId: last.threadId, replyTo: isGroup ? last.id : undefined, isGroup, enabled: bot.behavior?.progressMessages !== false });
  try {
    const T = { start: Date.now() };
    // Todo lo previo al modelo en PARALELO: mensaje de espera, contexto del chat, adjuntos, historial y catálogo de herramientas
    const started = progress.start(items.length > 1 ? `Leyendo ${items.length} mensajes` : 'Pensando')
      .then(() => { if (items.some((i) => i.photo || i.doc || i.voice)) progress.step('Analizando adjuntos'); });
    const [ctx, parts, history, { tools: mcpTools, routes }, crmT] = await Promise.all([
      touchChat(bot, items), mediaParts(rt, items),
      loadHistory(bot, chatId, last.threadId, (bot.behavior?.historyTurns || 20) * 2),
      loadTools(bot.mcpServerIds || []), crmTools(bot), started,
    ]);
    const crm = crmExecutor({ bot, channel: { kind: 'telegram', userId: last.from.id, chatId: last.chat.type === 'private' ? last.chat.id : last.from.id, username: last.from.username, name: last.from.name } });
    T.prep = Date.now() - T.start;
    const builtin = builtinExecutor({ bot, chatId, actor: last.from.name });
    let keyboard = null; // botones pedidos por el agente en este turno (se muestran bajo la respuesta final)
    const exec = async (name, args) => {
      try {
        const b = await builtin(name, args); if (b) { progress.step(`Memoria del chat: ${name.replace('chat_', '').replace('_', ' ')}`); return b; }
        if (name === 'show_options') { const opts = parseButtons(args?.options); if (opts.length < 2) return { isError: true, text: 'Indica al menos 2 opciones' }; keyboard = opts; progress.step('Preparando opciones'); return { text: 'Botones preparados: aparecerán debajo de tu mensaje. Asegúrate de que tu texto contiene la pregunta a la que responden (sin enumerar las opciones). Si ya la escribiste, no la repitas.' }; }
        if (name === 'show_button_set') { const set = (bot.behavior?.buttons?.sets || []).find((x) => x.name === args?.name); if (!set) return { isError: true, text: 'Conjunto no encontrado' }; keyboard = parseButtons(set.buttons); return { text: `Botones «${set.name}» preparados debajo de tu mensaje. Tu texto debe contener la pregunta a la que responden; si ya la escribiste, no la repitas.` }; }
        if (name.startsWith('crm_')) { progress.step(name === 'crm_update_contact' ? 'Actualizando la ficha del contacto' : 'Consultando la ficha del contacto'); return (await crm(name, args)) || { isError: true, text: 'Herramienta CRM desconocida' }; }
        const route = routes.get(name); if (!route) return { isError: true, text: `Herramienta desconocida ${name}. Usa find_tools si existe.` };
        progress.step(`Consultando ${route.label}`);
        const t0 = Date.now(); const r = await callTool(route, args);
        botLog(botId, r.isError ? 'warn' : 'info', 'tool', `${route.label} (${Date.now() - t0} ms)`, { ok: !r.isError, ms: Date.now() - t0 }, chatId);
        return r;
      } catch (e) { return { isError: true, text: e.message }; }
    };

    const agentArgs = (turns) => ({
      bot, apiKey: rt.aiKey, system: (() => { const sp = buildSystemPrompt(bot, ctx); return { ...sp, static: sp.static + crmPrompt(bot) + buttonsPrompt(bot) }; })(), turns,
      tools: [...BUILTIN_TOOLS, ...crmT, ...buttonTools(bot)], mcpTools, exec, hot: { bot: `hot:bot:${botId}`, chat: `hot:chat:${botId}:${chatId}` },
      onStep: (s) => progress.step(s), onText: (t) => progress.stream(t),
    });
    let result;
    try { result = await runAgent(agentArgs([...history, { role: 'user', parts }])); }
    catch (e) {
      // Si el proveedor rechaza la petición por el historial (400), se reintenta solo con el mensaje actual: el chat nunca queda bloqueado
      if (e.status !== 400 || !history.length) throw e;
      botLog(botId, 'warn', 'history.reset', `Historial rechazado por el proveedor (${e.message.slice(0, 120)}). Se responde sin historial.`, {}, chatId);
      result = await runAgent(agentArgs([{ role: 'user', parts }]));
    }
    if (result.modelChanged) applyModelChange(bot, result.modelChanged).catch(() => {});
    T.total = Date.now() - T.start;
    agentStage.observe({ stage: 'prep' }, T.prep / 1000); agentStage.observe({ stage: 'llm' }, result.timing.llmMs / 1000);
    agentStage.observe({ stage: 'tools' }, result.timing.toolMs / 1000); agentStage.observe({ stage: 'total' }, T.total / 1000);
    const s1 = (ms) => `${(ms / 1000).toFixed(1)} s`;
    botLog(botId, 'info', 'agent.turn', `Turno completado en ${s1(T.total)} · ${result.usage?.input || 0}→${result.usage?.output || 0} tokens · ${result.timing.steps} pasos`, { ms: T.total, model: bot.ai.model, provider: bot.ai.provider, steps: result.timing.steps, llmMs: result.timing.llmMs, toolMs: result.timing.toolMs, usage: result.usage, toolsOffered: result.toolsOffered, messages: items.length });
    botLog(botId, 'info', 'agent.timing', `Respondido en ${s1(T.total)} · preparación ${s1(T.prep)} · IA ${s1(result.timing.llmMs)} (${result.timing.steps} pasos) · herramientas ${s1(result.timing.toolMs)} · ${result.toolsOffered}/${result.catalogSize + BUILTIN_TOOLS.length} herramientas enviadas${result.usage.cacheRead ? ` · caché ${result.usage.cacheRead} tokens` : ''}`,
      { ...T, ...result.timing, usage: result.usage, toolMode: result.toolMode }, chatId);
    let kb = null;
    if (keyboard?.length) kb = await inlineKeyboard(bot._id, chatId, keyboard, { question: result.text });
    const menu = !kb && !isGroup ? await menuNeeded(bot, chatId, last.text) : null;
    if (kb && !result.text.trim()) result.text = 'Elige una opción:'; // nunca botones sin texto
    const sentIds = await progress.finish(result.text, { replyMarkup: kb?.markup || menu || undefined });
    if (kb) await attachMessage(bot._id, kb.id, { messageId: sentIds.at(-1), html: progress.lastHtml });

    const { plan } = await getTenantPlan(bot.tenantId);
    const exp = daysFromNow(limitOf(plan, 'historyDays'));
    const userText = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    await Message.insertMany([
      { botId: bot._id, chatId, threadId: last.threadId, role: 'user', from: last.from, text: userText.slice(0, 8000), tgMessageId: last.id, media: parts.filter((p) => p.type !== 'text').map((p) => p.type), expiresAt: exp },
      { botId: bot._id, chatId, threadId: last.threadId, role: 'assistant', text: (result.text.trim() || '(respuesta con botones)').slice(0, 8000), tgMessageId: sentIds[0], tokens: result.usage, expiresAt: exp },
    ]);
    Bot.updateOne({ _id: bot._id }, { $inc: { 'stats.messagesOut': 1 } }).catch(() => {});
    emitEvent(bot, 'message.replied', { chatId, chatTitle: ctx.title, project: ctx.project, from: last.from, input: userText.slice(0, 2000), output: result.text.slice(0, 4000), tools: result.calls, usage: result.usage });
    await redis.del(`bot:aierr:${botId}`);
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      await Bot.updateOne({ _id: botId }, { status: 'error', 'telegram.connected': false, 'telegram.lastError': 'Token inválido' });
      await bumpBotVersion(botId);
      const { tenant } = await getTenantPlan(bot.tenantId);
      notify(tenant.ownerId, 'bot.token_invalid', { username: bot.telegram.username, botId }).catch(() => {});
      return botLog(botId, 'error', 'token_invalid', 'Telegram rechazó el token');
    }
    botLog(botId, 'error', 'agent_error', err.message, { status: err.status }, chatId);
    emitEvent(bot, 'bot.error', { chatId, error: err.message });
    const n = await redis.incr(`bot:aierr:${botId}`); await redis.expire(`bot:aierr:${botId}`, 3600);
    if (n === 3) { const { tenant } = await getTenantPlan(bot.tenantId); notify(tenant.ownerId, 'bot.ai_error', { username: bot.telegram.username, botId, error: err.message.slice(0, 200) }).catch(() => {}); }
    await progress.fail(err.status === 401 ? 'La clave de IA de este bot no es válida.' : 'No pude procesar tu mensaje ahora mismo. Inténtalo de nuevo en unos minutos.').catch(() => {});
  }
}
