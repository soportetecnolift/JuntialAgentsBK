/**
 * Modo todo-en-uno: API + worker en un único proceso.
 * Pensado para planes gratuitos o pequeños (p. ej. un solo Web Service gratuito de Render).
 * En producción con tráfico, mejor dos servicios: node src/server.js y node src/worker.js.
 */
process.env.ALL_IN_ONE = '1';
process.env.SERVICE_NAME ||= 'juntialagents-all';
const { logger } = await import('./config/logger.js');
const api = await import('./server.js');
const worker = await import('./worker.js');
const { disconnectDB } = await import('./lib/db.js');
const { redis } = await import('./lib/redis.js');
logger.info('Modo todo-en-uno: API y worker en el mismo proceso');
let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  logger.info({ sig }, 'Cerrando (API y worker)…');
  setTimeout(() => process.exit(1), 25000).unref();
  await api.closeApi().catch(() => {});          // deja de aceptar peticiones
  await worker.closeWorkers().catch(() => {});   // termina los trabajos en curso
  await disconnectDB().catch(() => {}); await redis.quit().catch(() => {});
  process.exit(0);
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
