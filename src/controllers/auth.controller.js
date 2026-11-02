/**
 * User-authentication controllers (thin HTTP glue over supabase-auth.service).
 *
 *   POST /api/auth/signup           create an account (Supabase Auth)
 *   POST /api/auth/login            password grant -> user + session
 *   POST /api/auth/logout           revoke the presented session
 *   GET  /api/auth/me               current user (verified session required)
 *   POST /api/auth/refresh          rotate refresh token -> fresh session
 *   POST /api/auth/password-reset   request a password-reset email
 *   POST /api/auth/verify           exchange a one-time email token (signup /
 *                                   recovery link) for a session
 *   POST /api/auth/password-update  set a new password (session required)
 *   POST /api/auth/resend           RESERVED (501) - not activated.
 *
 * Conventions:
 *   - Passwords/emails are validated here (normalized + bounded) and passed to
 *     the service; they are NEVER logged and NEVER echoed in error details.
 *   - Session responses carry the tokens in the BODY (universal Bearer flow,
 *     works from any frontend/domain through the trusted proxy) and ALSO set
 *     HttpOnly cookies when AUTH_COOKIES_ENABLED (recommended same-site mode).
 *   - Token values never appear in logs, error details, or URLs.
 *
 * RATE LIMITING (see services/auth-throttle.service.js):
 *   - login: a DB-backed per-account failed-attempt limit (5 / 15 min, then a
 *     15-minute lock) plus a separate per-IP failure layer. Only FAILED
 *     credential attempts are counted; a successful login clears the counter.
 *   - signup: a per-IP attempt budget checked BEFORE the upstream call, plus
 *     duplicate suppression for recently-successful signups (no upstream call
 *     for repeated POSTs of the same address). Failed signups are never
 *     retried automatically.
 *   - Both layers are best-effort availability protection: when the tracker
 *     store is unavailable they fail OPEN (Supabase Auth still enforces its
 *     own upstream limits), and they NEVER replace input validation.
 */

import { asyncHandler } from '../utils/async-handler.js';
import { ValidationError, UnauthorizedError, InvalidCredentialsError } from '../errors/index.js';
import { config } from '../config/env.js';
import { AUTH_COOKIES, AUTH_VERIFY_TYPES } from '../config/constants.js';
import { extractClientIp } from '../utils/client-ip.js';
import {
  signUp,
  signInWithPassword,
  refreshSession,
  revokeSession,
  requestPasswordReset,
  verifyEmailToken,
  updatePassword,
} from '../services/supabase-auth.service.js';
import {
  assertLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
  gateSignupAttempt,
  assertSignupFresh,
  recordSignupSuccess,
} from '../services/auth-throttle.service.js';
import { extractAccessToken, parseCookies } from '../middleware/session.js';

// --- input validation -----------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Validate + normalize an email address.
 * @param {unknown} value
 * @returns {string}
 */
function requireEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError('A valid email address is required');
  }
  return email;
}

/**
 * Validate a password (bounds only - the value itself is never kept anywhere
 * beyond the lifetime of the upstream call).
 * @param {unknown} value
 * @returns {string}
 */
function requirePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`);
  }
  return value;
}

/**
 * Require a non-empty string field (trimmed, bounded).
 * @param {unknown} value
 * @param {string} label
 * @param {number} [maxLength]
 * @returns {string}
 */
function requireString(value, label, maxLength = 256) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > maxLength) {
    throw new ValidationError(`${label} is required`);
  }
  return trimmed;
}

// --- cookies ----------------------------------------------------------------------

/**
 * Set the HttpOnly session cookies (when enabled). Access cookie lifetime
 * follows the upstream session; the refresh cookie is path-scoped to /api/auth
 * so it is never attached to data requests.
 * @param {import('express').Response} res
 * @param {{ accessToken: string, refreshToken: string, expiresIn: number }} session
 */
function setSessionCookies(res, session) {
  if (!config.AUTH_COOKIES_ENABLED) return;
  const secure = config.IS_PRODUCTION;
  res.cookie(AUTH_COOKIES.ACCESS, session.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: session.expiresIn * 1000,
  });
  res.cookie(AUTH_COOKIES.REFRESH, session.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: AUTH_COOKIES.REFRESH_PATH,
    maxAge: config.AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS * 1000,
  });
}

/**
 * Clear both session cookies (logout / refresh rotation cleanup).
 * @param {import('express').Response} res
 */
function clearSessionCookies(res) {
  if (!config.AUTH_COOKIES_ENABLED) return;
  const options = { httpOnly: true, secure: config.IS_PRODUCTION, sameSite: 'lax' };
  res.clearCookie(AUTH_COOKIES.ACCESS, { ...options, path: '/' });
  res.clearCookie(AUTH_COOKIES.REFRESH, { ...options, path: AUTH_COOKIES.REFRESH_PATH });
}

/**
 * Build the session response body (tokens in body - the universal mechanism).
 * @param {import('../services/supabase-auth.service.js').SafeUser} user
 * @param {import('../services/supabase-auth.service.js').AuthSession|null} session
 * @returns {Record<string, unknown>}
 */
function sessionBody(user, session) {
  if (!session) {
    return { user, session: null, emailConfirmationRequired: true };
  }
  return {
    user,
    session: {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenType: session.tokenType,
      expiresIn: session.expiresIn,
      expiresAt: session.expiresAt,
    },
  };
}

// --- controllers ---------------------------------------------------------------------

/**
 * POST /api/auth/signup
 *
 * With email confirmation DISABLED upstream (OFFANIME's configuration),
 * GoTrue auto-confirms the account and returns a full session: the 201 body
 * carries it (and cookies when enabled), so the account is immediately usable
 * and NO verification email is sent. The `session: null` +
 * `emailConfirmationRequired: true` fallback is retained only for the case
 * where the provider still requires confirmation.
 * @type {import('express').RequestHandler}
 */
export const signupController = asyncHandler(async (req, res) => {
  const email = requireEmail(req.body?.email);
  const password = requirePassword(req.body?.password);
  const ip = extractClientIp(req);

  // Anti-abuse BEFORE the upstream call: per-IP attempt budget (registered
  // atomically), then duplicate suppression for a recent successful signup of
  // the same normalized address (409 without an upstream call).
  await gateSignupAttempt({ ip });
  await assertSignupFresh({ email });

  // Exactly ONE upstream call. Failed signups are NEVER retried
  // automatically: retries would multiply GoTrue's own rate-limit pressure.
  const result = await signUp({ email, password }, { forwardedIp: ip });
  if (result.session) setSessionCookies(res, result.session);

  // Remember the success (hashed email) so rapid duplicate POSTs skip the
  // upstream. Best effort - never affects the response.
  await recordSignupSuccess({ email });

  res.status(201).json(sessionBody(result.user, result.session));
});

/**
 * POST /api/auth/login
 *
 * Order matters for security + availability:
 *   1. input validation (never consumes counters),
 *   2. lock gate (typed 429 with retry info - identical for every address,
 *      so nothing is revealed about account existence),
 *   3. upstream credential check (the only step that can succeed),
 *   4. failure recording (only for InvalidCredentialsError) / success clear.
 * @type {import('express').RequestHandler}
 */
export const loginController = asyncHandler(async (req, res) => {
  const email = requireEmail(req.body?.email);
  const password = requireString(req.body?.password, 'Password', MAX_PASSWORD_LENGTH);
  const ip = extractClientIp(req);

  await assertLoginAllowed({ email, ip });

  let result;
  try {
    result = await signInWithPassword({ email, password }, { forwardedIp: ip });
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      // Only FAILED credential attempts count toward the limit. Best effort:
      // a tracker failure never changes the 401 that is thrown next.
      await recordLoginFailure({ email, ip });
    }
    throw err;
  }

  // Successful authentication resets the account's failed-attempt counter.
  await clearLoginFailures({ email });

  if (result.session) setSessionCookies(res, result.session);
  res.status(200).json(sessionBody(result.user, result.session));
});

/**
 * POST /api/auth/logout - requires a session (header or cookie); revokes it
 * upstream and clears cookies. Idempotent from the client's perspective.
 * @type {import('express').RequestHandler}
 */
export const logoutController = asyncHandler(async (req, res) => {
  const { accessToken } = extractAccessToken(req);
  if (!accessToken) {
    throw new UnauthorizedError('User authentication required');
  }
  await revokeSession(accessToken);
  clearSessionCookies(res);
  res.status(200).json({ ok: true });
});

/**
 * GET /api/auth/me - requires a verified session (requireUser middleware
 * attaches req.user).
 * @type {import('express').RequestHandler}
 */
export const meController = asyncHandler(async (req, res) => {
  res.status(200).json({ user: req.user });
});

/**
 * POST /api/auth/refresh - rotates the session. The refresh token comes from
 * the HttpOnly cookie (preferred, browsers cannot read it) or the request body
 * (universal Bearer flow).
 * @type {import('express').RequestHandler}
 */
export const refreshController = asyncHandler(async (req, res) => {
  const bodyToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  const cookieToken = parseCookies(req.headers.cookie)[AUTH_COOKIES.REFRESH] ?? '';
  const refreshToken = cookieToken.trim() || bodyToken;
  if (!refreshToken) {
    throw new ValidationError('A refresh token is required');
  }

  const result = await refreshSession(refreshToken, { forwardedIp: extractClientIp(req) });
  if (result.session) setSessionCookies(res, result.session);
  res.status(200).json(sessionBody(result.user, result.session));
});

/**
 * POST /api/auth/password-reset - requests a password-reset email. The
 * response is uniform regardless of whether the address exists (no user
 * enumeration).
 * @type {import('express').RequestHandler}
 */
export const passwordResetController = asyncHandler(async (req, res) => {
  const email = requireEmail(req.body?.email);
  await requestPasswordReset(email, { forwardedIp: extractClientIp(req) });
  res.status(200).json({ ok: true });
});

/**
 * POST /api/auth/verify - exchanges a one-time token from a confirmation or
 * recovery email link for a session.
 * @type {import('express').RequestHandler}
 */
export const verifyController = asyncHandler(async (req, res) => {
  const type = typeof req.body?.type === 'string' ? req.body.type.trim() : '';
  if (!AUTH_VERIFY_TYPES.includes(type)) {
    throw new ValidationError(`type must be one of: ${AUTH_VERIFY_TYPES.join(', ')}`);
  }
  const tokenHash = typeof req.body?.tokenHash === 'string' ? req.body.tokenHash.trim() : '';
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!tokenHash && !token) {
    throw new ValidationError('token (or tokenHash) is required');
  }
  const email = req.body?.email === undefined ? undefined : requireEmail(req.body.email);

  const result = await verifyEmailToken(
    { type, ...(tokenHash ? { tokenHash } : { token }), email },
    { forwardedIp: extractClientIp(req) },
  );
  if (result.session) setSessionCookies(res, result.session);
  res.status(200).json(sessionBody(result.user, result.session));
});

/**
 * POST /api/auth/password-update - sets a new password for the authenticated
 * user (requireUser middleware attaches req.user).
 * @type {import('express').RequestHandler}
 */
export const passwordUpdateController = asyncHandler(async (req, res) => {
  const password = requirePassword(req.body?.password);
  const { accessToken } = extractAccessToken(req);
  const user = await updatePassword({ accessToken, password }, { forwardedIp: extractClientIp(req) });
  res.status(200).json({ user });
});

// NOTE: POST /api/auth/resend is intentionally NOT implemented here. Email
// confirmation is disabled (no confirmation emails exist to resend) and the
// endpoint stays RESERVED for a future email feature. It is registered as an
// honest 501 in routes/auth.routes.js - activation requires a deliberate
// product decision (and a Supabase email provider configuration).
