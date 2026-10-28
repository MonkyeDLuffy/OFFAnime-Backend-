/**
 * 404 handler for unmatched routes.
 *
 * Runs after all routers. Forwards a NotFoundError to the centralized error
 * handler so every unmatched path gets a consistent JSON error shape (rather
 * than Express's default HTML response).
 */

import { NotFoundError } from '../errors/index.js';
import { redactApiKeyFromUrl } from '../utils/url-redact.js';

/** @type {import('express').RequestHandler} */
export function notFoundHandler(req, _res, next) {
  // The api_key query value (optional direct-access auth) is redacted - this
  // message reaches BOTH the logs and the 404 response body, so the raw key
  // must never appear in it.
  next(new NotFoundError(`Route not found: ${req.method} ${redactApiKeyFromUrl(req.originalUrl)}`));
}
