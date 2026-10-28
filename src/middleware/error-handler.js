/**
 * Centralized error handler (must be registered LAST, after routes).
 *
 * Responsibilities:
 *   - Turn any thrown/forwarded error into a consistent JSON shape:
 *       { error: { code, message, details? } }
 *   - Map known AppError subclasses to their HTTP status codes.
 *   - Treat unknown errors as opaque 500s (never leak stack traces or internal
 *     messages to the client in production).
 *   - Log every error with request context for observability.
 *
 * IMPORTANT: This handler formats errors that have already bubbled up. It does
 * NOT decide whether stale cache should be served instead of erroring - that is
 * a service-level decision (see README, cache/stale-if-error). By the time an
 * error reaches here, the service has already chosen to fail the request.
 */

import { AppError, InternalError } from '../errors/index.js';
import { logger as rootLogger } from '../utils/logger.js';
import { redactApiKeyFromUrl } from '../utils/url-redact.js';
import { config } from '../config/env.js';

/**
 * @type {import('express').ErrorRequestHandler}
 */
// eslint-disable-next-line no-unused-vars -- Express requires the 4-arg signature.
export function errorHandler(err, req, res, next) {
  const log = req.log ?? rootLogger;

  // Normalize to an AppError so we always have statusCode/code/toResponse.
  const appError =
    err instanceof AppError
      ? err
      : new InternalError(config.IS_PRODUCTION ? 'Internal server error' : String(err?.message ?? err), {
          cause: err instanceof Error ? err : undefined,
        });

  // 5xx and non-operational errors are logged at error level; 4xx at warn.
  // The api_key query value (optional direct-access auth) is redacted.
  const isServerError = appError.statusCode >= 500;
  log[isServerError ? 'error' : 'warn']('request.error', {
    method: req.method,
    path: redactApiKeyFromUrl(req.originalUrl),
    status: appError.statusCode,
    code: appError.code,
    err: appError,
  });

  if (res.headersSent) return next(err);

  res.status(appError.statusCode).json(appError.toResponse());
}
