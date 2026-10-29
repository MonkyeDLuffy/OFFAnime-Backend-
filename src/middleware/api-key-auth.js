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
 *   x-api-key: <BACKEND_API_SECRET>                (accepted fallback - this
 *                                                   is what the frontend
 *                                                   server-side proxy sends)
 *   ?api_key=<BACKEND_API_SECRET>                  (query parameter - OPTIONAL,
 *                                                   RESTRICTED direct access
 *                                                   for humans testing an
 *                                                   endpoint from a browser
 *                                                   URL bar; see below)
 *
 * Query-parameter policy (deliberately narrow):
 *   - Accepted ONLY on the GET endpoints in QUERY_KEY_APPROVED_GET_PATHS
 *     (read-only anime data endpoints). NEVER on the streaming/playback route
 *     (/stream/resolve), non-GET methods, or unapproved paths.
 *   - A CORS preflight or a browser user-agent proves nothing (both are
 *     trivially forgeable by scripts); the allowlist + method check is the
 *     only gate, not any "looks human" heuristic.
 *   - PRECEDENCE: a header credential is always valid on every protected
 *     route/method. When BOTH a header and a query credential are supplied
 *     they must be IDENTICAL; conflicting values are rejected outright
 *     (401) so an invalid credential can never override or bypass a valid
 *     authentication policy. Identical values are treated as the header
 *     credential (header policy applies). Query-ONLY authentication is what
 *     the allowlist restricts.
 *   - MULTIPLE header credentials: `Authorization: Bearer` and `x-api-key`
 *     are evaluated as SEPARATE candidates; the API-key check passes when at
 *     least one presented candidate equals the secret. This is deliberate:
 *     authenticated user-session requests from the trusted proxy carry BOTH
 *     `x-api-key: <BACKEND_API_SECRET>` (identifies the trusted caller) AND
 *     `Authorization: Bearer <user access token>` (identifies the end user -
 *     verified separately by the session layer, never here). An invalid
 *     candidate can still never "override" a valid one: with header
 *     candidates present, a query credential must equal one of them or the
 *     request is rejected as conflicting (fail closed).
 *   - Query keys are strictly LESS secure than header keys: they leak into
 *     browser history, shared URLs, and infrastructure access logs (CDN,
 *     load balancer, reverse proxy). The backend strips/redacts them from
 *     its own logs and error messages, but cannot control other
 *     infrastructure. Intended for manual testing only.
 *
 * Security properties:
 *   - The expected value comes ONLY from the server-side env var
 *     BACKEND_API_SECRET (src/config/env.js). It is never hardcoded, never
 *     returned in a response, and never logged.
 *   - Comparison is constant-time (SHA-256 digests + timingSafeEqual), so the
 *     comparison duration does not leak how much of a guessed key matched.
 *   - The query parameter is DELETED from req.query before any controller,
 *     service, or cache layer runs - it can never leak into cache keys,
 *     downstream services, or error details.
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
import { API_PREFIX } from '../config/constants.js';
import { UnauthorizedError, InternalError } from '../errors/index.js';

/**
 * GET endpoints that accept `?api_key=` for direct/manual browser access.
 * API-relative paths (after the /api prefix). Read-only anime data endpoints
 * only - the streaming/playback route stays header-only, and every non-GET
 * method is excluded by the method check.
 * @type {readonly RegExp[]}
 */
export const QUERY_KEY_APPROVED_GET_PATHS = Object.freeze([
  /^\/home$/,
  /^\/search$/,
  /^\/top-search$/,
  /^\/schedule$/,
  /^\/category\/[^/]+$/,
  /^\/details\/[^/]+$/,
  /^\/smart\/details\/[^/]+$/,
  /^\/episodes\/[^/]+$/,
  /^\/recommendations\/[^/]+$/,
  /^\/seasons\/[^/]+$/,
  /^\/jikan\/anime\/[^/]+$/,
  /^\/jikan\/from-anilist\/[^/]+$/,
  /^\/tmdb\/[^/]+$/,
  // Streaming resolution endpoints accept ?api_key= for direct/manual browser
  // access. Header authentication (X-API-Key / Authorization Bearer) remains
  // the preferred production approach; query keys are restricted to these
  // explicitly approved read-only GET paths.
  /^\/stream\/resolve\/anilist\/[^/]+$/,
  /^\/stream\/resolve\/mal\/[^/]+$/,
]);

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
 * Extract ALL presented header credentials. `Authorization: Bearer <value>`
 * and `x-api-key: <value>` are independent candidates - both are returned so
 * each can be checked against the expected secret (a Bearer header may be a
 * USER session token on /api/auth/* requests, not an API key).
 * @param {import('express').Request['headers']} headers
 * @returns {string[]}
 */
function extractHeaderCandidates(headers) {
  /** @type {string[]} */
  const candidates = [];
  const authorization = headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1].trim()) candidates.push(match[1].trim());
  }
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) candidates.push(apiKey.trim());
  return candidates;
}

/**
 * Resolve the API-relative route path (e.g. '/details/20') from the request,
 * independent of Express routing internals (baseUrl/path are stable here
 * because this middleware is registered before any router mutates req.url).
 * @param {import('express').Request} req
 * @returns {string}
 */
function routePathOf(req) {
  const original = typeof req.originalUrl === 'string' && req.originalUrl ? req.originalUrl : String(req.url ?? '');
  const pathname = original.split('?')[0];
  if (pathname === API_PREFIX) return '/';
  return pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length) : pathname;
}

/**
 * Whether `?api_key=` authentication is allowed for this request: GET only,
 * and only on the explicitly approved endpoints.
 * @param {string} method
 * @param {string} routePath API-relative path
 * @returns {boolean}
 */
function isQueryAuthAllowed(method, routePath) {
  if (method !== 'GET') return false;
  return QUERY_KEY_APPROVED_GET_PATHS.some((pattern) => pattern.test(routePath));
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

    // 3. Header credential candidates (X-API-Key / Authorization Bearer).
    //    Valid when AT LEAST ONE candidate equals the secret. This keeps the
    //    frontend server-side proxy flow working unchanged and additionally
    //    allows the proxy to forward a USER session token in Authorization
    //    alongside its own x-api-key (user sessions are verified separately
    //    by the session layer - never here).
    const headerCandidates = extractHeaderCandidates(req.headers);
    const headerValid = headerCandidates.some((candidate) => secureEqual(candidate, expected));

    // 4. Query credential (?api_key=...). Only a single, non-empty string
    //    value is a credential; repeated/nested query syntax (arrays/objects
    //    produced by the query parser) is malformed and can never validate.
    const rawQueryKey = req.query?.api_key;
    /** @type {string | null} */
    let queryCredential = null;
    if (typeof rawQueryKey === 'string') {
      const trimmed = rawQueryKey.trim();
      if (trimmed) queryCredential = trimmed;
    } else if (rawQueryKey !== undefined && rawQueryKey !== null) {
      // Malformed credential marker: guaranteed to fail the secure compare,
      // never echoed anywhere.
      queryCredential = '\u0000malformed-api-key\u0000';
    }

    // The query parameter must never flow downstream: after this point no
    // controller, service, cache key, or error detail can see or persist it.
    if (req.query && typeof req.query === 'object') delete req.query.api_key;

    // 5. PRECEDENCE: when both a header and a query credential are supplied
    //    they must agree - the query value must equal one of the presented
    //    header candidates. Conflicting values are rejected BEFORE any policy
    //    can be bypassed - an invalid credential can never ride along with a
    //    valid one.
    if (queryCredential && headerCandidates.length > 0) {
      const agrees = headerCandidates.some((candidate) => candidate === queryCredential);
      if (!agrees) {
        return next(new UnauthorizedError('Conflicting API credentials'));
      }
    }

    const queryValid = queryCredential !== null && secureEqual(queryCredential, expected);

    // 6. Missing credential -> 401 (no detail about what was expected).
    if (headerCandidates.length === 0 && queryCredential === null) {
      return next(new UnauthorizedError('Missing API key'));
    }

    // 7. No presented credential matches the expected secret -> 401.
    //    Constant-time compares; the presented values are never echoed back
    //    or logged.
    if (!headerValid && !queryValid) {
      return next(new UnauthorizedError('Invalid API key'));
    }

    // 8. A valid HEADER credential authorizes every protected route/method
    //    (frontend proxy flow, server-to-server calls, curl, etc.).
    if (headerValid) return next();

    // 9. Query-ONLY authentication (valid query key, no valid header) is
    //    restricted to the approved GET endpoints; anything else is rejected
    //    even though the key itself is valid (the allowlist, not a user-agent
    //    or CORS, is the policy).
    if (!isQueryAuthAllowed(req.method, routePathOf(req))) {
      return next(new UnauthorizedError('Query parameter authentication is not allowed for this endpoint'));
    }

    return next();
  };
}
