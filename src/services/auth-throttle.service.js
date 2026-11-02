/**
 * Auth throttle service - login attempt limiting + signup anti-abuse.
 *
 * PART A: per-account login attempt policy (enforced ATOMICALLY in Postgres):
 *   - Maximum AUTH_LOGIN_MAX_FAILURES failed login attempts per NORMALIZED
 *     account (lowercased/trimmed email, stored as a SHA-256 hash, never as
 *     plaintext) within AUTH_LOGIN_FAILURE_WINDOW_SECONDS.
 *   - After that window of failures, further login attempts for that account
 *     are blocked for AUTH_LOGIN_LOCK_SECONDS (the account recovers itself:
 *     once the window expires the counter starts over, and any SUCCESSFUL
 *     login immediately clears the counter).
 *   - A SEPARATE per-IP failure layer (AUTH_LOGIN_IP_MAX_FAILURES within the
 *     same window) throttles credential-stuffing floods from one source.
 *   - Only FAILED attempts are counted (never successful logins, never other
 *     accounts' activity, never failed signups): the counter is keyed on the
 *     normalized account identifier, so another person's repeated failed
 *     logins for THEIR OWN email can never lock someone else's account.
 *   - State lives in Supabase (auth_attempt_limits table + atomic RPC with a
 *     per-bucket advisory lock) so it is shared across ALL serverless
 *     instances. In-memory counters are never used in production. In-memory
 *     state is not used even as a fallback: if the tracker store is
 *     unavailable, the gate FAILS OPEN (login stays available; Supabase Auth
 *     enforces its own upstream limits) and never breaks logins.
 *
 * PART B: signup throttling:
 *   - Per-IP signup attempt cap registered atomically before the upstream
 *     GoTrue call, so floods do not burn Supabase Auth quota (and do not hit
 *     shared-IP upstream limits that would harm unrelated users).
 *   - Duplicate suppression: a SHORT-LIVED marker (hashed email) is stored
 *     after a successful signup; repeated signup POSTs for the same address
 *     answer 409 immediately without an upstream call (idempotency of the
 *     browser retry/double-submit case). Failures are never recorded, so a
 *     rate-limited or failed signup is never mistaken for success.
 *
 * No enumeration: the failure counter covers unknown emails too (GoTrue maps
 * "unknown email" onto the same invalid-credentials signal), so the 429 lock
 * never reveals whether an address is registered.
 */

import { createHash } from 'node:crypto';

import { config } from '../config/env.js';
import { EmailTakenError, RateLimitError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import { PostgrestClient } from '../supabase/rest-client.js';

/** Provider identifier used in errors/logs for OUR own throttle layer. */
export const AUTH_THROTTLE_PROVIDER = 'offanime-auth-limits';

/**
 * One-time warn per process when the throttle is unavailable (enabled but the
 * Supabase service-role configuration is missing) or failing.
 */
let warnedUnavailable = false;

/**
 * The backend-owned PostgREST client (service role, server-side only).
 * @type {PostgrestClient | null}
 */
let restClient = null;

/** Lazily build the client; returns null when not configured. */
function client() {
  if (!isAuthThrottleConfigured()) return null;
  if (!restClient) {
    restClient = new PostgrestClient({
      url: config.SUPABASE_URL,
      apiKey: config.SUPABASE_SERVICE_ROLE_KEY,
      // Short cap: the tracker sits on the login/signup critical path and
      // fails OPEN anyway, so a degraded Supabase must not add multi-second
      // latency to every attempt.
      timeoutMs: Math.min(config.REQUEST_TIMEOUT_MS, 2000),
    });
  }
  return restClient;
}

/** Configuration completeness (not the runtime feature switch). */
function isAuthThrottleConfigured() {
  return Boolean(config.SUPABASE_URL) && Boolean(config.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Whether the DB-backed throttle is active. Active = enabled (env) AND
 * configured. When inactive, the endpoints behave exactly as before these
 * limits existed (Supabase Auth's own limits still apply upstream).
 * @returns {boolean}
 */
export function isAuthThrottleActive() {
  if (!config.AUTH_ATTEMPT_LIMITS_ENABLED) return false;
  if (isAuthThrottleConfigured()) return true;
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    logger.warn('auth.throttle.disabled', {
      reason: 'missing_configuration',
      detail: 'AUTH_ATTEMPT_LIMITS_ENABLED=true requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; login/signup throttling is inactive.',
    });
  }
  return false;
}

// --- normalized-but-unlinkable bucket keys --------------------------------------

/**
 * Normalize an email for tracking (the SAME normalization as the controllers:
 * trim + lowercase) so the counter is stable for one account across input
 * casing, and hash it so addresses are not stored in plain text.
 * @param {string} email
 * @returns {string}
 */
function hashEmail(email) {
  return createHash('sha256').update(`offanime-login-v1|${email.trim().toLowerCase()}`, 'utf8').digest('hex');
}

/** @param {string} email */
function loginAccountBucket(email) {
  return `login:email:${hashEmail(email)}`;
}

/** @param {string} ip */
function loginIpBucket(ip) {
  return `login:ip:${ip}`;
}

/** @param {string} ip */
function signupIpBucket(ip) {
  return `signup:ip:${ip}`;
}

/** @param {string} email */
function signupDedupeKey(email) {
  return createHash('sha256').update(`offanime-signup-v1|${email.trim().toLowerCase()}`, 'utf8').digest('hex');
}

// --- atomic attempt registration -------------------------------------------------

/** @param {number} value */
function toMilliseconds(value) {
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

/**
 * Read the attempt state for ONE bucket. A missing/unreadable row is not a
 * lock (fail-open). The row carrys the 15-minute window: stale counters (past
 * their window) no longer block anything.
 * @param {string} bucket
 * @param {{ maxHits: number, windowSeconds: number, lockSeconds: number }} policy
 * @returns {Promise<{ blocked: boolean, retryAfterSeconds: number } | null>}
 *   null when the tracker store is unavailable or the row is absent.
 */
async function readAttemptState(bucket, { maxHits, windowSeconds }) {
  const rest = client();
  if (!rest) return null;
  const rows = await rest.select('auth_attempt_limits', {
    filters: { bucket },
    columns: 'hits,window_started_at,locked_until',
    limit: 1,
  });
  const row = rows[0];
  if (!row || typeof row !== 'object') return null;

  const now = Date.now();
  const lockedUntilMs = row.locked_until ? Date.parse(/** @type {string} */ (row.locked_until)) : null;
  if (Number.isFinite(lockedUntilMs) && lockedUntilMs > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntilMs - now) / 1000)),
    };
  }
  // Budget exhausted inside a still-active window: block until the window
  // ends (the counter resets there). Unparseable window -> treated as
  // expired (fail open, consistent with the rest of this layer).
  const windowStartedMs = Date.parse(/** @type {string} */ (row.window_started_at));
  const windowExpired = !Number.isFinite(windowStartedMs)
    || windowStartedMs <= now - toMilliseconds(windowSeconds);
  if (!windowExpired && Number(row.hits) >= maxHits) {
    const windowEndsMs = windowStartedMs + toMilliseconds(windowSeconds);
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((windowEndsMs - now) / 1000)) };
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

/**
 * Atomically register ONE attempt for a bucket (works across serverless
 * instances; the SQL mode uses a per-bucket advisory transaction lock).
 * Returns null when the tracker store is unavailable (fail-open callers).
 * @param {string} bucket
 * @param {{ maxHits: number, windowSeconds: number, lockSeconds: number }} policy
 * @returns {Promise<{ hits: number, locked: boolean, retryAfterSeconds: number } | null>}
 */
async function registerAttempt(bucket, { maxHits, windowSeconds, lockSeconds }) {
  const rest = client();
  if (!rest) return null;
  const data = await rest.rpc('register_auth_attempt', {
    p_bucket: bucket,
    p_max_hits: maxHits,
    p_window_seconds: windowSeconds,
    p_lock_seconds: lockSeconds,
  });
  if (!data || typeof data !== 'object' || data.locked === undefined) {
    throw new Error('unexpected register_auth_attempt response shape');
  }
  return {
    hits: Number(data.hits) || 0,
    locked: data.locked === true,
    retryAfterSeconds: Number(data.retry_after_seconds) || 0,
  };
}

/**
 * @param {string} event Log event name.
 * @param {unknown} err
 */
function warnThrottleFailure(event, err) {
  logger.warn(event, { errorName: err?.name, errorMessage: err?.message });
}

// --- login policy (PART A) -------------------------------------------------------

/**
 * The per-account login policy (5 failed attempts / 15-minute window / 15
 * minute cooldown by default).
 * @returns {{ maxHits: number, windowSeconds: number, lockSeconds: number }}
 */
export function loginAccountPolicy() {
  return {
    maxHits: config.AUTH_LOGIN_MAX_FAILURES,
    windowSeconds: config.AUTH_LOGIN_FAILURE_WINDOW_SECONDS,
    lockSeconds: config.AUTH_LOGIN_LOCK_SECONDS,
  };
}

/** The separate per-IP login-failure policy. */
export function loginIpPolicy() {
  return {
    maxHits: config.AUTH_LOGIN_IP_MAX_FAILURES,
    windowSeconds: config.AUTH_LOGIN_FAILURE_WINDOW_SECONDS,
    lockSeconds: config.AUTH_LOGIN_LOCK_SECONDS,
  };
}

/**
 * Gate a login attempt for `email` from `ip`: throws a typed 429 (with a
 * retry indication, identical for every locked address) when EITHER the
 * account OR the source IP is blocked. Never reveals WHICH layer blocked -
 * and never reveals whether the address exists. Fail-open on tracker errors.
 * @param {{ email: string, ip: string | null }} params
 * @returns {Promise<void>}
 * @throws {RateLimitError} when the account or IP is temporarily locked.
 */
export async function assertLoginAllowed({ email, ip }) {
  if (!isAuthThrottleActive()) return;
  const states = await Promise.all([
    readState(loginAccountBucket(email), loginAccountPolicy()),
    ip === null ? Promise.resolve(null) : readState(loginIpBucket(ip), loginIpPolicy()),
  ]);
  const blocked = states.find((state) => state !== null && state.blocked);
  if (blocked) {
    throw new RateLimitError(
      'Too many failed login attempts, please try again later',
      {
        provider: AUTH_THROTTLE_PROVIDER,
        retryAfterMs: blocked.retryAfterSeconds * 1000,
        details: { reason: 'login_attempts_exceeded', retryAfterSeconds: blocked.retryAfterSeconds },
      },
    );
  }
}

/**
 * Read state, failing OPEN: a tracker-store failure must never block logins.
 * @param {string} bucket
 * @param {{ maxHits: number, windowSeconds: number, lockSeconds: number }} policy
 * @returns {Promise<{ blocked: boolean, retryAfterSeconds: number } | null>}
 */
async function readState(bucket, policy) {
  try {
    return await readAttemptState(bucket, policy);
  } catch (err) {
    warnThrottleFailure('auth.throttle.readFailed', err);
    return null; // fail open
  }
}

/**
 * Record ONE failed login: registers both the account bucket and the IP
 * bucket atomically. Best effort - a failing tracker never breaks the login
 * response (the 401 is rethrown by the caller).
 * @param {{ email: string, ip: string | null }} params
 * @returns {Promise<void>}
 */
export async function recordLoginFailure({ email, ip }) {
  if (!isAuthThrottleActive()) return;
  const results = await Promise.allSettled([
    registerAttempt(loginAccountBucket(email), loginAccountPolicy()),
    ip === null ? Promise.resolve(null) : registerAttempt(loginIpBucket(ip), loginIpPolicy()),
  ]);
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) {
    warnThrottleFailure('auth.throttle.recordFailed', rejected.reason);
  }
}

/**
 * Clear the account's failure state after a SUCCESSFUL login (idempotent,
 * best effort). The IP failure layer is deliberately NOT cleared: it is a
 * cross-account abuse signal that decays with its own window.
 * @param {{ email: string }} params
 * @returns {Promise<void>}
 */
export async function clearLoginFailures({ email }) {
  if (!isAuthThrottleActive()) return;
  try {
    await client().delete('auth_attempt_limits', { bucket: loginAccountBucket(email) });
  } catch (err) {
    warnThrottleFailure('auth.throttle.clearFailed', err);
  }
}

// --- signup policy (PART B) ------------------------------------------------------

/** The per-IP signup attempt policy. */
export function signupIpPolicy() {
  return {
    maxHits: config.AUTH_SIGNUP_IP_MAX_ATTEMPTS,
    windowSeconds: config.AUTH_SIGNUP_IP_WINDOW_SECONDS,
    lockSeconds: config.AUTH_SIGNUP_IP_LOCK_SECONDS,
  };
}

/**
 * Register + gate a signup attempt from `ip` BEFORE the upstream call. The
 * attempt itself is the counted unit (new-account floods are the abuse), so
 * both successes and failures consume the per-IP budget.
 * @param {{ ip: string | null }} params
 * @returns {Promise<void>}
 * @throws {RateLimitError} when the IP exceeded the budget or is locked.
 */
export async function gateSignupAttempt({ ip }) {
  if (!isAuthThrottleActive()) return;
  if (ip === null) return; // no usable IP: rely on GoTrue's own limits + API key
  const result = await registerAttempt(signupIpBucket(ip), signupIpPolicy()).catch((err) => {
    warnThrottleFailure('auth.throttle.signupGateFailed', err);
    return null; // fail open
  });
  if (result !== null && result.locked) {
    throw new RateLimitError(
      'Too many signup attempts from this network, please try again later',
      {
        provider: AUTH_THROTTLE_PROVIDER,
        retryAfterMs: (result.retryAfterSeconds || config.AUTH_SIGNUP_IP_LOCK_SECONDS) * 1000,
        details: {
          reason: 'signup_ip_limited',
          retryAfterSeconds: result.retryAfterSeconds || config.AUTH_SIGNUP_IP_LOCK_SECONDS,
        },
      },
    );
  }
}

/**
 * Respond 409 immediately (WITHOUT an upstream signup call) when a successful
 * signup for this normalized email was recorded recently. Never blocks the
 * first-time path; a complete absence of the marker (or tracker failure) is
 * not a block.
 * @param {{ email: string }} params
 * @returns {Promise<void>}
 * @throws {EmailTakenError} duplicate suppression for a recent signup.
 */
export async function assertSignupFresh({ email }) {
  if (!isAuthThrottleActive()) return;
  const rows = await client().select('auth_signup_dedupe', {
    filters: { email_key: signupDedupeKey(email) },
    columns: 'created_at',
    limit: 1,
  }).catch((err) => {
    warnThrottleFailure('auth.throttle.signupDedupeReadFailed', err);
    return [];
  });
  const createdAt = rows[0]?.created_at ? Date.parse(/** @type {string} */ (rows[0].created_at)) : null;
  if (Number.isFinite(createdAt) && Date.now() - createdAt < toMilliseconds(config.AUTH_SIGNUP_DEDUPE_TTL_SECONDS)) {
    throw new EmailTakenError('An account with this email already exists');
  }
}

/**
 * Remember a successful signup (hashed email). Best effort: duplicate
 * suppression is an optimization, never a correctness dependency.
 * @param {{ email: string }} params
 * @returns {Promise<void>}
 */
export async function recordSignupSuccess({ email }) {
  if (!isAuthThrottleActive()) return;
  try {
    await client().insert('auth_signup_dedupe', { email_key: signupDedupeKey(email) }, {
      onConflict: 'email_key',
      prefer: 'return=representation,resolution=merge-duplicates',
    });
  } catch (err) {
    warnThrottleFailure('auth.throttle.signupDedupeWriteFailed', err);
  }
}

// Exported for tests/scripts (bucket names are not secrets but avoid surprises).
export const _internals = {
  loginAccountBucket,
  loginIpBucket,
  signupIpBucket,
  signupDedupeKey,
};
