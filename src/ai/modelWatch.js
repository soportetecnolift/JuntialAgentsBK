import { Bot } from '../models/index.js';
import { decrypt } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { logger } from '../config/logger.js';
import { bumpBotVersion } from '../telegram/runtime.js';
import { getTenantPlan } from '../modules/plans/limits.js';
import { notify } from '../modules/notifications/service.js';
import { botLog } from '../lib/audit.js';
import { listModels, replacementFor, newerFor } from './models.js';
import { defaultModel } from './agent.js';

const owner = async (bot) => (await getTenantPlan(bot.tenantId)).tenant.ownerId;

/** Un modelo dejó de existir: si el bot tiene actualización automática se cambia; si no, se avisa (máx. 1/día). */
export async function applyModelChange(bot, { from, to }) {
  if (!to || to === from) return;
  if (bot.ai?.autoUpgrade !== false) {
    await Bot.updateOne({ _id: bot._id }, { 'ai.model': to, 'ai.modelStatus': { checkedAt: new Date(), available: true, newer: null } });
    await bumpBotVersion(bot._id);
    botLog(bot._id, 'warn', 'model.replaced', `El modelo ${from} ya no está disponible. Cambiado automáticamente a ${to}.`);
    notify(await owner(bot), 'bot.model_replaced', { username: bot.telegram?.username, from, to, botId: String(bot._id) }).catch(() => {});
  } else if (await redis.set(`model:unavail:${bot._id}:${from}`, 1, 'EX', 86400, 'NX')) {
    await Bot.updateOne({ _id: bot._id }, { 'ai.modelStatus': { checkedAt: new Date(), available: false, newer: to } });
    botLog(bot._id, 'error', 'model.unavailable', `El modelo ${from} ya no está disponible. Sugerido: ${to}.`);
    notify(await owner(bot), 'bot.model_unavailable', { username: bot.telegram?.username, from, to, botId: String(bot._id) }).catch(() => {});
  }
}

/** Revisión diaria de todos los bots: modelos retirados → sustituir/avisar; versiones nuevas → avisar una vez. */
export async function checkAllBotModels() {
  let checked = 0; let replaced = 0; let newer = 0;
  const cursor = Bot.find({ $or: [{ 'telegram.connected': true }, { kind: 'web' }] }).select('+ai.apiKeyEnc tenantId ai telegram.username').cursor();
  for await (const bot of cursor) {
    try {
      const key = decrypt(bot.ai.apiKeyEnc); if (!key) continue;
      const current = bot.ai.model || defaultModel(bot.ai.provider);
      const { models } = await listModels(bot.ai.provider, key);
      checked++;
      if (!models.some((m) => m.id === current)) {
        await applyModelChange(bot, { from: current, to: replacementFor(bot.ai.provider, models, current)?.id }); replaced++; continue;
      }
      const n = newerFor(models, current);
      await Bot.updateOne({ _id: bot._id }, { 'ai.modelStatus': { checkedAt: new Date(), available: true, newer: n?.id || null } });
      if (n && (await redis.set(`model:newer:${bot._id}:${n.id}`, 1, 'EX', 90 * 86400, 'NX'))) {
        newer++;
        notify(await owner(bot), 'bot.model_newer', { username: bot.telegram?.username, current, newer: n.name, newerId: n.id, botId: String(bot._id) }).catch(() => {});
      }
    } catch (err) { logger.warn({ botId: String(bot._id), err: err.message }, 'Revisión de modelo fallida'); }
    await new Promise((r) => setTimeout(r, 150)); // suave con las APIs
  }
  logger.info({ checked, replaced, newer }, 'Revisión diaria de modelos completada');
  return { checked, replaced, newer };
}
