/**
 * Base application error.
 *
 * Every error the backend raises on purpose extends `AppError`. This lets the
 * centralized error handler distinguish *operational* errors (expected: bad
 * input, provider down, not found) from *programmer* errors (unexpected bugs),
 * and map them to the right HTTP status without leaking internals.
 *
 * Errors carry a stable machine-readable `code` (see ERROR_CODES) so the
 * frontend and logs can branch on error type without string-matching messages.
 */

/**
 * Stable, machine-readable error codes. These are part of the API contract for
 * error responses; add new ones rather than repurposing existing values.
 */
export const ERROR_CODES = Object.freeze({
  VALIDATION: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED_ERROR',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  PROVIDER: 'PROVIDER_ERROR',
  TIMEOUT: 'TIMEOUT_ERROR',
  RATE_LIMIT: 'RATE_LIMIT_ERROR',
  CACHE: 'CACHE_ERROR',
  INTERNAL: 'INTERNAL_ERROR',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_EMAIL_NOT_CONFIRMED: 'AUTH_EMAIL_NOT_CONFIRMED',
  AUTH_EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',
  AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  AUTH_PROVIDER: 'AUTH_PROVIDER_ERROR',
});

export class AppError extends Error {
  /**
   * @param {string} message Human-readable description.
   * @param {object} [options]
   * @param {number} [options.statusCode=500] HTTP status to respond with.
   * @param {string} [options.code=ERROR_CODES.INTERNAL] Stable error code.
   * @param {boolean} [options.isOperational=true] Expected vs. programmer error.
   * @param {unknown} [options.details] Extra structured context (safe to log).
   * @param {unknown} [options.cause] Underlying error, preserved for logging.
   */
  constructor(message, {
    statusCode = 500,
    code = ERROR_CODES.INTERNAL,
    isOperational = true,
    details = undefined,
    cause = undefined,
  } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Serialize to a safe, frontend-facing shape. Never includes stack traces or
   * secrets. `details` is included only when explicitly provided.
   * @returns {{ error: { code: string, message: string, details?: unknown } }}
   */
  toResponse() {
    /** @type {{ code: string, message: string, details?: unknown }} */
    const error = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}
