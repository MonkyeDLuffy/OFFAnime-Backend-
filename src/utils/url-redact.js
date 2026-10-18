/**
 * URL redaction for logs and error messages.
 *
 * The optional `?api_key=` query-parameter authentication (see
 * src/middleware/api-key-auth.js) means URLs can carry the API secret. The
 * backend must never log, echo, or persist that value:
 *
 *   - request-logger.js  (http.request log lines)
 *   - error-handler.js   (request.error log lines)
 *   - not-found.js       (404 error message -> logs AND response body)
 *
 * This helper replaces every `api_key=` value with `[REDACTED]`. All other
 * query parameters (q, page, perPage, ...) are preserved for debuggability.
 * It is a display-layer sanitizer only: the middleware additionally DELETES
 * `req.query.api_key` before controllers/services/cache run, so the raw value
 * never flows into application state, cache keys, or error details.
 *
 * Note: this cannot control OTHER infrastructure - reverse proxies, CDNs, and
 * load balancers may still record raw query strings in their own access logs.
 * See the README "API key protection" section for that documented risk.
 */

const API_KEY_QUERY_PATTERN = /([?&])api_key=[^&#]*/gi;

/**
 * Return a copy of the URL string with every `api_key` query value redacted.
 * Non-string/empty input is returned unchanged.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactApiKeyFromUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.replace(API_KEY_QUERY_PATTERN, '$1api_key=%5BREDACTED%5D');
}
