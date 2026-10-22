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
import { config } from '../config/env.js';
import { parseRequiredId } from '../identity/id-types.js';
import { TimeoutError, ValidationError } from '../errors/index.js';
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
 * Bound an OPTIONAL enrichment promise by a deadline. Past the deadline the
 * caller sees a TimeoutError (and skips the enrichment exactly like a provider
 * failure), while the underlying operation keeps running in the background:
 * when it eventually completes, the cache layer still records the component
 * result, so a later composite refresh includes it. A non-positive/invalid
 * deadline disables bounding.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} deadlineMs
 * @param {string} label Provider/step name for logs (never secrets).
 * @returns {Promise<T>}
 */
function withDeadline(promise, deadlineMs, label) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return promise;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} enrichment exceeded its ${deadlineMs}ms deadline`, { provider: label })),
      deadlineMs,
    );
  });
  // The deadline winner must not leave a late rejection unhandled.
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

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
 * FULL details pipeline (Phase 7 + performance pass): AniList primary +
 * Jikan/TMDB enrichment run CONCURRENTLY (bounded by ENRICHMENT_TIMEOUT_MS),
 * cached as a composite so /api/details and /api/smart/details share the
 * expensive result with zero duplicate provider calls.
 *
 * Enrichment resilience: Jikan/TMDB failures AND deadline overruns are caught
 * and skipped - valid AniList data is never replaced by Jikan/TMDB guesses or
 * failures, and optional providers can only delay the response by the
 * enrichment deadline, never by their own (longer) request timeouts.
 *
 * @param {number|string} anilistId
 * @returns {Promise<import('../normalizers/anime.types.js').CanonicalAnime>}
 */
export async function getFullDetails(anilistId) {
  const id = parseRequiredId(anilistId, 'anilistId');

  // Lightweight stage timing (cache misses only; no secrets, no payloads).
  const requestStartedAt = Date.now();
  let loaderRan = false;

  const result = await cacheManager.getOrLoad(
    `api:details:anilist:${id}`,
    async () => {
      loaderRan = true;
      const startedAt = Date.now();
      /** @type {Record<string, number>} */
      const timings = {};
      /** @type {Record<string, string>} */
      const stages = {};

      // 1. AniList primary data (component cache, DAY TTL).
      let canonical = await getAnimeDetails(id);
      timings.anilist = Date.now() - startedAt;

      // 2 + 3. OPTIONAL enrichment: Jikan (secondary metadata, only when a
      //        trusted AniList idMal exists) and TMDB (visuals) run
      //        CONCURRENTLY - both depend only on already-resolved AniList
      //        canonical data, never on each other's network results. Each
      //        branch is bounded by ENRICHMENT_TIMEOUT_MS and fails
      //        independently: a timeout/failure skips that enrichment only
      //        (exactly like a provider failure) and never destroys or delays
      //        the AniList-authoritative response beyond the deadline.
      const enrichmentStartedAt = Date.now();
      const enrichDeadlineMs = config.ENRICHMENT_TIMEOUT_MS;

      const jikanPromise = canonical.malId !== null
        ? withDeadline(jikanService.getAnimeByMalId(canonical.malId), enrichDeadlineMs, 'jikan')
        : null;
      const tmdbPromise = withDeadline(
        tmdbService.enrichWithTmdb(canonical),
        enrichDeadlineMs,
        'tmdb',
      );

      // Titles the first TMDB resolution attempts - used to avoid re-searching
      // them if a Jikan-title fallback retry is needed (see below).
      const firstAttemptedTitles = tmdbService.plannedAttemptedTitles(canonical);

      const [jikanSettled, tmdbSettled] = await Promise.allSettled([jikanPromise, tmdbPromise]);

      // Jikan merge (AniList identity always wins; see anime.merge.js).
      if (canonical.malId !== null) {
        if (jikanSettled.status === 'fulfilled') {
          canonical = mergeJikanIntoCanonical(canonical, jikanSettled.value);
          stages.jikan = 'ok';
        } else {
          stages.jikan = 'skipped';
          logger.warn('details.jikanEnrichmentSkipped', { anilistId: id, err: jikanSettled.reason });
        }
        timings.jikan = Date.now() - enrichmentStartedAt;
      } else {
        stages.jikan = 'absent';
      }

      // TMDB merge (banner precedence enforced by the merge).
      /** @type {import('../normalizers/tmdb.types.js').TmdbVisualResult | null} */
      let tmdbVisual = null;
      if (tmdbSettled.status === 'fulfilled') {
        tmdbVisual = tmdbSettled.value;
        stages.tmdb = tmdbVisual.resolved ? 'resolved' : 'unresolved';
      } else {
        stages.tmdb = 'skipped';
        logger.warn('details.tmdbEnrichmentSkipped', { anilistId: id, err: tmdbSettled.reason });
      }
      timings.tmdb = Date.now() - enrichmentStartedAt;

      // Accuracy-preserving fallback: when the first TMDB resolution ran
      // WITHOUT Jikan titles (parallel execution) and ended unresolved, retry
      // once with the NEW titles Jikan contributed (bounded, never re-searches
      // attempted titles). This preserves the banner coverage the previous
      // sequential pipeline had for anime with sparse AniList titles.
      if (jikanSettled.status === 'fulfilled' && canonical.malId !== null
          && tmdbVisual !== null && tmdbVisual.resolved !== true) {
        try {
          const retryVisual = await withDeadline(
            tmdbService.enrichWithExpandedTitles(canonical, firstAttemptedTitles),
            enrichDeadlineMs,
            'tmdb-fallback',
          );
          if (retryVisual) {
            tmdbVisual = retryVisual;
            stages.tmdb = 'resolved';
            stages.tmdbFallback = 'used';
          }
        } catch (err) {
          logger.warn('details.tmdbFallbackSkipped', { anilistId: id, err });
        }
      }

      canonical = mergeTmdbIntoCanonical(canonical, tmdbVisual);

      logger.info('details.pipeline', {
        anilistId: id,
        timingsMs: timings,
        stages,
        totalMs: Date.now() - startedAt,
      });

      return canonical;
    },
    { ttlSeconds: CACHE_TTL.MEDIUM, isValid: isCanonicalAnime },
  );

  if (loaderRan) {
    logger.info('details.request', {
      anilistId: id,
      cache: 'miss',
      latencyMs: Date.now() - requestStartedAt,
    });
  } else {
    logger.debug('details.request', {
      anilistId: id,
      cache: 'hit',
      latencyMs: Date.now() - requestStartedAt,
    });
  }

  return result;
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
  // v2 key: cards now include titleEnglish/titleRomaji/titleNative (and
  // `title` prefers English); bumping the namespace keeps stale cached pages
  // from hiding the new fields (also feeds home sections / category / top-search).
  const key = `anilist:search:v2:${query ?? ''}:${JSON.stringify(normalized)}`;
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
    // v2 key: recommendation cards gained the title variant fields (DAY TTL,
    // so stale entries must not outlive the schema change).
    `anilist:recommendations:v2:${id}`,
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
