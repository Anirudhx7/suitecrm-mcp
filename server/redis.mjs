/**
 * redis.mjs — Singleton Redis client for SuiteCRM MCP Gateway
 * Uses ioredis. Connects via REDIS_URL env var.
 * All other modules should import { redis } from './redis.mjs'.
 */
import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ base: { module: 'redis' }, timestamp: pino.stdTimeFunctions.isoTime });

const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
let safeUrl = REDIS_URL;
try { const u = new URL(REDIS_URL); if (u.password) { u.password = '***'; safeUrl = u.toString(); } } catch { /* ignore */ }

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  connectTimeout: 5000,
  commandTimeout: 3000,
});

redis.on('connect', () => logger.info({ url: safeUrl }, 'redis_connected'));
redis.on('ready',   () => logger.info('redis_ready'));
redis.on('error',   (err) => logger.error({ err: err.message }, 'redis_error'));
redis.on('close',   () => logger.warn('redis_disconnected'));
redis.on('reconnecting', (ms) => logger.warn({ ms }, 'redis_reconnecting'));
