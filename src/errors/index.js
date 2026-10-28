/**
 * Typed error classes for the whole backend.
 *
 * Import errors from this barrel (`../errors/index.js`) so call sites get a
 * consistent taxonomy. The centralized error handler relies on `statusCode`
 * and `code`, both of which are set here.
 *
 * Key rule this taxonomy enforces (see README): a PROVIDER/TIMEOUT/RATE_LIMIT
 * failure is NOT the same as "no data". Services catch these and decide whether
 * to serve stale cache instead of turning them into empty `[]` responses.
 */

import { AppError, ERROR_CODES } from './app-error.js';

export { AppError, ERROR_CODES };

/** 400 - the caller sent something invalid (bad id, missing query, etc.). */
export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details) {
    super(message, { statusCode: 400, code: ERROR_CODES.VALIDATION, details });
  }
}

/** 401 - the caller is not authenticated (missing/invalid API key). */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details) {
    super(message, { statusCode: 401, code: ERROR_CODES.UNAUTHORIZED, details });
  }
}

/** 403 - authenticated but not allowed (e.g. CSRF/origin rejection). */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details) {
    super(message, { statusCode: 403, code: ERROR_CODES.FORBIDDEN, details });
  }
}

/** 401 - Supabase Auth rejected the presented credentials (login). */
export class InvalidCredentialsError extends AppError {
  constructor(message = 'Invalid email or password', details) {
    super(message, { statusCode: 401, code: ERROR_CODES.AUTH_INVALID_CREDENTIALS, details });
  }
}

/** 403 - the account exists but the email address is not confirmed yet. */
export class EmailNotConfirmedError extends AppError {
  constructor(message = 'Email address is not confirmed', details) {
    super(message, { statusCode: 403, code: ERROR_CODES.AUTH_EMAIL_NOT_CONFIRMED, details });
  }
}

/** 409 - signup with an email that is already registered. */
export class EmailTakenError extends AppError {
  constructor(message = 'An account with this email already exists', details) {
    super(message, { statusCode: 409, code: ERROR_CODES.AUTH_EMAIL_TAKEN, details });
  }
}

/** 401 - a user session token (or one-time email token) is invalid/expired. */
export class SessionExpiredError extends AppError {
  constructor(message = 'Session is invalid or expired', details) {
    super(message, { statusCode: 401, code: ERROR_CODES.AUTH_SESSION_EXPIRED, details });
  }
}

/** 502 - the Supabase Auth (GoTrue) upstream failed unexpectedly. */
export class AuthProviderError extends AppError {
  constructor(message = 'Authentication provider error', { details, cause } = {}) {
    super(message, { statusCode: 502, code: ERROR_CODES.AUTH_PROVIDER, details, cause });
  }
}

/** 404 - the requested resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details) {
    super(message, { statusCode: 404, code: ERROR_CODES.NOT_FOUND, details });
  }
}

/**
 * 501 - the endpoint/feature exists in the architecture but is intentionally
 * not implemented yet. Used by contract routes reserved for later phases so
 * they are honest instead of returning fake data.
 */
export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented yet', details) {
    super(message, { statusCode: 501, code: ERROR_CODES.NOT_IMPLEMENTED, details });
  }
}

/** 502 - an upstream provider (AniList/Jikan/TMDB/MegaPlay) failed. */
export class ProviderError extends AppError {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.provider] Provider identifier (see PROVIDERS).
   * @param {number} [options.statusCode=502]
   * @param {unknown} [options.details]
   * @param {unknown} [options.cause]
   */
  constructor(message = 'Upstream provider error', { provider, statusCode = 502, details, cause } = {}) {
    super(message, {
      statusCode,
      code: ERROR_CODES.PROVIDER,
      details: { provider, ...(details && typeof details === 'object' ? details : { details }) },
      cause,
    });
    this.provider = provider;
  }
}

/** 504 - an upstream request exceeded the configured timeout. */
export class TimeoutError extends AppError {
  constructor(message = 'Upstream request timed out', { provider, details, cause } = {}) {
    super(message, {
      statusCode: 504,
      code: ERROR_CODES.TIMEOUT,
      details: { provider, ...(details && typeof details === 'object' ? details : {}) },
      cause,
    });
    this.provider = provider;
  }
}

/** 429 - an upstream provider (or this API) is rate limiting requests. */
export class RateLimitError extends AppError {
  constructor(message = 'Rate limited', { provider, retryAfterMs, details, cause } = {}) {
    super(message, {
      statusCode: 429,
      code: ERROR_CODES.RATE_LIMIT,
      details: { provider, retryAfterMs, ...(details && typeof details === 'object' ? details : {}) },
      cause,
    });
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 500 - the cache layer (L1/L2) failed. Never fatal on its own: callers
 *  should treat a cache error as a miss and fall back to the provider. */
export class CacheError extends AppError {
  constructor(message = 'Cache error', { layer, details, cause } = {}) {
    super(message, {
      statusCode: 500,
      code: ERROR_CODES.CACHE,
      details: { layer, ...(details && typeof details === 'object' ? details : {}) },
      cause,
    });
    this.layer = layer;
  }
}

/** 500 - catch-all for unexpected internal failures. */
export class InternalError extends AppError {
  constructor(message = 'Internal server error', { details, cause } = {}) {
    super(message, { statusCode: 500, code: ERROR_CODES.INTERNAL, isOperational: false, details, cause });
  }
}
