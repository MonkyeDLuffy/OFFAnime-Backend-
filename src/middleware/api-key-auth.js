/**
 * Centralized API-key authentication middleware (Phase: API protection).
 *
 * Every protected /api/* route is gated by this ONE middleware - it is
 * registered centrally in routes/index.js (after the public /api/health
 * router, before every feature router) so controllers never duplicate
 * credential checks.
 *
 * Credential contract:
 *   Authorization: Bearer <BACKEND_API_SECRET>     (preferred)
 *   x-api-key: <BACKEND_API_SECRET>                (accepted fallback)
 *
 * Security properties:
 *   - The expected value comes ONLY from the server-side env var
 *     BACKEND_API_SECRET (src/config/env.js). It is never hardcoded, never
 *     returned in a response, and never logged.
 *   - Comparison is constant-time (SHA-256 digests + timingSafeEqual), so the
 *     comparison duration does not leak how much of a guessed key matched.
 *   - CORS `OPTIONS` preflight requests are NEVER blocked (the browser cannot
 *     attach custom headers to a preflight).
 *   - Fail closed in EVERY environment: a missing BACKEND_API_SECRET rejects
 *     all protected requests (500) instead of silently disabling
 *     authentication. There is no dev/test bypass - local development sets a
 *     secret in .env like production does on the platform dashboard.
 *
 * /api/health is intentionally PUBLIC (deployment probes cannot carry
 * secrets; the endpoint leaks no sensitive data). See routes/index.js and the
 * README "API key protection" section.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { config } from '../config/env.js';
import { UnauthorizedError, InternalError } from '../errors/index.js';

/**
 * Constant-time equality for two strings of ANY length: both are hashed to
 * fixed 32-byte digests first (timingSafeEqual requires equal lengths, and
 * comparing raw strings would leak length mismatches via early exit).
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function secureEqual(provided, expected) {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Extract the presented credential from request headers.
 * @param {import('express').Request['headers']} headers
 * @returns {string | null}
 */
function extractCredential(headers) {
  const authorization = headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}

/**
 * Build the API-key auth middleware.
 * @returns {import('express').RequestHandler}
 */
export function apiKeyAuth() {
  return function apiKeyAuthMiddleware(req, res, next) {
    // 1. CORS preflight: the browser sends OPTIONS without custom headers.
    if (req.method === 'OPTIONS') return next();

    const expected = typeof config.BACKEND_API_SECRET === 'string' ? config.BACKEND_API_SECRET : '';

    // 2. Fail closed when the secret is not configured (ALL environments -
    //    dev included). A missing server-side secret can never silently turn
    //    protected routes public; it is a server misconfiguration (500), not
    //    a client authentication problem (401).
    if (!expected) {
      return next(new InternalError('API authentication is not configured'));
    }

    // 3. Missing credential -> 401 (no detail about what was expected).
    const provided = extractCredential(req.headers);
    if (!provided) {
      return next(new UnauthorizedError('Missing API key'));
    }

    // 4. Invalid credential -> 401. Constant-time compare; the presented
    //    value is never echoed back or logged.
    if (!secureEqual(provided, expected)) {
      return next(new UnauthorizedError('Invalid API key'));
    }

    return next();
  };
}
