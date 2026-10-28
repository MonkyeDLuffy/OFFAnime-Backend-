/**
 * Portable HTTP client for providers.
 *
 * This is shared provider *infrastructure*, not a provider integration. It:
 *   - Uses the global `fetch` + `AbortController` (portable across Node 18+,
 *     Vercel, and Cloudflare Workers - no `node:http`, no `axios`).
 *   - Enforces a timeout (default from config, override per call).
 *   - Maps transport/HTTP failures onto the typed error taxonomy
 *     (TimeoutError / RateLimitError / ProviderError) so callers can reason
 *     about failure kinds instead of parsing raw responses.
 *   - Logs latency + status for observability.
 *
 * It intentionally knows nothing about AniList/Jikan/TMDB/MegaPlay specifics;
 * concrete providers build on top of it via BaseProvider.
 */

import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ProviderError, RateLimitError, TimeoutError } from '../errors/index.js';

/**
 * @typedef {Object} HttpRequestOptions
 * @property {string} [method='GET']
 * @property {Record<string, string>} [headers]
 * @property {BodyInit | null} [body]
 * @property {number} [timeoutMs] Overrides config.REQUEST_TIMEOUT_MS.
 * @property {string} [provider='http'] Provider id for logs/errors.
 * @property {AbortSignal} [signal] Optional external cancellation signal.
 */

/**
 * @typedef {Object} HttpResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {Headers} headers
 * @property {unknown} data Parsed JSON when the response is JSON, else raw text.
 */

/**
 * Perform an HTTP request and return a normalized response.
 *
 * Throws (never returns) on transport failure, timeout, 429, or a non-2xx
 * status - callers decide how to react (e.g. fall back to stale cache).
 *
 * @param {string} url
 * @param {HttpRequestOptions} [options]
 * @returns {Promise<HttpResponse>}
 */
export async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = undefined,
    timeoutMs = config.REQUEST_TIMEOUT_MS,
    provider = 'http',
    signal,
  } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Respect an externally-provided abort signal in addition to our timeout.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;

    logger.debug('provider.http', { provider, method, url, status: response.status, latencyMs });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new RateLimitError(`${provider} rate limited`, {
        provider,
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      });
    }

    const data = await parseBody(response);

    if (!response.ok) {
      throw new ProviderError(`${provider} responded with HTTP ${response.status}`, {
        provider,
        statusCode: 502,
        details: { upstreamStatus: response.status },
      });
    }

    return { status: response.status, ok: response.ok, headers: response.headers, data };
  } catch (err) {
    // Our own typed errors pass through unchanged.
    if (err instanceof ProviderError || err instanceof RateLimitError || err instanceof TimeoutError) {
      throw err;
    }
    // AbortController fires an AbortError on timeout/cancellation.
    if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
      throw new TimeoutError(`${provider} request timed out after ${timeoutMs}ms`, {
        provider,
        cause: err instanceof Error ? err : undefined,
      });
    }
    throw new ProviderError(`${provider} request failed`, {
      provider,
      cause: err instanceof Error ? err : undefined,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a response body as JSON when the content type says so, otherwise text.
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function parseBody(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return await response.text();
}
