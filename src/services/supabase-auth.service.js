/**
 * Supabase Auth (GoTrue) service - server-side identity provider client.
 *
 * Role: the ONLY place that talks to Supabase Auth. Controllers and middleware
 * call these functions; they never see raw GoTrue payloads, URLs, or keys.
 *
 * Security properties:
 *   - Uses the PUBLIC anon key ONLY (apikey header). The service-role key is
 *     NEVER used for authentication - GoTrue token endpoints are public by
 *     design, and keeping auth on the anon key means a future user-data layer
 *     can keep enforcing per-user RLS (the backend never acts as a superuser
 *     on behalf of users).
 *   - Passwords are sent ONLY in request bodies to GoTrue over TLS. They are
 *     never logged, never echoed in errors, never persisted.
 *   - GoTrue error bodies are mapped onto the typed error taxonomy; raw
 *     upstream payloads are never forwarded to clients (unknown fields could
 *     leak internals).
 *   - Tokens are returned to CALLERS only (the response of a login/signup/
 *     refresh); they never appear in logs or error details.
 *
 * Why a dedicated fetch wrapper (not providers/http-client.js): GoTrue
 * communicates errors IN THE RESPONSE BODY of non-2xx responses ("Invalid
 * login credentials", "Email not confirmed", ...). The shared provider client
 * throws on non-2xx before the body can be read, which would collapse every
 * auth failure into a generic 502. This wrapper mirrors the shared client's
 * timeout/abort behavior but returns non-2xx BODIES for precise mapping.
 */

import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  EmailNotConfirmedError,
  EmailTakenError,
  ForbiddenError,
  InvalidCredentialsError,
  RateLimitError,
  SessionExpiredError,
  AuthProviderError,
  ValidationError,
} from '../errors/index.js';

const AUTH_PATH = '/auth/v1';
/** Supabase Auth upstream identifier for logs and typed errors. */
export const AUTH_PROVIDER_NAME = 'supabase-auth';

/**
 * Whether the auth service is usable (server env configured). When false,
 * auth endpoints fail closed (see assertConfigured).
 * @returns {boolean}
 */
export function isAuthConfigured() {
  return Boolean(config.SUPABASE_URL) && Boolean(config.SUPABASE_ANON_KEY);
}

/**
 * Fail closed when Supabase Auth is not configured - a missing server-side
 * identity provider must never silently turn auth endpoints into broken or
 * (worse) permissive endpoints.
 */
function assertConfigured() {
  if (!isAuthConfigured()) {
    throw new AuthProviderError('User authentication is not configured', {
      details: { provider: AUTH_PROVIDER_NAME, reason: 'missing_configuration' },
    });
  }
}

/**
 * @typedef {Object} SafeUser
 * @property {string} id Supabase Auth user UUID.
 * @property {string} email
 * @property {string|null} emailConfirmedAt ISO timestamp or null when unconfirmed.
 * @property {string|null} createdAt
 * @property {string|null} lastSignInAt
 * @property {string|null} displayName From user_metadata.name / display_name.
 */

/**
 * @typedef {Object} AuthSession
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {string} tokenType Always 'bearer'.
 * @property {number} expiresIn Seconds until the access token expires.
 * @property {string} expiresAt ISO timestamp.
 */

/**
 * @typedef {Object} AuthResult
 * @property {SafeUser} user
 * @property {AuthSession|null} session null when the provider requires email
 *   confirmation before a session is issued.
 */

/**
 * Reduce a raw GoTrue user object to the safe, public representation.
 * NEVER includes app_metadata, roles, phone, providers, or raw metadata blobs.
 * @param {Record<string, unknown>} rawUser
 * @returns {SafeUser}
 */
export function toSafeUser(rawUser) {
  const meta = (rawUser?.user_metadata && typeof rawUser.user_metadata === 'object')
    ? rawUser.user_metadata
    : {};
  const displayName = typeof meta.name === 'string' && meta.name.trim()
    ? meta.name.trim()
    : (typeof meta.display_name === 'string' && meta.display_name.trim() ? meta.display_name.trim() : null);
  return {
    id: String(rawUser?.id ?? ''),
    email: typeof rawUser?.email === 'string' ? rawUser.email : '',
    emailConfirmedAt: rawUser?.email_confirmed_at ?? rawUser?.confirmed_at ?? null,
    createdAt: rawUser?.created_at ?? null,
    lastSignInAt: rawUser?.last_sign_in_at ?? null,
    displayName,
  };
}

/**
 * Normalize a GoTrue session payload (from signup / password grant / refresh
 * / verify) into the AuthSession shape, or null when no session was issued
 * (email confirmation required).
 * @param {Record<string, unknown>} raw
 * @returns {AuthSession|null}
 */
export function toSessionOrNull(raw) {
  const accessToken = raw?.access_token;
  const refreshToken = raw?.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) {
    return null;
  }
  const expiresIn = Number.isFinite(Number(raw?.expires_in)) ? Number(raw.expires_in) : 3600;
  const expiresAt = typeof raw?.expires_at === 'number'
    ? new Date(raw.expires_at * 1000).toISOString()
    : new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    accessToken,
    refreshToken,
    tokenType: 'bearer',
    expiresIn,
    expiresAt,
  };
}

/**
 * Build an AuthResult from a GoTrue payload that may or may not embed the
 * session at the top level (signup) vs beside the user (token grants).
 * @param {Record<string, unknown>} raw
 * @returns {AuthResult}
 */
function toAuthResult(raw) {
  const rawUser = raw?.user ?? raw; // token grants embed user at top level too
  return {
    user: toSafeUser(rawUser),
    session: toSessionOrNull(raw),
  };
}

/**
 * Map a GoTrue failure onto the typed error taxonomy. NEVER includes the raw
 * upstream body, the presented credentials, or the request body.
 * @param {number} status
 * @param {unknown} body Parsed JSON body (may be anything).
 * @param {Error} [cause]
 * @returns {Error}
 */
function mapGoTrueError(status, body, cause) {
  const code = typeof body?.error_code === 'string' ? body.error_code : '';
  const msg = typeof body?.msg === 'string'
    ? body.msg
    : (typeof body?.error_description === 'string' ? body.error_description : '');
  const haystack = `${code} ${msg}`.toLowerCase();

  if (haystack.includes('invalid login credentials') || haystack.includes('invalid_credentials')
    || haystack.includes('invalid grant')) {
    return new InvalidCredentialsError('Invalid email or password', { upstreamStatus: status });
  }
  if (haystack.includes('email not confirmed') || haystack.includes('email_not_confirmed')) {
    return new EmailNotConfirmedError('Email address is not confirmed', { upstreamStatus: status });
  }
  if (haystack.includes('already registered') || haystack.includes('already been registered')
    || haystack.includes('user_already_exists')) {
    return new EmailTakenError('An account with this email already exists', { upstreamStatus: status });
  }
  if (haystack.includes('signups not allowed') || haystack.includes('signup_disabled')) {
    return new ForbiddenError('Signups are currently not allowed', { upstreamStatus: status });
  }
  if (haystack.includes('too many requests') || haystack.includes('over_email_send_rate_limit')
    || haystack.includes('over_request_rate_limit')) {
    return new RateLimitError('Too many authentication attempts, please retry later', {
      provider: AUTH_PROVIDER_NAME,
      ...(typeof body?.retry_after === 'number' ? { retryAfterMs: body.retry_after * 1000 } : {}),
      details: { upstreamStatus: status },
      cause,
    });
  }
  // One-time tokens / sessions that the upstream rejected (expired links,
  // revoked sessions, malformed JWTs) - checked BEFORE the generic
  // email/password validation branch, because messages like "Email link is
  // invalid or has expired" also contain the word "email".
  if (haystack.includes('expired') || haystack.includes('session_not_found') || haystack.includes('jwt')
    || haystack.includes('claim') || (haystack.includes('invalid') && haystack.includes('token'))) {
    return new SessionExpiredError('Session is invalid or expired', { upstreamStatus: status });
  }
  if ((haystack.includes('invalid') && (haystack.includes('email') || haystack.includes('password')))
    || haystack.includes('should be at least')) {
    return new ValidationError('Invalid email or password format', { upstreamStatus: status });
  }
  // Unknown upstream failure - intentionally vague. Raw body is never echoed.
  return new AuthProviderError('Authentication provider rejected the request', {
    details: { provider: AUTH_PROVIDER_NAME, upstreamStatus: status },
    cause,
  });
}

/**
 * Perform a GoTrue request. Returns { status, data } WITHOUT throwing on
 * non-2xx so callers can map provider error bodies. Transport failures and
 * timeouts map onto typed errors exactly like the shared provider client.
 * @param {string} path Path under /auth/v1 (may include a query string).
 * @param {{ method?: string, body?: unknown, accessToken?: string }} [options]
 * @returns {Promise<{ status: number, data: unknown }>}
 */
async function gotrue(path, { method = 'GET', body, accessToken } = {}) {
  assertConfigured();
  const url = `${String(config.SUPABASE_URL).replace(/\/+$/, '')}${AUTH_PATH}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        apikey: config.SUPABASE_ANON_KEY,
        // The anon key doubles as the Authorization credential for GoTrue
        // (standard Supabase behavior) EXCEPT when a user access token is
        // presented, which must identify the CALLING user.
        ...(accessToken
          ? { Authorization: `Bearer ${accessToken}` }
          : { Authorization: `Bearer ${config.SUPABASE_ANON_KEY}` }),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    logger.debug('auth.http', {
      provider: AUTH_PROVIDER_NAME,
      method,
      path: path.split('?')[0],
      status: response.status,
      latencyMs: Date.now() - startedAt,
    });
    const data = await parseJson(response);
    return { status: response.status, data };
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new AuthProviderError('Authentication provider timed out', {
        details: { provider: AUTH_PROVIDER_NAME },
        cause: err instanceof Error ? err : undefined,
      });
    }
    throw new AuthProviderError('Authentication provider is unreachable', {
      details: { provider: AUTH_PROVIDER_NAME },
      cause: err instanceof Error ? err : undefined,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Assert a GoTrue response is successful; otherwise map + throw.
 * @param {{ status: number, data: unknown }} response
 * @returns {{ status: number, data: unknown }}
 */
function assertOk(response) {
  if (response.status < 200 || response.status >= 300) {
    throw mapGoTrueError(response.status, response.data);
  }
  return response;
}

// --- Public API -----------------------------------------------------------------

/**
 * Create a new account (Supabase Auth signup). Email confirmation behavior is
 * entirely the provider's (dashboard setting): a session is returned only when
 * the provider auto-confirms.
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<AuthResult>}
 */
export async function signUp({ email, password }) {
  const response = assertOk(await gotrue('/signup', { method: 'POST', body: { email, password } }));
  return toAuthResult(response.data);
}

/**
 * Authenticate email+password (password grant). Throws
 * InvalidCredentialsError / EmailNotConfirmedError / RateLimitError as mapped.
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<AuthResult>}
 */
export async function signInWithPassword({ email, password }) {
  const response = assertOk(
    await gotrue('/token?grant_type=password', { method: 'POST', body: { email, password } }),
  );
  return toAuthResult(response.data);
}

/**
 * Exchange a refresh token for a fresh session (rotation: the old refresh
 * token is invalidated by the provider - reuse detection is upstream).
 * @param {string} refreshToken
 * @returns {Promise<AuthResult>}
 */
export async function refreshSession(refreshToken) {
  const response = assertOk(
    await gotrue('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } }),
  );
  return toAuthResult(response.data);
}

/**
 * Verify an access token with the provider (GET /auth/v1/user). This is the
 * session-verification primitive: it NEVER trusts a user id submitted by a
 * client - identity comes from what the token proves upstream.
 * @param {string} accessToken
 * @returns {Promise<SafeUser>}
 */
export async function verifyAccessToken(accessToken) {
  const response = assertOk(await gotrue('/user', { accessToken }));
  return toSafeUser(response.data);
}

/**
 * Revoke a session server-side (logout). Invalid/already-revoked tokens are
 * tolerated - logout must be idempotent for the client.
 * @param {string} accessToken
 * @returns {Promise<void>}
 */
export async function revokeSession(accessToken) {
  const response = await gotrue('/logout', { method: 'POST', accessToken });
  if (response.status !== 204 && (response.status < 200 || response.status >= 300)) {
    logger.debug('auth.logout', { provider: AUTH_PROVIDER_NAME, upstreamStatus: response.status });
  }
}

/**
 * Request a password-reset email. The response is intentionally uniform - the
 * provider does not reveal whether the address exists.
 * @param {string} email
 * @returns {Promise<void>}
 */
export async function requestPasswordReset(email) {
  assertOk(await gotrue('/recover', { method: 'POST', body: { email } }));
}

/**
 * Resend a confirmation / recovery email.
 * @param {{ email: string, type: 'signup' | 'recovery' }} params
 * @returns {Promise<void>}
 */
export async function resendEmail({ email, type }) {
  assertOk(await gotrue('/resend', { method: 'POST', body: { email, type } }));
}

/**
 * Exchange a one-time email token (from a confirmation/recovery link) for a
 * session. Supports both the `token` (OTP) and `token_hash` (hashed link
 * token) fields.
 * @param {{ type: 'signup' | 'recovery', token?: string, tokenHash?: string, email?: string }} params
 * @returns {Promise<AuthResult>}
 */
export async function verifyEmailToken({ type, token, tokenHash, email }) {
  const body = {
    type,
    ...(tokenHash ? { token_hash: tokenHash } : { token }),
    ...(email ? { email } : {}),
  };
  const response = assertOk(await gotrue('/verify', { method: 'POST', body }));
  return toAuthResult(response.data);
}

/**
 * Update the authenticated user's password (requires a valid session).
 * @param {{ accessToken: string, password: string }} params
 * @returns {Promise<SafeUser>}
 */
export async function updatePassword({ accessToken, password }) {
  const response = assertOk(await gotrue('/user', { method: 'PUT', accessToken, body: { password } }));
  return toSafeUser(response.data);
}
