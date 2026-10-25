import pino from 'pino';
import { env, isProd } from './env.js';

// Logs estructurados JSON (Datadog/Loki/CloudWatch). Secretos redactados siempre.
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME || 'juntialagents', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-telegram-bot-api-secret-token"]',
      '*.password', '*.token', '*.apiKey', '*.accessToken', '*.refreshToken', '*.clientSecret', '*.secret',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});
