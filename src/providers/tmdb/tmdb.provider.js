/**
 * TMDB provider.
 *
 * Role: OPTIONAL VISUAL ENRICHMENT source (backdrops, banners, artwork).
 * TMDB must NEVER become the source of truth for AniList ID, MAL ID, anime
 * identity, canonical titles, or streaming/MegaPlay IDs:
 *
 *   > TMDB enriches visuals. It does not establish anime identity.
 *
 * TMDB IDs are a completely different namespace - a tmdbId must never be
 * stored as anilistId or malId. Identity resolution is the identity layer's
 * job; matching a known anime to a TMDB entry happens in the enrichment
 * service/normalizer layer with conservative validation.
 *
 * Auth: TMDB requires an API key / read access token, taken from environment
 * configuration (config.TMDB_API_KEY). Never hardcoded, never exposed in API
 * responses. A missing credential fails clearly (ProviderError) rather than
 * silently degrading - the enrichment service treats "not configured" as a
 * valid unresolved enrichment, so AniList/Jikan data keeps working.
 *
 * Design guarantees (same as other providers):
 *   - Stateless, request-scoped; caching/coalescing happen outside providers.
 *   - Uses the shared Phase 1 HTTP abstraction - no second HTTP client.
 *   - Every request carries a timeout.
 *   - Failures map onto the typed error taxonomy and are never swallowed.
 *   - Returns RAW TMDB payloads; normalization lives in src/normalizers.
 */

import { BaseProvider } from '../base-provider.js';
import { config } from '../../config/env.js';
import { PROVIDERS } from '../../config/constants.js';
import { NotFoundError, ProviderError, ValidationError } from '../../errors/index.js';
import { parseRequiredId } from '../../identity/id-types.js';
import {
  movieDetailsPath,
  movieSearchPath,
  tvDetailsPath,
  tvSearchPath,
  tvSeasonPath,
} from './tmdb.queries.js';

export class TmdbProvider extends BaseProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] Overrides config.TMDB_API_KEY (tests).
   * @param {number} [options.timeoutMs] Overrides the default request timeout.
   */
  constructor({ apiKey, timeoutMs } = {}) {
    super({ name: PROVIDERS.TMDB, baseUrl: config.TMDB_API_URL });
    this._apiKey = apiKey !== undefined ? apiKey : config.TMDB_API_KEY;
    this._timeoutMs = timeoutMs;
  }

  /**
   * Whether TMDB has the credentials needed to operate. When false, callers
   * should treat TMDB enrichment as unavailable (AniList/Jikan keep working).
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this._apiKey);
  }

  /**
   * Raw TMDB TV search results.
   * @param {string} query
   * @param {{ page?: number }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async searchTv(query, options = {}) {
    return this._search(tvSearchPath, query, options);
  }

  /**
   * Raw TMDB TV details.
   * @param {number|string} tmdbId
   * @returns {Promise<Record<string, unknown>>}
   */
  async getTvDetails(tmdbId) {
    return this._details(tvDetailsPath, tmdbId, 'tv');
  }

  /**
   * Raw TMDB movie search results.
   * @param {string} query
   * @param {{ page?: number }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async searchMovie(query, options = {}) {
    return this._search(movieSearchPath, query, options);
  }

  /**
   * Raw TMDB movie details.
   * @param {number|string} tmdbId
   * @returns {Promise<Record<string, unknown>>}
   */
  async getMovieDetails(tmdbId) {
    return this._details(movieDetailsPath, tmdbId, 'movie');
  }

  /**
   * Raw TMDB TV season details (season episode list). Used by the episode
   * flow's TMDB fallback - the season number is chosen by the CALLER from
   * trusted canonical metadata (never guessed here), and the payload is
   * normalized into episode metadata in src/normalizers.
   * @param {number|string} tmdbId
   * @param {number|string} seasonNumber
   * @returns {Promise<Record<string, unknown>>}
   */
  async getTvSeason(tmdbId, seasonNumber) {
    const season = parseRequiredId(seasonNumber, 'seasonNumber');
    return this._details((id) => tvSeasonPath(id, season), tmdbId, 'tv season');
  }

  // --- internals ------------------------------------------------------------

  /**
   * Shared search execution.
   * @param {({ query: string, page?: number }) => string} pathBuilder
   * @param {string} query
   * @param {{ page?: number }} options
   * @returns {Promise<Record<string, unknown>>}
   */
  async _search(pathBuilder, query, options) {
    if (typeof query !== 'string' || !query.trim()) {
      throw new ValidationError('TMDB search requires a non-empty string query');
    }
    const page = options.page ?? 1;
    if (!Number.isInteger(page) || page < 1) {
      throw new ValidationError('TMDB search page must be a positive integer', { received: page });
    }

    let response;
    try {
      response = await this._authenticatedRequest(pathBuilder({ query: query.trim(), page }));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError(`No TMDB results for "${query.trim()}"`, { cause: err });
      }
      throw err;
    }

    const payload = response.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProviderError('TMDB returned a malformed response', { provider: this.name });
    }
    if (!Array.isArray(payload.results)) {
      throw new ProviderError('TMDB search response is missing results', { provider: this.name });
    }
    return /** @type {Record<string, unknown>} */ (payload);
  }

  /**
   * Shared details execution.
   * @param {(tmdbId: number) => string} pathBuilder
   * @param {number|string} tmdbId
   * @param {'tv'|'movie'} kind
   * @returns {Promise<Record<string, unknown>>}
   */
  async _details(pathBuilder, tmdbId, kind) {
    const id = parseRequiredId(tmdbId, 'tmdbId');

    let response;
    try {
      response = await this._authenticatedRequest(pathBuilder(id));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError(`TMDB ${kind} ${id} not found`, { cause: err });
      }
      throw err;
    }

    const payload = response.data;
    const idNumber = Number(payload?.id);
    if (!payload || typeof payload !== 'object' || !Number.isInteger(idNumber) || idNumber <= 0) {
      throw new ProviderError(`TMDB response is missing ${kind} details`, { provider: this.name });
    }
    return /** @type {Record<string, unknown>} */ (payload);
  }

  /**
   * Perform an authenticated request. Credential handling:
   *   - v4 read access tokens (JWTs) -> Authorization: Bearer header.
   *   - v3 API keys -> api_key query parameter.
   * The credential is never logged and never returned in API responses.
   * @param {string} path
   * @returns {Promise<import('../http-client.js').HttpResponse>}
   */
  _authenticatedRequest(path) {
    this._assertConfigured();

    let url = path;
    const headers = {};
    if (/^ey/.test(this._apiKey)) {
      // JWT-shaped read access token.
      headers.Authorization = `Bearer ${this._apiKey}`;
    } else {
      url = `${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(this._apiKey)}`;
    }

    return this.request(url, {
      headers,
      ...(this._timeoutMs !== undefined ? { timeoutMs: this._timeoutMs } : {}),
    });
  }

  /** @throws {ProviderError} when TMDB credentials are missing. */
  _assertConfigured() {
    if (!this.isConfigured()) {
      throw new ProviderError(
        'TMDB API key is not configured (set TMDB_API_KEY). TMDB enrichment is unavailable; AniList/Jikan data is unaffected.',
        { provider: this.name },
      );
    }
  }
}
