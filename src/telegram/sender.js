import { getBotRuntime } from './runtime.js';
import { ProgressMessage } from './progress.js';
import { ChatContext, Message, daysFromNow } from '../models/index.js';
import { inlineKeyboard, attachMessage } from './buttons.js';
import { buildSystemPrompt, loadHistory } from './context.js';
import { runAgent } from '../ai/agent.js';
import { applyModelChange } from '../ai/modelWatch.js';
import { BUILTIN_TOOLS, builtinExecutor } from '../ai/builtins.js';
import { loadTools, callTool } from '../modules/mcp/client.js';

/** Envío proactivo (tareas programadas / webhooks entrantes): mensaje directo o ejecución del agente. */
export async function deliverToChats(botId, chatIds, { mode, text, buttons }) {
  const rt = await getBotRuntime(botId); if (!rt?.api) throw new Error('Bot sin conexión a Telegram');
  const results = [];
  for (const chatId of chatIds) {
    const ctx = (await ChatContext.findOne({ botId, chatId }).lean()) || { chatId, type: chatId > 0 ? 'private' : 'group', title: '' };
    const isGroup = ctx.type !== 'private';
    const pm = new ProgressMessage(rt.api, { chatId, isGroup, enabled: mode === 'agent' && rt.bot.behavior?.progressMessages !== false });
    const withButtons = async (finalText) => {
      const kb = buttons?.length ? await inlineKeyboard(botId, chatId, buttons, { question: finalText }) : null;
      const ids = await pm.finish(finalText, { replyMarkup: kb?.markup });
      if (kb) await attachMessage(botId, kb.id, { messageId: ids.at(-1), html: pm.lastHtml });
      // Queda en el historial: si el usuario responde (o pulsa un botón), el agente sabe a qué
      await Message.create({ botId, chatId, role: 'assistant', text: String(finalText).slice(0, 8000), tgMessageId: ids.at(-1), expiresAt: daysFromNow(30) }).catch(() => {});
      return ids;
    };
    if (mode !== 'agent') { results.push(await withButtons(text)); continue; }
    await pm.start('Ejecutando tarea programada');
    const [{ tools: mcpTools, routes }, history] = await Promise.all([loadTools(rt.bot.mcpServerIds || []), loadHistory(rt.bot, chatId, undefined, 10)]);
    const builtin = builtinExecutor({ bot: rt.bot, chatId, actor: 'tarea' });
    const exec = async (n, a) => (await builtin(n, a)) || (routes.get(n) ? (pm.step(`Consultando ${routes.get(n).label}`), callTool(routes.get(n), a)) : { isError: true, text: 'desconocida' });
    const r = await runAgent({ bot: rt.bot, apiKey: rt.aiKey, system: buildSystemPrompt(rt.bot, ctx), turns: [...history, { role: 'user', parts: [{ type: 'text', text: `[Tarea automática] ${text}` }] }], tools: BUILTIN_TOOLS, mcpTools, exec, hot: { bot: `hot:bot:${botId}`, chat: `hot:chat:${botId}:${chatId}` }, onStep: (s) => pm.step(s), onText: (t) => pm.stream(t) });
    if (r.modelChanged) applyModelChange(rt.bot, r.modelChanged).catch(() => {});
    results.push(await withButtons(r.text));
  }
  return results;
}
