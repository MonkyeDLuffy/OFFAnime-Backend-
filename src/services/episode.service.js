/**
 * Episode resolver/service - the ISOLATED home for the episode data flow
 * (GET /api/episodes/:anilistId).
 *
 * Pipeline (AniZip is the DEFAULT detailed-episode provider; the existing
 * TMDB -> Jikan chain remains the fallback when AniZip cannot provide
 * episodes for an anime):
 *
 *   GET /api/episodes/:anilistId
 *     -> validate AniList ID (identity layer; :id is ALWAYS an AniList ID)
 *     -> AniList canonical metadata (cached; identity + known total episodes)
 *     -> IdentityResolver.resolveAniListToMal: AniList ID -> ACTUAL MAL ID
 *        (cached, AniList `idMal` ONLY)
 *     -> cached composite episode result? -> return
 *     -> AniZip episode extraction (anizip-episode.service) - DEFAULT source:
 *            GET https://api.ani.zip/mappings?anilist_id={anilistId}
 *            (the AniList ID used DIRECTLY - never a MAL conversion)
 *            -> real episode numbers (object keyed by episode number),
 *               thumbnails, localized titles, overviews, air dates, runtime
 *            -> cached per AniList ID (anizip:episodes:v2:anilist:{id})
 *     -> AniZip cannot provide (no mapping / no episodes)? -> TMDB episode
 *        extraction (tmdb-episode.service):
 *            TMDB series ID via the EXISTING TMDB matching/enrichment system
 *            -> TV details -> normal seasons (Season 0/specials ignored)
 *            -> per-season fetch (bounded concurrency, per-season cache)
 *            -> deterministic flattening into ONE continuous episode list
 *               (globalEpisodeNumber; see tmdb-episode.mapper.js)
 *        -> unified list cached (episodes:tmdb:unified:anilist:{id});
 *           composite cached per AniList ID + page
 *     -> TMDB unavailable (not configured / no confident match)? -> Jikan
 *        fallback: JikanProvider.getAnimeEpisodes(malId, page)
 *            (GET https://api.jikan.moe/v4/anime/{malId}/episodes?page={page})
 *
 * Rules enforced here:
 *   - The route's canonical ID stays the AniList ID. Jikan is keyed by MAL
 *     IDs, so the actual MAL ID comes ONLY from the IdentityResolver (AniList
 *     `idMal`): never assumed equal to the AniList ID, never derived
 *     numerically, never title/fuzzy matched, never fabricated. The AniList
 *     ID is NEVER sent to Jikan or TMDB. The TMDB series ID comes ONLY from
 *     the existing TMDB matching/enrichment system and stays under
 *     TMDB-specific fields (tmdbEpisodeId) - a TMDB ID never becomes the
 *     AniList ID.
 *   - TMDB is the PRIMARY detailed-episode source. A TMDB provider failure
 *     propagates as its typed error (the cache manager's stale-if-error serves
 *     the stale unified list/composite when one exists and only then lets the
 *     error surface) - a provider outage is never hidden behind fake/empty
 *     episode data. Jikan is the FALLBACK only when TMDB cannot provide
 *     episodes at all (not configured / no confident match) - never a fake
 *     empty success.
 *   - AniList canonical metadata supplies identity + the known total episode
 *     count only - never individual episode objects. The AniList episode
 *     count is used ONLY as a validation/reference signal: the real TMDB data
 *     is preserved on a count mismatch and the mismatch is exposed in
 *     internal diagnostics (never corrupted to force a match).
 *   - Only the requested page is fetched by the Jikan fallback: `page` passes
 *     straight through to Jikan (page 1 omits the Jikan `page` param). The
 *     TMDB flow returns the full unified list (pageInfo: null - TMDB episode
 *     data is not paginated).
 *   - Failures are NEVER cached as successful episode data. Successful
 *     normalized data is cached per season (tmdb:season:{series}:{n}), as the
 *     unified list (episodes:tmdb:unified:anilist:{id}), and the composite per
 *     AniList ID + page (episodes:anilist:{anilistId}:page:{page}); the Jikan
 *     fallback caches per actual MAL ID + page.
 *   - Per-episode shape (TMDB): { episode, globalEpisodeNumber, seasonNumber,
 *     episodeNumber, tmdbEpisodeId, malId, title, titleJapanese, overview,
 *     aired, runtime, score, image, filler, recap, episodeType, source } -
 *     `episode`/`globalEpisodeNumber` are the unified/global episode number
 *     (deterministic flattening); TMDB's original numbering is preserved
 *     separately; missing fields stay null (never fabricated).
 */

import { cacheManager } from '../cache/cache-manager.js';
import { identityResolver } from '../identity/identity-resolver.js';
import { CACHE_TTL } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { ProviderError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import * as jikanService from './jikan.service.js';
import * as tmdbEpisodeService from './tmdb-episode.service.js';
import * as anizipEpisodeService from './anizip-episode.service.js';
import { getAnimeDetails } from './anime.service.js';

/**
 * A cached composite is valid only when it is a real episode result: AniZip
 * data (source 'anizip'), TMDB data (source 'tmdb'), Jikan fallback data
 * (source 'jikan'), or the honest unavailable representation (source null +
 * episodes null). Never a fabricated payload. A TMDB composite that still
 * carries a failed season (partial data) is never cached as valid episode
 * data - the failed season is retried on the next request.
 */
const isEpisodeResult = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (
    !(value.source === 'anizip' || value.source === 'tmdb' || value.source === 'jikan' || value.source === null)
  ) {
    return false;
  }
  if (!('episodes' in value)) return false;
  if (
    value.source === 'tmdb' &&
    Array.isArray(value.diagnostics?.failedSeasons) &&
    value.diagnostics.failedSeasons.length > 0
  ) {
    return false; // partial TMDB data (failed season) is never cached
  }
  return true;
};

/**
 * A Jikan episode page is usable only when it carries a real episodes array
 * (a valid Jikan 200 with an empty array is returned honestly as
 * episodes: []; a MISSING data array throws ProviderError in the
 * normalizer and is never cached).
 */
const isUsableEpisodePage = (value) =>
  Boolean(value && typeof value === 'object' && Array.isArray(value.episodes));

/**
 * Episode DETAILS for an anime. AniZip is the DEFAULT provider (keyed
 * directly by the AniList ID), with the existing TMDB -> Jikan chain as the
 * fallback when AniZip cannot provide episodes:
 *
 *   validate AniList ID -> AniZip mappings (anilist_id) -> normalize -> cache
 *   -> frontend contract; no AniZip data -> TMDB unified list -> Jikan page
 *   for the ACTUAL MAL ID from the identity layer.
 *
 * @param {number|string} anilistId ALWAYS an AniList ID.
 * @param {{ page?: number }} [options]
 * @returns {Promise<object>} Frontend contract:
 *   { id, anilistId, malId, totalEpisodes, pageInfo, episodes, source }.
 */
export async function getAnimeEpisodes(anilistId, { page = 1 } = {}) {
  // Validate the AniList ID (the route's :id is ALWAYS an AniList ID).
  const id = parseRequiredId(anilistId, 'anilistId');

  // Cached composite episode result (namespace-safe, keyed by the ANILIST ID
  // and page). The loader throws the typed Jikan error on provider failure, so
  // getOrLoad serves the STALE composite when one exists (a failure is never
  // cached as data) and only then propagates to HTTP.
  const key = `episodes:anilist:${id}:page:${page}`;
  return cacheManager.getOrLoad(
    key,
    () => buildEpisodeResult(id, { page }),
    { ttlSeconds: CACHE_TTL.MEDIUM, isValid: isEpisodeResult },
  );
}

/**
 * Build the episode composite: AniList identity/total + the TMDB unified
 * episode list (primary) or the Jikan episode page for the ACTUAL MAL ID
 * (fallback).
 * @param {number} anilistId
 * @param {{ page: number }} options
 * @returns {Promise<object>}
 */
async function buildEpisodeResult(anilistId, { page }) {
  // 1. Canonical AniList metadata (identity + known total episode count) -
  //    cached. AniList NEVER provides individual episode objects here.
  const canonical = await getAnimeDetails(anilistId);

  // 2. Actual MAL ID via the identity layer (AniList `idMal` ONLY - never
  //    guessed, never derived numerically, never treated as an AniList ID).
  const identity = await identityResolver.resolveAniListToMal(anilistId);
  const malId = identity.resolved && identity.malId !== null ? identity.malId : null;

  // 3. No MAL mapping (or a MOVIE, which has no MAL episode list): the honest
  //    unavailable representation - never fabricated, never a Jikan call.
  //    A documented successful outcome, cached by the composite loader.
  if (malId === null || canonical.format === 'MOVIE') {
    return {
      id: canonical.id,
      anilistId: canonical.id,
      malId,
      totalEpisodes: canonical.episodes,
      pageInfo: null,
      episodes: null,
      source: null,
    };
  }

  // 4. AniZip: the DEFAULT detailed episode source. It is keyed DIRECTLY by
  //    the AniList ID (never a MAL conversion) and provides real episode
  //    numbers, thumbnails, localized titles, overviews, air dates and
  //    runtime. Cached per AniList ID (anizip:episodes:v2:anilist:{id});
  //    request coalescing + stale-if-error apply through the cache layer. A
  //    non-404 provider failure with no cache propagates as its typed error
  //    (never a fake empty list); null means AniZip cannot provide episodes
  //    for this anime (no mapping / no normal episodes) -> existing
  //    TMDB -> Jikan fallback below.
  const anizip = await anizipEpisodeService.getAnizipEpisodes(anilistId);
  if (anizip) {
    // Diagnostics: the AniList episode count is a VALIDATION/REFERENCE signal
    // only. A count mismatch never corrupts the real AniZip episode list.
    const countsMatch =
      canonical.episodes !== null && canonical.episodes !== undefined
        ? canonical.episodes === anizip.totalEpisodes
        : null;
    if (countsMatch === false) {
      logger.warn('episodes.anizipCountMismatch', {
        anilistId,
        anilistEpisodes: canonical.episodes,
        anizipEpisodes: anizip.totalEpisodes,
      });
    }

    return {
      id: canonical.id,
      anilistId: canonical.id,
      malId,
      // The actual normalized main-episode count from AniZip (specials
      // excluded; numbering gaps preserved - never renumbered).
      totalEpisodes: anizip.totalEpisodes,
      // AniZip episode data is not paginated: the full list is returned.
      pageInfo: null,
      episodes: anizip.episodes,
      source: 'anizip',
      diagnostics: {
        anilistEpisodeCount: canonical.episodes ?? null,
        anizipEpisodeCount: anizip.totalEpisodes,
        countsMatch,
      },
    };
  }

  // 5. TMDB: the existing detailed-episode FALLBACK (used only when AniZip
  //    cannot provide episodes for this anime). The TMDB series ID comes
  //    ONLY from the existing matching/enrichment system; the extraction
  //    fetches every normal season (bounded concurrency, per-season caches)
  //    and flattens into ONE continuous episode list. A TMDB provider failure
  //    propagates as its typed error (stale-if-error serves the cached unified
  //    list/composite when one exists and only then surfaces); null means TMDB
  //    cannot provide episodes (not configured / no confident match) -> Jikan
  //    fallback below.
  const tmdbUnified = await tmdbEpisodeService.getTmdbUnifiedEpisodes(canonical);
  if (tmdbUnified) {
    // Diagnostics: the AniList episode count is a VALIDATION/REFERENCE signal
    // only. A count mismatch never corrupts the real TMDB episode list.
    const countsMatch = canonical.episodes !== null && canonical.episodes !== undefined
      ? canonical.episodes === tmdbUnified.totalEpisodes
      : null;
    if (countsMatch === false) {
      logger.warn('episodes.tmdbCountMismatch', {
        anilistId,
        anilistEpisodes: canonical.episodes,
        tmdbEpisodes: tmdbUnified.totalEpisodes,
      });
    }

    return {
      id: canonical.id,
      anilistId: canonical.id,
      malId,
      // The unified normal episode count (deterministic flattening; specials
      // excluded) - never blindly trusted from a single TMDB season.
      totalEpisodes: tmdbUnified.totalEpisodes,
      // TMDB episode data is not paginated: the full unified list is returned.
      pageInfo: null,
      episodes: tmdbUnified.episodes,
      source: 'tmdb',
      diagnostics: {
        anilistEpisodeCount: canonical.episodes ?? null,
        tmdbEpisodeCount: tmdbUnified.totalEpisodes,
        countsMatch,
        failedSeasons: tmdbUnified.failedSeasons ?? [],
        seasonNumbers: tmdbUnified.seasonNumbers ?? [],
      },
    };
  }

  // 6. Jikan FALLBACK: used only when neither AniZip nor TMDB can provide
  //    episodes. Exactly the requested page
  //    is fetched (the Jikan service caches the normalized page per MAL
  //    ID+page; its typed errors - NotFoundError/RateLimitError/ProviderError/
  //    TimeoutError - propagate through the composite loader).
  const jikanPage = await jikanService.getEpisodes(malId, { page });
  if (!isUsableEpisodePage(jikanPage)) {
    // Defensive: an invalid/empty normalized payload is never cached as
    // successful episode data.
    logger.warn('episodes.jikanUnusable', { anilistId, malId, page });
    throw new ProviderError(
      `Jikan episode data for MAL ID ${malId} is unavailable`,
      { provider: 'jikan', details: { malId, page } },
    );
  }

  return {
    id: canonical.id,
    anilistId: canonical.id,
    malId,
    // Prefer Jikan's pagination/data information; the AniList canonical
    // episode count fills in when Jikan reports no total.
    totalEpisodes: jikanPage.pageInfo.total ?? canonical.episodes,
    pageInfo: jikanPage.pageInfo,
    episodes: jikanPage.episodes.map((entry) => ({ ...entry, source: 'jikan' })),
    source: 'jikan',
  };
}
