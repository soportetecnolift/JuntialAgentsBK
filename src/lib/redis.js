import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// BullMQ exige maxRetriesPerRequest: null
export const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
redis.on('error', (err) => logger.error({ err }, 'Redis error'));
export const createRedis = () => new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Token bucket atómico en Redis (Lua). Devuelve ms a esperar (0 = permitido).
 * Se usa para entrada (anti-flood) y salida (límites de Telegram).
 */
const BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])      -- tokens por segundo
local cap = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(data[1]) or cap
local ts = tonumber(data[2]) or now
tokens = math.min(cap, tokens + ((now - ts) / 1000) * rate)
local wait = 0
if tokens >= cost then tokens = tokens - cost else wait = math.ceil(((cost - tokens) / rate) * 1000) end
if wait == 0 then redis.call('HSET', key, 't', tokens, 'ts', now) end
redis.call('PEXPIRE', key, math.ceil((cap / rate) * 1000) + 1000)
return wait`;
redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: BUCKET_LUA });

export const takeToken = (key, ratePerSec, capacity, cost = 1) =>
  redis.tokenBucket(key, ratePerSec, capacity, Date.now(), cost).then(Number);

export async function waitToken(key, ratePerSec, capacity, maxWaitMs = 60000) {
  const start = Date.now();
  for (;;) {
    const wait = await takeToken(key, ratePerSec, capacity);
    if (wait === 0) return true;
    if (Date.now() - start + wait > maxWaitMs) return false;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Lock distribuido simple con token (liberación segura). */
export async function acquireLock(key, ttlMs) {
  const token = Math.random().toString(36).slice(2);
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return ok ? token : null;
}
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const EXTEND_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
export const releaseLock = (key, token) => redis.eval(RELEASE_LUA, 1, key, token);
export const extendLock = (key, token, ttlMs) => redis.eval(EXTEND_LUA, 1, key, token, ttlMs);
