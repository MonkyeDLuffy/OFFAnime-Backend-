/**
 * Request logging middleware.
 *
 * Emits one structured line when a request completes, including method, path,
 * status code, and latency. Uses the per-request child logger (`req.log`) set
 * by the requestId middleware so every line carries the requestId; falls back
 * to the root logger if used standalone.
 *
 * Kept intentionally minimal and allocation-light to stay cold-start friendly.
 */

import { logger as rootLogger } from '../utils/logger.js';
import { redactApiKeyFromUrl } from '../utils/url-redact.js';

/** @returns {import('express').RequestHandler} */
export function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();
    const log = req.log ?? rootLogger;

    res.on('finish', () => {
      const context = {
        method: req.method,
        // The api_key query value (optional direct-access auth) is redacted -
        // raw query strings must never reach the logs with the secret intact.
        path: redactApiKeyFromUrl(req.originalUrl),
        status: res.statusCode,
        latencyMs: Date.now() - start,
      };
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level]('http.request', context);
    });

    next();
  };
}
