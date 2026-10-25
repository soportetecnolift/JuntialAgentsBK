process.env.SERVICE_NAME ||= 'juntialagents-api';
import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDB, disconnectDB } from './lib/db.js';
import { redis } from './lib/redis.js';
import { createApp, corsOrigins } from './app.js';
import { initSocket } from './lib/socket.js';

await connectDB();
await (await import('./modules/center/access.js')).backfillMemberships().catch((err) => logger.warn({ err }, 'Juntial Center: migración de membresías'));
await (await import('./modules/plans/limits.js')).backfillPlanLimits().then((n) => n && logger.info({ plans: n }, 'Límites nuevos añadidos a planes existentes')).catch((err) => logger.warn({ err }, 'No se pudo revisar los límites de planes'));
const app = createApp();
const server = http.createServer(app);
server.keepAliveTimeout = 65000; server.headersTimeout = 66000; // detrás de ALB / nginx
initSocket(server, corsOrigins);
server.listen(env.PORT, () => logger.info(`API escuchando en :${env.PORT}`));

// Apagado ordenado: deja de aceptar conexiones, termina las activas y cierra recursos
let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  logger.info({ sig }, 'Cerrando API…');
  server.close(async () => { await disconnectDB(); await redis.quit(); process.exit(0); });
  setTimeout(() => process.exit(1), 15000).unref();
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
