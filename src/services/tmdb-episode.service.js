/**
 * TMDB episode extraction service - the DEDICATED TMDB episode-data flow for
 * GET /api/episodes/:id (TMDB is now the primary detailed-episode provider).
 *
 *   Episode service (AniList ID + identity + canonical metadata)
 *     -> getTmdbUnifiedEpisodes(canonical)
 *        -> TMDB series ID via the EXISTING TMDB matching/enrichment system
 *           (tmdb.service.enrichWithTmdb - no new fuzzy matching)
 *        -> cacheManager.getOrLoad (coalesced unified-list cache)
 *           -> TMDB provider.getTvDetails (read available seasons)
 *           -> ignore Season 0 / specials by default
 *           -> for every normal season: provider.getTvSeason
 *              (GET /3/tv/{tmdbSeriesId}/season/{seasonNumber}), fetched with
 *              BOUNDED concurrency (never unlimited requests), each season
 *              cached INDEPENDENTLY
 *           -> tmdb-episode.mapper (extract + deterministic flattening)
 *        -> unified episode list (cached)
 *
 * Rules enforced here:
 *   - The public route ID stays the AniList ID. The TMDB series ID comes ONLY
 *     from the existing enrichment matching (tmdb.service) - never guessed,
 *     never a new matching system. TMDB IDs stay under TMDB-specific fields;
 *     a TMDB ID never becomes the AniList ID.
 *   - Cache stores NORMALIZED (extracted/mapped) data, never raw API payloads.
 *     Each TMDB season is cached independently (tmdb:season:{series}:{n}) so
 *     one failed season never destroys other cached seasons, and the final
 *     unified list is cached per AniList ID
 *     (episodes:tmdb:unified:anilist:{id}) so repeated /api/episodes/:id
 *     requests do not refetch every TMDB season.
 *   - Only FULLY successful unified lists are cached. Partial results (a
 *     failed season reported internally via diagnostics) are returned but
 *     never cached, so the failed season is retried on the next request.
 *     Provider failures are NEVER cached as valid episode data.
 *   - Per-season failures: the season's stale cached version is used when
 *     available (the cache manager's stale-if-error), otherwise the failure is
 *     reported internally (diagnostics.failedSeasons) and that season's
 *     episodes are never fabricated.
 *   - When TMDB is not configured, or no confident TMDB match exists, this
 *     returns null - the episode service falls back to Jikan (TMDB stays
 *     optional enrichment; AniList/Jikan keep working).
 *   - Request coalescing through the existing cache manager + RequestCoalescer:
 *     N concurrent requests for the same anime share ONE season-fetch
 *     operation. No second cache system, no second HTTP client.
 */

import { tmdbProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL, PROVIDERS } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { ProviderError, ValidationError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import { enrichWithTmdb } from './tmdb.service.js';
import {
  extractTmdbSeasonEpisodes,
  mapTmdbSeasonsToGlobalEpisodes,
} from '../normalizers/tmdb-episode.mapper.js';

/** Bounded season-fetch concurrency - never unlimited requests. */
const MAX_SEASON_CONCURRENCY = 4;

/** A cached season is valid only if it is a real extracted season. */
const isValidSeason = (value) =>
  Boolean(value && typeof value === 'object' && Array.isArray(value.episodes));

/** A unified list is cacheable only when fully successful (no failed season). */
const isCacheableUnified = (value) =>
  Boolean(
    value &&
      typeof value === 'object' &&
      value.resolved === true &&
      Array.isArray(value.episodes) &&
      (!Array.isArray(value.failedSeasons) || value.failedSeasons.length === 0),
  );

/**
 * A resolved-but-partial unified result is still returned to the caller (its
 * diagnostics carry the failed seasons), it is just never cached.
 */
const isUsableUnified = (value) =>
  Boolean(
    value &&
      typeof value === 'object' &&
      value.resolved === true &&
      Array.isArray(value.episodes),
  );

/**
 * Bounded-concurrency map: at most `limit` workers run at once. Results keep
 * the input order. A worker failure is the worker's own concern (it returns a
 * failure descriptor here, never a thrown error).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithBoundedConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Read the available NORMAL season numbers from raw TMDB TV details. Season 0
 * / specials are ignored by default; invalid season numbers are rejected.
 * @param {unknown} tvDetails
 * @returns {number[]} Sorted, deduplicated season numbers (>= 1).
 */
function collectNormalSeasonNumbers(tvDetails) {
  const seasons = Array.isArray(tvDetails?.seasons) ? tvDetails.seasons : [];
  const numbers = new Set();
  for (const season of seasons) {
    const n = Number(season?.season_number);
    if (!Number.isInteger(n) || n < 1) continue; // Season 0/specials ignored
    numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * One TMDB season's extracted episodes (cached INDEPENDENTLY per
 * tmdbSeriesId + seasonNumber). A failed season with stale cache is served
 * stale by the cache manager; without cache it throws (the caller reports the
 * failure internally - that season's episodes are never fabricated).
 * @param {number} tmdbSeriesId
 * @param {number} seasonNumber
 * @param {{ provider: import('../providers/tmdb/tmdb.provider.js').TmdbProvider }} deps
 * @returns {Promise<import('../normalizers/tmdb-episode.types.js').ExtractedTmdbSeason>}
 */
async function getSeasonEpisodes(tmdbSeriesId, seasonNumber, { provider }) {
  const key = `tmdb:season:${tmdbSeriesId}:${seasonNumber}`;
  return cacheManager.getOrLoad(
    key,
    async () =>
      extractTmdbSeasonEpisodes(await provider.getTvSeason(tmdbSeriesId, seasonNumber), {
        tmdbSeriesId,
        seasonNumber,
      }),
    { ttlSeconds: CACHE_TTL.DAY, isValid: isValidSeason },
  );
}

/**
 * Fetch every normal season (bounded concurrency), then flatten into the
 * unified episode list.
 * @param {number} tmdbSeriesId
 * @param {{ provider: import('../providers/tmdb/tmdb.provider.js').TmdbProvider }} deps
 * @returns {Promise<object>} { resolved, tmdbSeriesId, episodes, totalEpisodes,
 *   failedSeasons, seasonNumbers }
 * @throws {ProviderError} when TMDB details fail or NO season succeeds (no
 *   cached data at all - never fake empty episode data).
 */
async function buildUnifiedEpisodes(tmdbSeriesId, { provider }) {
  // 1. TMDB TV series details (typed errors propagate; stale-if-error on the
  //    unified-list cache already served stale data when available).
  const tvDetails = await provider.getTvDetails(tmdbSeriesId);

  // 2. Read the available seasons; ignore Season 0/specials by default.
  const seasonNumbers = collectNormalSeasonNumbers(tvDetails);
  if (seasonNumbers.length === 0) {
    throw new ProviderError(`TMDB series ${tmdbSeriesId} has no normal seasons`, {
      provider: PROVIDERS.TMDB,
      details: { tmdbSeriesId },
    });
  }

  // 3. Fetch every normal season with BOUNDED concurrency. Each season is
  //    cached independently; one failed season does not destroy the others.
  const seasonResults = await mapWithBoundedConcurrency(
    seasonNumbers,
    MAX_SEASON_CONCURRENCY,
    async (seasonNumber) => {
      try {
        const season = await getSeasonEpisodes(tmdbSeriesId, seasonNumber, { provider });
        return { ok: true, season };
      } catch (err) {
        // Report the season failure internally - never fabricate its episodes.
        logger.warn('tmdbEpisodes.seasonFailed', { tmdbSeriesId, seasonNumber, err });
        return {
          ok: false,
          seasonNumber,
          reason: err instanceof Error ? err.message : 'season_fetch_failed',
        };
      }
    },
  );

  const failedSeasons = seasonResults
    .filter((result) => !result.ok)
    .map((result) => ({ seasonNumber: result.seasonNumber, reason: result.reason }));
  const seasons = seasonResults.filter((result) => result.ok).map((result) => result.season);

  // 4. The entire TMDB request failed (no cached season data at all): the
  //    typed error propagates - never a fake empty episode array.
  if (seasons.length === 0) {
    throw new ProviderError(`TMDB episode data for series ${tmdbSeriesId} is unavailable`, {
      provider: PROVIDERS.TMDB,
      details: { tmdbSeriesId, failedSeasons },
    });
  }

  // 5. Deterministic flattening into ONE continuous episode list.
  const { episodes, totalEpisodes } = mapTmdbSeasonsToGlobalEpisodes(seasons, { tmdbSeriesId });

  return {
    resolved: true,
    tmdbSeriesId,
    episodes,
    totalEpisodes,
    failedSeasons,
    seasonNumbers,
  };
}

/**
 * Unified TMDB episode list for an already-known anime (the episode flow's
 * TMDB primary source).
 *
 * The TMDB series ID comes ONLY from the existing TMDB matching/enrichment
 * system (enrichWithTmdb). The final unified episode list is cached per AniList
 * ID (episodes:tmdb:unified:anilist:{id}) - the matching is INSIDE the cached
 * loader, so a TMDB matching/search failure also serves stale cached data
 * according to the existing stale-if-error rules before surfacing.
 *
 * @param {object} canonical Canonical AniList anime (identity + titles).
 * @param {object} [deps]
 * @param {import('../providers/tmdb/tmdb.provider.js').TmdbProvider} [deps.provider]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @returns {Promise<object|null>} Unified episode list
 *   ({ resolved, tmdbSeriesId, episodes, totalEpisodes, failedSeasons,
 *   seasonNumbers }), or null when TMDB is not configured / no confident TMDB
 *   match exists (the caller falls back to Jikan).
 * @throws {ValidationError} invalid canonical input. @throws {ProviderError|
 *   TimeoutError|RateLimitError} TMDB failure with no cached unified data.
 */
export async function getTmdbUnifiedEpisodes(
  canonical,
  { provider = tmdbProvider, cache = cacheManager } = {},
) {
  if (!canonical || typeof canonical !== 'object') {
    throw new ValidationError('getTmdbUnifiedEpisodes requires a canonical anime with a valid AniList identity');
  }
  const anilistId = parseRequiredId(canonical.anilistId, 'anilistId');

  // TMDB not configured -> null; the episode service falls back to Jikan
  // (TMDB stays OPTIONAL enrichment - no request is fired).
  if (!provider.isConfigured()) return null;

  const key = `episodes:tmdb:unified:anilist:${anilistId}`;
  const result = await cache.getOrLoad(
    key,
    async () => {
      // TMDB series ID via the EXISTING matching/enrichment system only.
      const visual = await enrichWithTmdb(canonical, { provider, cache });
      if (!visual.resolved || !Number.isInteger(visual.tmdbId) || visual.tmdbId <= 0) {
        // No confident TMDB match -> valid unresolved; the caller falls back
        // to Jikan. Never cached as unified episode data (isValid rejects it).
        return null;
      }
      return buildUnifiedEpisodes(visual.tmdbId, { provider });
    },
    { ttlSeconds: CACHE_TTL.DAY, isValid: isCacheableUnified },
  );

  return isUsableUnified(result) ? result : null;
}
