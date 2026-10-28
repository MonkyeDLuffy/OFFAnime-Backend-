/**
 * Jikan (MyAnimeList) provider.
 *
 * Role: SECONDARY metadata/enrichment source. Provides richer MAL/Jikan
 * metadata that later merges into the canonical anime object WITHOUT replacing
 * AniList's primary identity. Talks to the official Jikan v4 REST API via the
 * shared Phase 1 HTTP abstraction - no second HTTP client, no SDK.
 *
 * CRITICAL: Jikan is keyed by MAL IDs. `mal_id` is a MAL ID and must NEVER be
 * treated as an AniList ID. Full AniList <-> MAL resolution is the identity
 * layer's job (a later phase); this provider only exposes Jikan lookups.
 *
 * Design guarantees (same as the AniList provider):
 *   - Stateless, request-scoped; caching/coalescing happen outside providers.
 *   - Every request carries a timeout (shared HTTP client).
 *   - No automatic retries on general lookups (Jikan rate limits are strict;
 *     resilience is the cache layer's stale-if-error job). ONE exception:
 *     the episodes endpoint gets a SINGLE bounded retry for transient
 *     upstream failures (504/502/503/429), because Jikan's episode endpoints
 *     have documented intermittent 5xx problems and episode data is never
 *     cached until a valid 200 response exists.
 *   - Failures map onto the typed error taxonomy and are NEVER swallowed,
 *     NEVER cached, NEVER converted into [] for single-anime operations.
 *   - Returns RAW Jikan payloads; normalization lives in src/normalizers.
 */

import { BaseProvider } from '../base-provider.js';
import { config } from '../../config/env.js';
import { PROVIDERS } from '../../config/constants.js';
import { NotFoundError, ProviderError, RateLimitError, TimeoutError, ValidationError } from '../../errors/index.js';
import { parseRequiredId } from '../../identity/id-types.js';
import { animeEpisodesPath, animeFullPath, animePath, animeSearchPath } from './jikan.queries.js';

/** Jikan caps search results at 25 per page. */
const MAX_SEARCH_LIMIT = 25;

/** Transient upstream statuses eligible for the single bounded episode retry. */
const TRANSIENT_EPISODE_STATUSES = new Set([502, 503, 504]);

/** One retry maximum: the initial episode request plus one transient retry. */
const MAX_EPISODE_ATTEMPTS = 2;

/** Small fixed backoff between episode attempts (Jikan 504s are momentary). */
const EPISODE_RETRY_DELAY_MS = 250;

/** Cap on honoring a 429 retry-after wait (Jikan rate-limit windows are short). */
const MAX_RATE_LIMIT_WAIT_MS = 2000;

/** A transient episode failure is retried ONCE; everything else fails fast. */
function isTransientEpisodeFailure(err) {
  if (err instanceof RateLimitError) return true; // 429
  if (err instanceof TimeoutError) return true; // request-level timeout (504 class)
  if (err instanceof ProviderError) {
    // Covers both HTTP-level non-2xx (upstreamStatus from the shared client)
    // and Jikan's in-band error body (mapped to ProviderError + upstreamStatus).
    const upstream = err.details?.upstreamStatus;
    return typeof upstream === 'number' && TRANSIENT_EPISODE_STATUSES.has(upstream);
  }
  return false;
}

/** Respect the 429 retry-after window (capped); otherwise a small backoff. */
function episodeRetryDelayMs(err) {
  if (err instanceof RateLimitError && Number.isFinite(err.retryAfterMs)) {
    return Math.min(Math.max(err.retryAfterMs, 0), MAX_RATE_LIMIT_WAIT_MS);
  }
  return EPISODE_RETRY_DELAY_MS;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class JikanProvider extends BaseProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] Overrides the default request timeout.
   */
  constructor({ timeoutMs } = {}) {
    super({ name: PROVIDERS.JIKAN, baseUrl: config.JIKAN_API_URL });
    this._timeoutMs = timeoutMs;
  }

  /**
   * Fetch the RAW anime object from Jikan by MyAnimeList ID.
   * Prefers the richer `/full` endpoint; `full: false` uses the basic one.
   *
   * @param {number|string} malId MyAnimeList ID (NOT an AniList ID).
   * @param {{ full?: boolean }} [options]
   * @returns {Promise<Record<string, unknown>>} Raw Jikan anime object.
   * @throws {ValidationError} invalid MAL ID. @throws {NotFoundError} unknown
   *   anime. @throws {RateLimitError|TimeoutError|ProviderError} accordingly.
   */
  async getAnimeByMalId(malId, { full = true } = {}) {
    const id = parseRequiredId(malId, 'malId');
    const path = full ? animeFullPath(id) : animePath(id);

    let response;
    try {
      response = await this.request(path, this._timeoutOptions());
    } catch (err) {
      // Jikan signals "unknown anime" with HTTP 404 (the shared client throws
      // before parsing the body, so map on the upstream status here).
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError(`Anime not found on Jikan for MAL ID ${id}`, { cause: err });
      }
      throw err;
    }

    // Jikan wraps payloads: { data: {...}, pagination?: {...} }.
    const payload = response.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProviderError('Jikan returned a malformed response', { provider: this.name });
    }
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw new ProviderError('Jikan response is missing anime data', { provider: this.name });
    }
    return /** @type {Record<string, unknown>} */ (payload.data);
  }

  /**
   * Fetch the RAW episode list for an anime (episode METADATA only - this
   * project never calls streaming providers or fabricates stream URLs).
   *
   * Bounded retry: a transient upstream failure (504/502/503/429 or a request
   * timeout) is retried exactly ONCE (429 honors the retry-after window,
   * capped). Validation errors, 404s, malformed payloads and other 4xx fail
   * fast with no retry - no aggressive retry loop. The cache layer's
   * stale-if-error behavior remains the final resilience net.
   *
   * Jikan quirk handled here: when MyAnimeList's upstream is unavailable,
   * Jikan responds HTTP 200 with an IN-BAND error body
   * ({ status: 5xx, type, message }) and no `data` array. That body is
   * detected BEFORE any `data` validation and mapped onto the typed error
   * taxonomy (404 -> NotFoundError, else ProviderError) so a transient
   * upstream outage never surfaces as "missing data".
   *
   * @param {number|string} malId MyAnimeList ID (NOT an AniList ID).
   * @param {{ page?: number }} [options]
   * @returns {Promise<Record<string, unknown>>} Raw Jikan payload
   *   ({ pagination, data: [...] }).
   */
  async getAnimeEpisodes(malId, { page = 1 } = {}) {
    const id = parseRequiredId(malId, 'malId');
    if (!Number.isInteger(page) || page < 1) {
      throw new ValidationError('Jikan episodes page must be a positive integer', { received: page });
    }

    let lastError;
    for (let attempt = 1; attempt <= MAX_EPISODE_ATTEMPTS; attempt += 1) {
      try {
        return await this._getAnimeEpisodesOnce(id, page);
      } catch (err) {
        lastError = err;
        if (attempt >= MAX_EPISODE_ATTEMPTS || !isTransientEpisodeFailure(err)) break;
        await sleep(episodeRetryDelayMs(err));
      }
    }
    throw lastError;
  }

  /**
   * Single (non-retried) episode fetch attempt.
   * @param {number} id
   * @param {number} page
   */
  async _getAnimeEpisodesOnce(id, page) {
    // TEMPORARY diagnostic logging (safe: no secrets in URLs/headers).
    const debugUrl = this.buildUrl(animeEpisodesPath(id, page));
    const debugTimeoutMs = this._timeoutMs ?? config.REQUEST_TIMEOUT_MS;
    const debugStartedAt = Date.now();
    this.log.info('[JIKAN_EPISODES_DEBUG] request', {
      malId: id,
      url: debugUrl,
      method: 'GET',
      timeoutMs: debugTimeoutMs,
    });

    let response;
    try {
      response = await this.request(animeEpisodesPath(id, page), this._timeoutOptions());
      this.log.info('[JIKAN_EPISODES_DEBUG] response', {
        status: response.status,
        ok: response.ok,
        contentType: String(response.headers?.get('content-type') ?? ''),
        elapsedMs: Date.now() - debugStartedAt,
      });
    } catch (err) {
      this.log.info('[JIKAN_EPISODES_DEBUG] error', {
        errorName: err?.name ?? typeof err,
        errorCode: err?.code ?? null,
        message: err?.message ?? String(err),
        upstreamStatus: err?.details?.upstreamStatus ?? null,
        elapsedMs: Date.now() - debugStartedAt,
      });
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError(`No episode list on Jikan for MAL ID ${id}`, { cause: err });
      }
      throw err;
    }

    const payload = response.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProviderError('Jikan returned a malformed response', { provider: this.name });
    }

    // Jikan in-band error body (HTTP 200 + { status: >=400, type, message }).
    // Checked BEFORE the data-array validation; only the upstream status is
    // reported - no unsafe body content.
    const inBandStatus = Number(payload.status);
    if (Number.isInteger(inBandStatus) && inBandStatus >= 400 && payload.type !== undefined) {
      if (inBandStatus === 404) {
        throw new NotFoundError(`No episode list on Jikan for MAL ID ${id}`);
      }
      throw new ProviderError('Jikan upstream failed while fetching episodes', {
        provider: this.name,
        statusCode: 502,
        details: { upstreamStatus: inBandStatus },
      });
    }

    if (!Array.isArray(payload.data)) {
      throw new ProviderError('Jikan episodes payload is missing data', { provider: this.name });
    }
    return /** @type {Record<string, unknown>} */ (payload);
  }

  async searchAnime(query, options = {}) {
    if (typeof query !== 'string') {
      throw new ValidationError('Jikan search requires a string query');
    }
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    this._validatePagination(page, limit);

    let response;
    try {
      response = await this.request(animeSearchPath({ q: query, page, limit }), this._timeoutOptions());
    } catch (err) {
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError(`No Jikan results for "${query.trim()}"`, { cause: err });
      }
      throw err;
    }

    const payload = response.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProviderError('Jikan returned a malformed response', { provider: this.name });
    }
    return /** @type {Record<string, unknown>} */ (payload);
  }

  // --- internals ------------------------------------------------------------

  /**
   * @param {number} page
   * @param {number} limit
   */
  _validatePagination(page, limit) {
    if (!Number.isInteger(page) || page < 1) {
      throw new ValidationError('Jikan search page must be a positive integer', { received: page });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new ValidationError(`Jikan search limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`, {
        received: limit,
      });
    }
  }

  /** Timeout options when a per-provider override is configured. */
  _timeoutOptions() {
    return this._timeoutMs !== undefined ? { timeoutMs: this._timeoutMs } : {};
  }
}
