import { Bot } from '../models/index.js';
import { decrypt } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { TgApi } from './api.js';

// Caché en proceso con versión en Redis: cualquier cambio en el bot invalida todas las réplicas al instante.
const cache = new Map();
export const bumpBotVersion = (botId) => redis.incr(`bot:ver:${botId}`);

export async function getBotRuntime(botId) {
  const ver = (await redis.get(`bot:ver:${botId}`)) || '0';
  const hit = cache.get(String(botId));
  if (hit && hit.ver === ver && Date.now() - hit.at < 60000) return hit.rt;
  const bot = await Bot.findById(botId).select('+telegram.tokenEnc +telegram.webhookSecretHash +ai.apiKeyEnc +ai.transcribeKeyEnc').lean().catch(() => null);
  if (!bot) return null;
  const token = decrypt(bot.telegram.tokenEnc);
  const rt = {
    bot, api: token ? new TgApi(token, String(bot._id)) : null,
    aiKey: decrypt(bot.ai.apiKeyEnc), transcribeKey: decrypt(bot.ai.transcribeKeyEnc) || (bot.ai.provider === 'openai' ? decrypt(bot.ai.apiKeyEnc) : null),
  };
  cache.set(String(botId), { rt, ver, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return rt;
}
