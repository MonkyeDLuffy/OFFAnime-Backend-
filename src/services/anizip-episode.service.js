/**
 * AniZip episode service - the cached AniZip episode-metadata flow used by
 * GET /api/episodes/:id (AniZip is the DEFAULT detailed-episode provider).
 *
 *   getAnizipEpisodes(anilistId)
 *     -> cacheManager.getOrLoad('anizip:episodes:anilist:{anilistId}')
 *        -> AnizipProvider.getMappingsByAnilistId (AniList ID used DIRECTLY -
 *           never converted to a MAL ID for this request)
 *        -> normalizeAnizipEpisodes (episode objects + thumbnails + titles)
 *     -> normalized episodes (cached) | null ("cannot provide")
 *
 * Caching (through the existing CacheManager - no second cache system):
 *   - AniZip-specific, namespace-safe key including the AniList ID:
 *       anizip:episodes:anilist:{anilistId}
 *   - Only successfully NORMALIZED, non-empty episode lists are cached.
 *     Malformed payloads (typed ProviderError from the normalizer) are NEVER
 *     cached as valid episode data.
 *   - Request coalescing: N concurrent requests for the same AniList ID share
 *     ONE in-flight provider request (CacheManager + RequestCoalescer).
 *   - Stale-if-error: a provider failure serves the stale cached episode data
 *     when one exists; with no cache the typed provider error propagates
 *     (never a fake empty list).
 *
 * "Cannot provide" vs failure:
 *   - AniZip has no mapping for the AniList ID (upstream 404 -> NotFoundError)
 *     or returns a VALID payload with no normal episodes -> null. The episode
 *     service falls back to the existing TMDB -> Jikan chain.
 *   - Any OTHER provider failure (timeout/429/500/network) propagates as its
 *     typed error - an outage is never hidden behind fake/empty episode data.
 */

import { anizipProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { NotFoundError } from '../errors/index.js';
import { normalizeAnizipEpisodes } from '../normalizers/anizip-normalizer.js';

/**
 * A cached AniZip result is usable only when it is a normalized result with
 * at least one real episode (an honest empty list is treated as
 * "cannot provide" and never cached as a successful response).
 */
const isUsableAnizipEpisodes = (value) =>
  Boolean(
    value &&
      typeof value === 'object' &&
      Array.isArray(value.episodes) &&
      value.episodes.length > 0 &&
      value.episodes.every(
        (entry) => entry && typeof entry === 'object' && Number.isInteger(entry.episode) && entry.episode >= 1,
      ),
  );

/**
 * Normalized AniZip episode metadata for an AniList ID (cached).
 *
 * @param {number|string} anilistId AniList ID (the public route's canonical ID).
 * @param {object} [deps]
 * @param {import('../providers/anizip/anizip.provider.js').AnizipProvider} [deps.provider]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @returns {Promise<object|null>} Normalized AniZip result
 *   ({ episodes, totalEpisodes, titles, images, mappings, episodeCount,
 *   specialCount }), or null when AniZip cannot provide episodes for this ID
 *   (no mapping / no normal episodes) - the caller falls back.
 * @throws {TimeoutError|RateLimitError|ProviderError} on provider failure with
 *   no cached data (stale-if-error already applied through the cache layer).
 */
export async function getAnizipEpisodes(
  anilistId,
  { provider = anizipProvider, cache = cacheManager } = {},
) {
  // Validate the AniList ID BEFORE anything else (the route's :id is ALWAYS
  // an AniList ID; it is used directly - never converted to a MAL ID).
  const id = parseRequiredId(anilistId, 'anilistId');

  // Versioned key: v2 marks the absolute-episode-number fix. Pre-v2 entries
  // (same AniList ID) may hold lists TRUNCATED after the first cour (the old
  // normalizer dropped entries whose per-season episodeNumber contradicted
  // the absolute object key) - versioning the key invalidates every old
  // truncated L1/L2 entry without touching the cache architecture.
  const key = `anizip:episodes:v2:anilist:${id}`;
  try {
    const result = await cache.getOrLoad(
      key,
      async () => normalizeAnizipEpisodes(await provider.getMappingsByAnilistId(id)),
      { ttlSeconds: CACHE_TTL.DAY, isValid: isUsableAnizipEpisodes },
    );
    return isUsableAnizipEpisodes(result) ? result : null;
  } catch (err) {
    if (err instanceof NotFoundError) {
      // Genuine "not on AniZip" (upstream 404): a valid cannot-provide
      // outcome. Stale-if-error already served any cached data through the
      // cache layer; with no cache the caller falls back to TMDB -> Jikan.
      return null;
    }
    // timeout/429/500/network: typed provider failure with no cache available.
    // NEVER reinterpreted as "no episodes" - propagate so the API returns the
    // real failure instead of a fake empty list.
    throw err;
  }
}
