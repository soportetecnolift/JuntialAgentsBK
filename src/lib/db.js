import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

mongoose.set('strictQuery', true);
let connecting = null;
export async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  if (connecting) return connecting;
  connecting = mongoose.connect(env.MONGO_URI, { maxPoolSize: Number(process.env.MONGO_POOL || 50), minPoolSize: 2, serverSelectionTimeoutMS: 10000 });
  await connecting;
  logger.info('MongoDB conectado');
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));
}
export const disconnectDB = () => mongoose.disconnect();
