import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

mongoose.set('strictQuery', true);
export async function connectDB() {
  await mongoose.connect(env.MONGO_URI, { maxPoolSize: 50, minPoolSize: 5, serverSelectionTimeoutMS: 10000 });
  logger.info('MongoDB conectado');
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));
}
export const disconnectDB = () => mongoose.disconnect();
