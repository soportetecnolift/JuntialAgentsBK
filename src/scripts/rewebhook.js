/**
 * Apunta los webhooks de TODOS los bots de Telegram conectados a la PUBLIC_API_URL actual, con un secreto nuevo.
 * Úsalo tras cambiar de servidor o de dominio:  npm run telegram:rewebhook
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Bot } from '../models/index.js';
import { decrypt, randomToken, sha256 } from '../lib/crypto.js';
import { TgApi } from '../telegram/api.js';
import { bumpBotVersion } from '../telegram/runtime.js';
import { redis } from '../lib/redis.js';

await mongoose.connect(env.MONGO_URI);
const bots = await Bot.find({ 'telegram.connected': true }).select('+telegram.tokenEnc name telegram').lean();
console.log(`Webhooks → ${env.PUBLIC_API_URL}/tg/<bot>  (${bots.length} bots conectados)\n`);
let ok = 0;
for (const b of bots) {
  try {
    const token = decrypt(b.telegram.tokenEnc); if (!token) throw new Error('No se pudo descifrar el token (¿ENCRYPTION_KEY distinta?)');
    const api = new TgApi(token, String(b._id)); const secret = randomToken(32);
    await api.setWebhook(`${env.PUBLIC_API_URL}/tg/${b._id}`, secret);
    await Bot.updateOne({ _id: b._id }, { 'telegram.webhookSecretHash': sha256(secret), 'telegram.lastError': null });
    await bumpBotVersion(b._id); ok++;
    console.log(`  ✓ ${b.name} (@${b.telegram.username})`);
  } catch (e) { console.log(`  ✗ ${b.name} (@${b.telegram?.username}): ${e.message}`); }
}
console.log(`\n${ok}/${bots.length} actualizados.`);
await mongoose.disconnect(); await redis.quit(); process.exit(ok === bots.length ? 0 : 1);
