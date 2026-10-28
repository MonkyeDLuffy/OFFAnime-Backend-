/**
 * Lightweight, serverless-friendly structured logger.
 *
 * Design goals:
 *   - Zero dependencies; writes JSON lines to stdout/stderr via `console`.
 *   - No local file writes (serverless filesystems are ephemeral/read-only).
 *     Log aggregation is the platform's job (Vercel/Cloudflare capture stdout).
 *   - Level-filtered via LOG_LEVEL so cold-start logs stay cheap.
 *   - Structured context object so future dashboards can filter by provider,
 *     endpoint, cache result, latency, requestId, etc.
 *
 * Usage:
 *   logger.info('cache.hit', { key, state });
 *   logger.error('provider.failed', { provider, err });
 *   const reqLog = logger.child({ requestId });  // bound context
 */

import { config } from '../config/env.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const activeLevel = LEVELS[String(config.LOG_LEVEL).toLowerCase()] ?? LEVELS.info;

/**
 * Convert an Error into a plain, log-safe object (no functions, bounded shape).
 * @param {unknown} value
 */
function serializeError(value) {
  if (!(value instanceof Error)) return value;
  /** @type {Record<string, unknown>} */
  const out = { name: value.name, message: value.message };
  // Include useful fields set by AppError subclasses when present.
  for (const key of ['code', 'statusCode', 'provider', 'layer', 'details']) {
    if (key in value && value[key] !== undefined) out[key] = value[key];
  }
  // Stacks are helpful in dev; keep them out of production noise.
  if (!config.IS_PRODUCTION && value.stack) out.stack = value.stack;
  return out;
}

/**
 * @param {Record<string, unknown>} context
 */
function sanitizeContext(context) {
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = key === 'err' || key === 'error' ? serializeError(value) : value;
  }
  return out;
}

/**
 * @param {keyof typeof LEVELS} level
 * @param {string} message
 * @param {Record<string, unknown>} baseContext
 * @param {Record<string, unknown>} [context]
 */
function write(level, message, baseContext, context = {}) {
  if (LEVELS[level] < activeLevel) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...baseContext,
    ...sanitizeContext(context),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * @param {Record<string, unknown>} baseContext
 */
function createLogger(baseContext = {}) {
  return {
    /** @param {string} msg @param {Record<string, unknown>} [ctx] */
    debug: (msg, ctx) => write('debug', msg, baseContext, ctx),
    /** @param {string} msg @param {Record<string, unknown>} [ctx] */
    info: (msg, ctx) => write('info', msg, baseContext, ctx),
    /** @param {string} msg @param {Record<string, unknown>} [ctx] */
    warn: (msg, ctx) => write('warn', msg, baseContext, ctx),
    /** @param {string} msg @param {Record<string, unknown>} [ctx] */
    error: (msg, ctx) => write('error', msg, baseContext, ctx),
    /**
     * Create a child logger with additional bound context (e.g. requestId).
     * @param {Record<string, unknown>} childContext
     */
    child: (childContext) => createLogger({ ...baseContext, ...childContext }),
  };
}

/** Root logger. Prefer `logger.child({ requestId })` inside request handlers. */
export const logger = createLogger();
