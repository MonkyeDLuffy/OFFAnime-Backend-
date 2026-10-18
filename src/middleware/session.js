/**
 * User-session middleware (Supabase Auth sessions).
 *
 * Session resolution accepts, in deliberate order:
 *   1. `Authorization: Bearer <access_token>`  (universal primary mechanism -
 *      works from any frontend on any domain, through any trusted proxy).
 *   2. HttpOnly session cookie `offanime_session` (recommended for same-site
 *      deployments; the value never reaches client-side JavaScript).
 *
 * SECURITY: identity is NEVER taken from a client-submitted user id. The
 * access token is verified UPSTREAM with Supabase (GET /auth/v1/user) on every
 * protected request - there is no local decode step that could be spoofed, and
 * revocation/deletion takes effect immediately.
 *
 * CSRF: cookie-authenticated STATE-CHANGING requests additionally require the
 * request to be same-origin (Origin/Referer must match the configured CORS
 * allowlist). This is defense-in-depth on top of SameSite=Lax cookies: a
 * cross-site page cannot make the user's browser fire an authenticated
 * state-changing request. Bearer-token requests are immune to CSRF by
 * construction (browsers never attach them automatically) and skip the check.
 */

import { config } from '../config/env.js';
import { AUTH_COOKIES } from '../config/constants.js';
import { UnauthorizedError, SessionExpiredError, ForbiddenError } from '../errors/index.js';
import { verifyAccessToken, isAuthConfigured } from '../services/supabase-auth.service.js';

/**
 * Minimal RFC 6265 cookie parser for the session cookies (no dependency).
 * Non-cookie input or malformed pairs are ignored.
 * @param {string | undefined} header Raw Cookie header.
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const jar = {};
  if (typeof header !== 'string' || header.length === 0) return jar;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value) jar[name] = decodeURIComponent(value);
  }
  return jar;
}

/**
 * Extract the presented user session credentials from a request.
 * @param {import('express').Request} req
 * @returns {{ accessToken: string | null, via: 'header' | 'cookie' | null }}
 */
export function extractAccessToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1].trim()) return { accessToken: match[1].trim(), via: 'header' };
  }
  const cookie = parseCookies(req.headers.cookie)[AUTH_COOKIES.ACCESS];
  if (typeof cookie === 'string' && cookie.trim()) return { accessToken: cookie.trim(), via: 'cookie' };
  return { accessToken: null, via: null };
}

/**
 * Whether `credentials: include`-style cookie auth is even plausible: the
 * request must carry the session cookie. Used by the CSRF gate.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isCookieAuthenticated(req) {
  const cookie = parseCookies(req.headers.cookie)[AUTH_COOKIES.ACCESS];
  return typeof cookie === 'string' && cookie.trim().length > 0;
}

/**
 * Allowed origins for the CSRF origin check (same list as CORS).
 * @returns {string[]}
 */
function allowedOrigins() {
  if (config.CORS_ORIGIN === '*') return [];
  return String(config.CORS_ORIGIN).split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);
}

/**
 * CSRF defense for cookie-authenticated state-changing requests: the Origin
 * (falling back to Referer) must match the configured allowlist. Requests
 * without either header (curl, server-to-server) are allowed - browsers DO
 * always send Origin on cross-origin fetch/XHR, which is the threat this
 * blocks.
 * @returns {import('express').RequestHandler}
 */
export function csrfOriginGuard() {
  return function csrfOriginGuardMiddleware(req, _res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    // Bearer-authenticated requests cannot be forged cross-site (no automatic
    // credential attachment), so the origin check is unnecessary.
    if (!isCookieAuthenticated(req)) return next();

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : '';
    const presented = origin || referer;
    if (!presented) return next(); // non-browser client

    let source;
    try {
      source = new URL(presented).origin.toLowerCase();
    } catch {
      return next(new ForbiddenError('Cross-site request rejected'));
    }
    const allow = allowedOrigins();
    if (allow.length > 0 && allow.includes(source)) return next();
    return next(new ForbiddenError('Cross-site request rejected'));
  };
}

/**
 * Require a valid user session (access token via header or cookie), verified
 * with Supabase Auth. Attaches `req.user` (safe shape) and `req.sessionVia`.
 * @returns {import('express').RequestHandler}
 */
export function requireUser() {
  return async function requireUserMiddleware(req, _res, next) {
    const { accessToken, via } = extractAccessToken(req);
    if (!accessToken) {
      return next(new UnauthorizedError('User authentication required'));
    }
    if (!isAuthConfigured()) {
      return next(new SessionExpiredError('User authentication is not configured'));
    }
    try {
      req.user = await verifyAccessToken(accessToken);
      req.sessionVia = via;
      return next();
    } catch {
      // The upstream rejected the token (expired/revoked/malformed) - never
      // distinguish which, and never echo the token.
      return next(new SessionExpiredError());
    }
  };
}
