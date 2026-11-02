/**
 * Environment configuration loader & validator.
 *
 * Responsibilities:
 *   - Load `.env` for local development (no-op on serverless platforms that
 *     inject env vars directly).
 *   - Validate required variables and fail fast with a clear message.
 *   - Apply defaults and type coercion.
 *   - Expose a single, frozen `config` object to the rest of the app.
 *
 * Design notes:
 *   - This module has NO dependency on the logger (which itself depends on this
 *     module) to avoid a circular import.
 *   - `process.env` access is guarded so the module does not hard-crash in
 *     runtimes where `process` is unavailable; deployment adapters can inject
 *     values before import if needed.
 *   - Deployment/business logic must import from here rather than reading
 *     `process.env` directly, keeping configuration in one place.
 */

import dotenv from 'dotenv';

// Load a local .env file when present. On Vercel/Cloudflare the platform
// injects environment variables, so a missing .env file is expected there.
dotenv.config();

const rawEnv = typeof process !== 'undefined' && process.env ? process.env : {};

/**
 * @typedef {Object} EnvVarSpec
 * @property {boolean} [required]  Fail startup if missing/empty.
 * @property {string}  [default]   Value used when unset.
 * @property {boolean} [secret]    Redact value from any diagnostic output.
 * @property {(raw: string) => unknown} [transform] Coerce the raw string value.
 * @property {string}  [description]
 */

const toNumber = (value) => {
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`expected a number but received "${value}"`);
  }
  return n;
};

const toBoolean = (value) => {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`expected a boolean but received "${value}"`);
};

/**
 * Declarative schema for every environment variable the backend understands.
 * Add new variables here (and to .env.example) as later phases need them.
 *
 * NOTE: Provider secrets are intentionally `required: false` for Phase 1 so the
 * foundation boots without any provider being wired up yet. Flip `required` to
 * `true` in the phase that actually depends on the variable.
 *
 * @type {Record<string, EnvVarSpec>}
 */
const schema = {
  NODE_ENV: { default: 'development', description: 'development | production | test' },
  PORT: { default: '8080', transform: toNumber, description: 'Port for the Node server shell.' },
  HOST: { default: '0.0.0.0', description: 'Bind host for the Node server shell.' },

  CORS_ORIGIN: { default: '*', description: 'Comma-separated allowed origins or "*".' },

  // SECRET - server-side only; required credential for every protected /api/*
  // route (see src/middleware/api-key-auth.js). Never exposed to the frontend,
  // never placed in URLs/query params, and never logged. A missing value FAILS
  // CLOSED in EVERY environment (dev included): protected requests are
  // rejected (500) rather than silently served unauthenticated. Local
  // development must set a value in .env, exactly like production does.
  BACKEND_API_SECRET: { required: false, secret: true, default: '' },

  ANILIST_API_URL: { default: 'https://graphql.anilist.co' },
  JIKAN_API_URL: { default: 'https://api.jikan.moe/v4' },
  TMDB_API_URL: { default: 'https://api.themoviedb.org/3' },
  MEGAPLAY_API_URL: { default: 'https://megaplay.buzz' },
  // AniZip episode metadata (public API; keyed directly by AniList ID).
  ANIZIP_API_URL: { default: 'https://api.ani.zip' },
  // Playback proxy (optional). When configured, /api/stream/resolve/:id
  // returns frontend-safe playback URLs through this proxy instead of direct
  // MegaPlay URLs. The host is NEVER hardcoded in provider/business logic.
  MEGAPLAY_PROXY_URL: { required: false, default: '' },

  TMDB_API_KEY: { required: false, secret: true, default: '' },

  SUPABASE_URL: { required: false, default: '' },
  SUPABASE_ANON_KEY: { required: false, secret: true, default: '' },
  // SECRET - server-side only; preferred over the anon key for L2 cache access
  // because it bypasses RLS. Never exposed to the frontend or logs.
  SUPABASE_SERVICE_ROLE_KEY: { required: false, secret: true, default: '' },

  // --- User authentication (Supabase Auth / GoTrue - server-side only) --------
  // The auth endpoints (src/routes/auth.routes.js) talk to Supabase Auth with
  // the PUBLIC anon key ONLY - never the service-role key. A missing
  // SUPABASE_URL or SUPABASE_ANON_KEY fails closed (500) like the API-key
  // middleware: auth endpoints reject requests instead of silently degrading.
  // AUTH_COOKIES_ENABLED additionally sets HttpOnly session cookies on the
  // login/signup/refresh responses (token responses are the universal primary
  // mechanism; cookies are the recommended upgrade for same-site deployments).
  AUTH_COOKIES_ENABLED: { default: 'true', transform: toBoolean },
  // Max-Age (seconds) for the refresh-token cookie. Access-token cookies are
  // always scoped to the upstream-issued session lifetime (expires_in).
  AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS: { default: '2592000', transform: toNumber },

  // --- Login attempt limiting + signup anti-abuse (DB-backed, cross-instance) -
  // Failed login attempts are tracked per NORMALIZED ACCOUNT (hashed email) in
  // Supabase (auth_attempt_limits table + atomic RPC), so the policy works
  // across all serverless instances. When the tracker store is unavailable the
  // limiter FAILS OPEN (login availability first; GoTrue keeps its own limits).
  AUTH_ATTEMPT_LIMITS_ENABLED: { default: 'true', transform: toBoolean },
  // Per-account policy: block after AUTH_LOGIN_MAX_FAILURES failed logins
  // within AUTH_LOGIN_FAILURE_WINDOW_SECONDS; the lock lasts
  // AUTH_LOGIN_LOCK_SECONDS. Successful logins clear the counter.
  AUTH_LOGIN_MAX_FAILURES: { default: '5', transform: toNumber },
  AUTH_LOGIN_FAILURE_WINDOW_SECONDS: { default: '900', transform: toNumber },
  AUTH_LOGIN_LOCK_SECONDS: { default: '900', transform: toNumber },
  // SEPARATE IP abuse layer: failed logins (any accounts) from one IP may not
  // exceed this within the same failure window before that IP is locked.
  AUTH_LOGIN_IP_MAX_FAILURES: { default: '20', transform: toNumber },
  // Signup throttling per source IP (independent of GoTrue's own limits):
  // all signup attempts from one IP within the window; exceeding it blocks
  // that IP for AUTH_SIGNUP_IP_LOCK_SECONDS.
  AUTH_SIGNUP_IP_MAX_ATTEMPTS: { default: '10', transform: toNumber },
  AUTH_SIGNUP_IP_WINDOW_SECONDS: { default: '3600', transform: toNumber },
  AUTH_SIGNUP_IP_LOCK_SECONDS: { default: '900', transform: toNumber },
  // Duplicate-suppression: successful signups are remembered (hashed email) so
  // repeated signup POSTs for the same address skip the upstream GoTrue call.
  AUTH_SIGNUP_DEDUPE_TTL_SECONDS: { default: '600', transform: toNumber },

  // OPTIONAL: forward the end-user IP to Supabase Auth so ITS rate limits
  // (which would otherwise apply to this backend's shared egress IP, blocking
  // unrelated users) apply per END USER instead. Requires the NEW secret API
  // key (sb_secret_...) in AUTH_GOTRUE_SECRET_KEY and the project feature
  // enabled in Dashboard -> Authentication -> Rate Limits -> IP address
  // forwarding. With legacy anon/service_role keys this CANNOT work.
  AUTH_GOTRUE_IP_FORWARDING: { default: 'false', transform: toBoolean },
  AUTH_GOTRUE_SECRET_KEY: { required: false, secret: true, default: '' },

  CACHE_DEFAULT_TTL_SECONDS: { default: '300', transform: toNumber },
  REQUEST_TIMEOUT_MS: { default: '10000', transform: toNumber },
  // Bounded deadline for OPTIONAL details enrichment (Jikan/TMDB). A slow
  // optional provider must never hold the details response hostage: past this
  // deadline the enrichment is skipped exactly like a provider failure
  // (AniList core data is unaffected). 0 disables the deadline.
  ENRICHMENT_TIMEOUT_MS: { default: '5000', transform: toNumber },

  // --- L2 (Supabase) cache circuit breaker ------------------------------------
  // After CACHE_L2_FAILURE_THRESHOLD consecutive L2 failures, the manager skips
  // Supabase entirely (clean L1-only fallback) for CACHE_L2_BREAKER_OPEN_MS,
  // doubling per subsequent trip up to CACHE_L2_BREAKER_MAX_OPEN_MS. Prevents
  // a broken/misconfigured Supabase from being hammered on every request.
  CACHE_L2_FAILURE_THRESHOLD: { default: '5', transform: toNumber },
  CACHE_L2_BREAKER_OPEN_MS: { default: '30000', transform: toNumber },
  CACHE_L2_BREAKER_MAX_OPEN_MS: { default: '300000', transform: toNumber },

  LOG_LEVEL: { default: 'info', description: 'debug | info | warn | error' },
};

/**
 * Build the validated config object from the schema.
 * Collects ALL problems before throwing so the operator sees everything at once.
 * @returns {Readonly<Record<string, unknown>>}
 */
function loadConfig() {
  /** @type {Record<string, unknown>} */
  const config = {};
  /** @type {string[]} */
  const errors = [];

  for (const [key, spec] of Object.entries(schema)) {
    const rawValue = rawEnv[key];
    const hasValue = rawValue !== undefined && rawValue !== '';

    if (!hasValue) {
      if (spec.required) {
        errors.push(`  - ${key} is required but was not set${spec.description ? ` (${spec.description})` : ''}`);
        continue;
      }
      config[key] = spec.default !== undefined ? coerce(key, spec, spec.default, errors) : undefined;
      continue;
    }

    config[key] = coerce(key, spec, rawValue, errors);
  }

  if (errors.length > 0) {
    throw new Error(
      'Invalid environment configuration:\n' +
      errors.join('\n') +
      '\n\nSee .env.example for the full list of supported variables.',
    );
  }

  // Convenience booleans derived from NODE_ENV.
  config.IS_PRODUCTION = config.NODE_ENV === 'production';
  config.IS_TEST = config.NODE_ENV === 'test';

  return Object.freeze(config);
}

/**
 * @param {string} key
 * @param {EnvVarSpec} spec
 * @param {string} value
 * @param {string[]} errors
 */
function coerce(key, spec, value, errors) {
  if (!spec.transform) return value;
  try {
    return spec.transform(value);
  } catch (err) {
    errors.push(`  - ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Validated, frozen application configuration.
 * @type {Readonly<Record<string, any>>}
 */
export const config = loadConfig();

/**
 * Return a copy of the config with secret values redacted, suitable for logs.
 * @returns {Record<string, unknown>}
 */
export function getRedactedConfig() {
  const redacted = { ...config };
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.secret && redacted[key]) redacted[key] = '***redacted***';
  }
  return redacted;
}
