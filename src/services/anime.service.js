/**
 * Anime service - business logic for anime data.
 *
 *   Controller -> Anime Service -> Cache Manager -> Provider(s) -> Normalizer
 *
 * Phase 7 pipeline for full details:
 *
 *   AniList primary data (cached)
 *     -> Jikan enrichment when a trusted MAL ID exists (skipped on failure)
 *     -> TMDB visual enrichment (skipped on failure/unresolved)
 *     -> canonical response (cached composite)
 *
 * Rules respected here:
 *   - No provider GraphQL/REST calls in services (providers own them).
 *   - Normalization happens at the service boundary, so caches store
 *     CANONICAL/normalized data, never raw provider payloads.
 *   - cacheManager.getOrLoad never caches failures; on provider failure it
 *     serves stale cache and only then propagates the error (stale-if-error).
 *   - `id === anilistId` always; MAL IDs come ONLY from trusted AniList
 *     `idMal` data (or the identity layer) - never guessed.
 *   - Jikan/TMDB failures NEVER destroy valid AniList data: enrichment is
 *     skipped (with a warn log), keeping AniList authoritative data intact.
 *   - Deterministic, namespace-safe cache keys (fixed option property order).
 */

import { anilistProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { identityResolver } from '../identity/identity-resolver.js';
import { CACHE_TTL, ANILIST_SEASONS, ANILIST_FORMATS, ANILIST_STATUSES, ANILIST_SORTS, SEARCH_LIMITS } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { ValidationError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import {
  normalizeAnilistAnime,
  normalizeAnilistPage,
  normalizeAnilistRecommendations,
  normalizeAnilistRelation,
} from '../normalizers/anime.normalizer.js';
import { mergeJikanIntoCanonical } from '../normalizers/anime.merge.js';
import { mergeTmdbIntoCanonical } from '../normalizers/anime.merge.js';
import * as jikanService from './jikan.service.js';
import * as tmdbService from './tmdb.service.js';

/** A cached result is valid only if it is a real canonical anime (id present). */
const isCanonicalAnime = (value) =>
  Boolean(value && typeof value === 'object' && value.id !== null && value.id !== undefined);

/** A cached search result is valid only if it has a results array. */
const isValidSearchPage = (value) =>
  Boolean(value && typeof value === 'object' && Array.isArray(value.results));

/**
 * AniList-only canonical anime (lighter than the full pipeline; used by
 * episodes/tmdb endpoints that only need identity + titles).
 * @param {number|string} anilistId
 * @returns {Promise<import('../normalizers/anime.types.js').CanonicalAnime>}
 * @throws {NotFoundError} unknown anime. @throws {ProviderError} provider
 *   failure with no stale cache available.
 */
export async function getAnimeDetails(anilistId) {
  const id = parseRequiredId(anilistId, 'anilistId');
  return cacheManager.getOrLoad(
    `anilist:anime:${id}`,
    async () => normalizeAnilistAnime(await anilistProvider.getAnimeById(id)),
    { ttlSeconds: CACHE_TTL.DAY, isValid: isCanonicalAnime },
  );
}

/**
 * FULL details pipeline (Phase 7): AniList primary + Jikan enrichment + TMDB
 * visuals, cached as a composite so /api/details and /api/smart/details share
 * the expensive result with zero duplicate provider calls.
 *
 * Enrichment resilience: Jikan/TMDB failures are caught and skipped - valid
 * AniList data is never replaced by Jikan/TMDB guesses or failures.
 *
 * @param {number|string} anilistId
 * @returns {Promise<import('../normalizers/anime.types.js').CanonicalAnime>}
 */
export async function getFullDetails(anilistId) {
  const id = parseRequiredId(anilistId, 'anilistId');
  return cacheManager.getOrLoad(
    `api:details:anilist:${id}`,
    async () => {
      // 1. AniList primary data (component cache, DAY TTL).
      let canonical = await getAnimeDetails(id);

      // 2. Jikan enrichment when a trusted MAL ID exists. The MAL ID comes
      //    from AniList's trusted `idMal` - never guessed. A Jikan failure
      //    never destroys valid AniList data.
      if (canonical.malId !== null) {
        try {
          const jikan = await jikanService.getAnimeByMalId(canonical.malId);
          canonical = mergeJikanIntoCanonical(canonical, jikan);
        } catch (err) {
          logger.warn('details.jikanEnrichmentSkipped', { anilistId: id, err });
        }
      }

      // 3. TMDB visual enrichment (banner precedence enforced by the merge).
      //    A TMDB failure/unresolved result leaves canonical data intact.
      try {
        const visual = await tmdbService.enrichWithTmdb(canonical);
        canonical = mergeTmdbIntoCanonical(canonical, visual);
      } catch (err) {
        logger.warn('details.tmdbEnrichmentSkipped', { anilistId: id, err });
      }

      return canonical;
    },
    { ttlSeconds: CACHE_TTL.MEDIUM, isValid: isCanonicalAnime },
  );
}

/**
 * Validate + normalize search options into a FIXED-ORDER object so cache keys
 * are deterministic (never collide from property ordering or query order).
 * @param {object} [options]
 * @returns {object}
 * @throws {ValidationError} for invalid pagination/enums/lengths.
 */
function validateSearchOptions(options = {}) {
  const normalized = {};

  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > SEARCH_LIMITS.MAX_PAGE) {
    throw new ValidationError(`Invalid page: must be an integer between 1 and ${SEARCH_LIMITS.MAX_PAGE}`, { received: page });
  }
  normalized.page = page;

  const perPage = options.perPage ?? 20;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > SEARCH_LIMITS.MAX_PER_PAGE) {
    throw new ValidationError(`Invalid perPage: must be an integer between 1 and ${SEARCH_LIMITS.MAX_PER_PAGE}`, { received: perPage });
  }
  normalized.perPage = perPage;

  if (options.season !== undefined) {
    if (!ANILIST_SEASONS.includes(options.season)) {
      throw new ValidationError(`Invalid season: expected one of ${ANILIST_SEASONS.join(', ')}`, { received: options.season });
    }
    normalized.season = options.season;
  }

  if (options.year !== undefined) {
    if (!Number.isInteger(options.year) || options.year < 1960 || options.year > 2200) {
      throw new ValidationError('Invalid year: expected an integer between 1960 and 2200', { received: options.year });
    }
    normalized.year = options.year;
  }

  if (options.format !== undefined) {
    if (!ANILIST_FORMATS.includes(options.format)) {
      throw new ValidationError(`Invalid format: expected one of ${ANILIST_FORMATS.join(', ')}`, { received: options.format });
    }
    normalized.format = options.format;
  }

  if (options.status !== undefined) {
    if (!ANILIST_STATUSES.includes(options.status)) {
      throw new ValidationError(`Invalid status: expected one of ${ANILIST_STATUSES.join(', ')}`, { received: options.status });
    }
    normalized.status = options.status;
  }

  if (options.genre !== undefined) {
    if (typeof options.genre !== 'string' || options.genre.trim() === '') {
      throw new ValidationError('Invalid genre: expected a non-empty string');
    }
    normalized.genre = options.genre.trim();
  }

  if (options.sort !== undefined) {
    const sorts = Array.isArray(options.sort) ? options.sort : [options.sort];
    for (const sort of sorts) {
      if (!ANILIST_SORTS.includes(sort)) {
        throw new ValidationError(`Invalid sort: expected one of ${ANILIST_SORTS.join(', ')}`, { received: sort });
      }
    }
    normalized.sort = sorts;
  }

  return normalized;
}

/**
 * Anime search results (normalized cards + page info). AniList is the primary
 * search provider; Jikan/TMDB are not called per result (search stays fast).
 * @param {string} query
 * @param {object} [options] page/perPage/season/year/format/status/genre/sort.
 * @returns {Promise<object>}
 */
export async function searchAnime(query, options = {}) {
  const normalized = validateSearchOptions(options);
  const key = `anilist:search:${query ?? ''}:${JSON.stringify(normalized)}`;
  return cacheManager.getOrLoad(
    key,
    async () => normalizeAnilistPage(await anilistProvider.searchAnime(query, normalized)),
    { ttlSeconds: CACHE_TTL.MEDIUM, isValid: isValidSearchPage },
  );
}

/**
 * Normalized AniList recommendations for an anime (cached). Recommendation IDs
 * stay AniList namespaced - never converted into MAL IDs.
 * @param {number|string} anilistId
 * @returns {Promise<Array>}
 */
export async function getAnimeRecommendations(anilistId) {
  const id = parseRequiredId(anilistId, 'anilistId');
  return cacheManager.getOrLoad(
    `anilist:recommendations:${id}`,
    async () => normalizeAnilistRecommendations(await anilistProvider.getRecommendations(id, { perPage: 20 })),
    { ttlSeconds: CACHE_TTL.DAY, isValid: Array.isArray },
  );
}

/**
 * Normalized AniList relations (seasons/sequels/prequels) for an anime
 * (cached). Relations come ONLY from AniList's actual relation data - never
 * invented. All IDs stay correctly namespaced.
 * @param {number|string} anilistId
 * @returns {Promise<Array>}
 */
export async function getAnimeSeasons(anilistId) {
  const id = parseRequiredId(anilistId, 'anilistId');
  return cacheManager.getOrLoad(
    `anilist:relations:${id}`,
    async () => {
      const raw = await anilistProvider.getRelations(id);
      const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
      return nodes.map((node) => normalizeAnilistRelation(node)).filter(Boolean);
    },
    { ttlSeconds: CACHE_TTL.DAY, isValid: Array.isArray },
  );
}

// NOTE: Episode METADATA lives in the isolated episode resolver/service
// (src/services/episode.service.js) - getAnimeEpisodes moved there.
