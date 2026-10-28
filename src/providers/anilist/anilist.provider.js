/**
 * AniList provider.
 *
 * Role: PRIMARY identity/source layer. Talks to the official AniList GraphQL
 * API via the shared Phase 1 HTTP abstraction (BaseProvider -> http-client) -
 * no second HTTP client, no SDK.
 *
 * Responsibilities:
 *   - Execute GraphQL queries with only the fields the app needs.
 *   - Map failures onto the typed error taxonomy (ValidationError for bad
 *     input, NotFoundError for missing media, TimeoutError, RateLimitError,
 *     ProviderError for API/transport failures).
 *   - Return RAW AniList payloads. Normalization into canonical anime objects
 *     happens in src/normalizers, NOT here.
 *
 * Design guarantees:
 *   - Stateless and request-scoped: no instance state besides configuration.
 *     Caching and coalescing are handled by the cache/service layers, never
 *     inside provider methods.
 *   - Every request carries a timeout (shared http-client; per-call override
 *     supported via the constructor option).
 *   - No retries: AniList rate limits (429) and outages would only get worse;
 *     broader resilience belongs to the cache layer (stale-if-error).
 *   - Never fabricates data and never returns [] to hide a failure - failures
 *     are thrown as typed errors so the cache layer can react.
 */

import { BaseProvider } from '../base-provider.js';
import { config } from '../../config/env.js';
import { PROVIDERS } from '../../config/constants.js';
import { NotFoundError, ProviderError, ValidationError } from '../../errors/index.js';
import { parseRequiredId } from '../../identity/id-types.js';
import {
  GET_AIRING_SCHEDULE_QUERY,
  GET_ANIME_AIRING_SCHEDULE_QUERY,
  GET_ANIME_BY_ID_QUERY,
  GET_ANIME_BY_MAL_ID_QUERY,
  GET_RECOMMENDATIONS_QUERY,
  GET_RELATIONS_QUERY,
  GET_SEASONAL_ANIME_QUERY,
  SEARCH_ANIME_QUERY,
} from './anilist.queries.js';

export class AnilistProvider extends BaseProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] Overrides the default request timeout.
   */
  constructor({ timeoutMs } = {}) {
    super({ name: PROVIDERS.ANILIST, baseUrl: config.ANILIST_API_URL });
    this._timeoutMs = timeoutMs;
  }

  /**
   * Execute a GraphQL query and return the `data` object.
   *
   * @param {string} query GraphQL document.
   * @param {Record<string, unknown>} [variables]
   * @returns {Promise<Record<string, unknown>>}
   * @throws {NotFoundError} AniList signaled missing media (HTTP 404 or a 404
   *   GraphQL error). @throws {ProviderError} malformed/unsuccessful responses.
   */
  async executeQuery(query, variables = {}) {
    let response;
    try {
      response = await this.request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        ...(this._timeoutMs !== undefined ? { timeoutMs: this._timeoutMs } : {}),
      });
    } catch (err) {
      // AniList signals "media not found" with HTTP 404 (the shared client
      // throws before parsing the body, so map on the upstream status here).
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError('Anime not found on AniList', { cause: err });
      }
      throw err;
    }

    const payload = response.data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ProviderError('AniList returned a malformed response', { provider: this.name });
    }

    // AniList can answer HTTP 200 with a GraphQL `errors` array.
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first = payload.errors.find((e) => e && typeof e === 'object') ?? {};
      if (first.status === 404) {
        throw new NotFoundError('Anime not found on AniList');
      }
      throw new ProviderError(
        typeof first.message === 'string' && first.message ? first.message : 'AniList GraphQL error',
        { provider: this.name, details: { graphqlErrors: payload.errors } },
      );
    }

    if (!payload.data || typeof payload.data !== 'object') {
      throw new ProviderError('AniList response is missing data', { provider: this.name });
    }

    return payload.data;
  }

  /**
   * Fetch RAW anime data by AniList ID.
   * @param {number|string} anilistId
   * @returns {Promise<Record<string, unknown>>} Raw AniList `Media` object.
   */
  async getAnimeById(anilistId) {
    const id = parseRequiredId(anilistId, 'anilistId');
    const data = await this.executeQuery(GET_ANIME_BY_ID_QUERY, { id });
    return this._requireMedia(data.Media, `AniList ID ${id}`);
  }

  /**
   * Fetch RAW anime data by MyAnimeList ID (via AniList's `idMal`).
   * @param {number|string} malId
   * @returns {Promise<Record<string, unknown>>} Raw AniList `Media` object.
   */
  async getAnimeByMalId(malId) {
    const id = parseRequiredId(malId, 'malId');
    const data = await this.executeQuery(GET_ANIME_BY_MAL_ID_QUERY, { idMal: id });
    return this._requireMedia(data.Media, `MAL ID ${id}`);
  }

  /**
   * Search anime. Supports page/perPage/season/year/format/status/genre/sort
   * without over-engineering filters the app does not need yet.
   *
   * @param {string} query Keyword search (optional when filters are given).
   * @param {object} [options]
   * @param {number} [options.page=1]
   * @param {number} [options.perPage=20]
   * @param {string} [options.season]  MediaSeason (e.g. "SPRING").
   * @param {number} [options.year]    Season year.
   * @param {string} [options.format]  MediaFormat (e.g. "TV").
   * @param {string} [options.status]  MediaStatus (e.g. "FINISHED").
   * @param {string} [options.genre]   Genre name.
   * @param {string|string[]} [options.sort] MediaSort value(s).
   * @returns {Promise<Record<string, unknown> | null>} Raw AniList `Page`.
   */
  async searchAnime(query, options = {}) {
    const variables = this._buildSearchVariables(query, options);
    const data = await this.executeQuery(SEARCH_ANIME_QUERY, variables);
    return data.Page ?? null;
  }

  /**
   * Fetch basic relations (related anime) for an AniList ID.
   * @param {number|string} anilistId
   * @returns {Promise<Record<string, unknown> | null>} Raw relations node list.
   */
  async getRelations(anilistId) {
    const id = parseRequiredId(anilistId, 'anilistId');
    const data = await this.executeQuery(GET_RELATIONS_QUERY, { id });
    return this._requireMedia(data.Media, `AniList ID ${id}`)?.relations ?? null;
  }

  /**
   * Fetch recommended anime for an AniList ID.
   * @param {number|string} anilistId
   * @param {{ page?: number, perPage?: number }} [options]
   * @returns {Promise<Record<string, unknown> | null>} Raw recommendations.
   */
  async getRecommendations(anilistId, { page, perPage } = {}) {
    const id = parseRequiredId(anilistId, 'anilistId');
    const variables = { id };
    if (page !== undefined) variables.page = page;
    if (perPage !== undefined) variables.perPage = perPage;
    const data = await this.executeQuery(GET_RECOMMENDATIONS_QUERY, variables);
    return this._requireMedia(data.Media, `AniList ID ${id}`)?.recommendations ?? null;
  }

  /**
   * Fetch seasonal anime listing.
   * @param {{ page?: number, perPage?: number, season?: string, seasonYear?: number, sort?: string|string[] }} [options]
   * @returns {Promise<Record<string, unknown> | null>} Raw AniList `Page`.
   */
  async getSeasonalAnime({ page, perPage, season, seasonYear, sort } = {}) {
    const variables = this._buildPageVariables({ page, perPage, season, seasonYear, sort });
    const data = await this.executeQuery(GET_SEASONAL_ANIME_QUERY, variables);
    return data.Page ?? null;
  }

  /**
   * Fetch the airing schedule for an epoch-second window.
   * @param {{ page?: number, perPage?: number, from?: number, to?: number }} [options]
   * @returns {Promise<Record<string, unknown> | null>} Raw AniList `Page`.
   */
  async getAiringSchedule({ page, perPage, from, to } = {}) {
    const variables = {};
    if (page !== undefined) variables.page = page;
    if (perPage !== undefined) variables.perPage = perPage;
    if (from !== undefined) variables.from = from;
    if (to !== undefined) variables.to = to;
    const data = await this.executeQuery(GET_AIRING_SCHEDULE_QUERY, variables);
    return data.Page ?? null;
  }

  /**
   * Fetch the PER-ANIME airing schedule (real episode numbers + air
   * timestamps). AniList only provides schedule entries where they exist
   * (often empty for older anime) - an empty result is returned as null, never
   * fabricated into episode data.
   * @param {number|string} anilistId
   * @param {{ page?: number, perPage?: number }} [options]
   * @returns {Promise<Record<string, unknown> | null>} Raw `airingSchedule`
   *   connection ({ pageInfo, nodes: [{ episode, airingAt }] }).
   */
  async getAnimeAiringSchedule(anilistId, { page, perPage } = {}) {
    const id = parseRequiredId(anilistId, 'anilistId');
    const variables = { id };
    if (page !== undefined) variables.page = page;
    if (perPage !== undefined) variables.perPage = perPage;
    const data = await this.executeQuery(GET_ANIME_AIRING_SCHEDULE_QUERY, variables);
    return this._requireMedia(data.Media, `AniList ID ${id}`)?.airingSchedule ?? null;
  }

  // --- internals ------------------------------------------------------------

  /**
   * Ensure a Media node exists; null means AniList has no such anime.
   * @param {unknown} media
   * @param {string} label
   * @returns {Record<string, unknown>}
   */
  _requireMedia(media, label) {
    if (!media || typeof media !== 'object') {
      throw new NotFoundError(`Anime not found on AniList for ${label}`);
    }
    return /** @type {Record<string, unknown>} */ (media);
  }

  /**
   * Build GraphQL variables for search, sending only defined filters.
   * @param {string} query
   * @param {Record<string, unknown>} options
   * @returns {Record<string, unknown>}
   */
  _buildSearchVariables(query, options) {
    const hasQuery = typeof query === 'string' && query.trim() !== '';
    const variables = this._buildPageVariables(options, hasQuery);
    if (hasQuery) {
      variables.search = query.trim();
    }
    return variables;
  }

  /**
   * Shared Page-query variables (pagination, season, sort) with defaults.
   * @param {Record<string, unknown>} options
   * @param {boolean} [isSearch=false] Keyword search defaults to SEARCH_MATCH
   *   sort; filter-only browsing defaults to POPULARITY_DESC.
   * @returns {Record<string, unknown>}
   */
  _buildPageVariables(options, isSearch = false) {
    const variables = {
      page: options.page ?? 1,
      perPage: options.perPage ?? 20,
      sort: Array.isArray(options.sort)
        ? options.sort
        : options.sort
          ? [options.sort]
          : isSearch
            ? ['SEARCH_MATCH']
            : ['POPULARITY_DESC'],
    };
    if (options.season) variables.season = options.season;
    if (options.seasonYear) variables.seasonYear = options.seasonYear;
    if (options.year) variables.seasonYear = options.year;
    if (options.format) variables.format = options.format;
    if (options.status) variables.status = options.status;
    if (options.genre) variables.genre = options.genre;
    return variables;
  }
}
