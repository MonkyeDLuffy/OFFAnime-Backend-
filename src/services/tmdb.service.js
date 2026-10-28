/**
 * TMDB service - visual enrichment for already-known anime.
 *
 *   Canonical Anime -> TMDB service -> cacheManager.getOrLoad
 *                                          -> TMDB provider (search)
 *                                          -> normalizer + conservative matcher
 *                                          -> visual enrichment result
 *                                          -> mergeTmdbIntoCanonical (caller)
 *
 * Design guarantees:
 *   - Cache stores NORMALIZED enrichment results, never raw API responses.
 *   - Three distinct outcomes that are never conflated:
 *       * Successful enrichment  (resolved: true, confident match)
 *       * Valid unresolved       (searched, no confident match / TMDB not
 *                                 configured / no title available)
 *       * Provider failure       (typed error propagates - NEVER cached as
 *                                 visual data; stale-if-error still applies)
 *   - TMDB is OPTIONAL: when unavailable (not configured) the result is a
 *     valid unresolved enrichment and AniList/Jikan data keeps working. A
 *     TMDB failure never causes destructive fallback.
 *   - Conservative matching (tmdb.matching.js): a candidate is accepted only
 *     when it confidently matches. Matching is season-aware: AniList models
 *     sequels as separate entries that share ONE TMDB TV series, so searches
 *     try full titles AND season-stripped franchise base titles, the year rule
 *     is media-type aware (later seasons legitimately air years after their
 *     series premiere), and multiple AniList IDs MAY resolve to the same
 *     tmdbId. The TMDB season number is derived only from title/year evidence
 *     validated against actual TMDB season metadata - never guessed.
 *   - Search efficiency: uses already-known titles (plus base variants),
 *     searches conservatively (max 4 title attempts), validates candidates,
 *     stops at the first reliable title that yields a confident match, caches
 *     the result. Serverless-friendly - no unbounded search loops.
 *   - Request coalescing through the existing cache manager.
 *   - Media assets (logos, backdrops, trailers) are resolved per-TMDB-ID via
 *     the images/videos endpoints with the same cache/coalescing layer, and
 *     NEVER fail the /api/tmdb/:id response: an unavailable leg degrades to
 *     null/[] fields (cached with a conservative short TTL), while the visual
 *     match itself keeps the strict failure semantics above.
 *   - No frontend routes activated; internal enrichment capability only.
 */

import { tmdbProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { ValidationError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import {
  createUnresolvedTmdbVisual,
  normalizeTmdbCandidates,
  normalizeTmdbImageAssets,
  normalizeTmdbSeasons,
  normalizeTmdbVideoAssets,
  normalizeTmdbVisual,
} from '../normalizers/tmdb.normalizer.js';
import {
  deriveTmdbSeasonNumber,
  extractKnownTitles,
  extractTitleSeasonNumber,
  normalizeTitleForComparison,
  selectBestMatch,
  stripSeasonSuffixDeep,
} from '../normalizers/tmdb.matching.js';

/** Valid unresolved enrichments get a conservative (shorter) TTL than resolved ones. */
const UNRESOLVED_TTL_SECONDS = CACHE_TTL.MEDIUM;

/** Max TMDB search attempts per enrichment (serverless-friendly, conservative). */
const MAX_SEARCH_ATTEMPTS = 4;

/**
 * Cache-key version for visual enrichments. Bumped when matching semantics
 * change so stale `no_confident_match` results produced by the previous
 * matcher are never served - the new logic retries instead.
 */
const VISUAL_CACHE_VERSION = 'v2';

/** AniList formats whose TMDB season numbering is trustworthy season mapping. */
const SEASON_ELIGIBLE_FORMATS = new Set(['TV', 'TV_SHORT']);

/** A cached value is valid only if it is a real visual-enrichment result. */
const isVisualResult = (value) =>
  Boolean(value && typeof value === 'object' && typeof value.resolved === 'boolean');

/**
 * Enrich a canonical anime with TMDB visuals.
 *
 * Returns an enrichment result ({ resolved, tmdbId, mediaType, images, poster,
 * tmdbSeasonNumber, season, matchedTitle, matchStrategy }). Attach it to
 * canonical data with `mergeTmdbIntoCanonical` - only resolved results are
 * merged, so a TMDB failure/unresolved result can never replace existing
 * AniList/Jikan data. Multiple AniList season entries may resolve to the same
 * tmdbId (one TMDB series holds several AniList seasons) - each entry keeps
 * its own cache entry keyed by AniList ID.
 *
 * @param {import('../normalizers/anime.types.js').CanonicalAnime} canonical
 * @param {object} [deps]
 * @param {import('../providers/tmdb/tmdb.provider.js').TmdbProvider} [deps.provider]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @returns {Promise<import('../normalizers/tmdb.types.js').TmdbVisualResult>}
 * @throws {ValidationError} invalid canonical input. @throws {ProviderError|
 *   TimeoutError|RateLimitError} provider failure with no stale cache.
 */
export async function enrichWithTmdb(canonical, { provider = tmdbProvider, cache = cacheManager } = {}) {
  if (!canonical || typeof canonical !== 'object') {
    throw new ValidationError('enrichWithTmdb requires a canonical anime with a valid AniList identity');
  }
  const anilistId = parseRequiredId(canonical.anilistId, 'anilistId');

  // Keyed by the ORIGINAL AniList ID (not the TMDB ID) - distinct AniList
  // entries sharing one TMDB series each keep their own season mapping.
  const key = visualCacheKey(anilistId);
  const result = await cache.getOrLoad(
    key,
    () => resolveTmdbVisual(canonical, { provider }),
    { ttlSeconds: CACHE_TTL.DAY, isValid: isVisualResult },
  );

  // Valid unresolved enrichments get a conservative (shorter) TTL. This
  // overwrite only happens after a successful (or genuinely unresolved)
  // service outcome - never on a provider failure.
  if (!result.resolved) {
    await cache.set(key, result, UNRESOLVED_TTL_SECONDS);
  }

  return result;
}

/**
 * Namespace-safe visual cache key (versioned so matcher upgrades retry
 * stale unresolved results).
 * @param {number} anilistId
 * @returns {string}
 */
function visualCacheKey(anilistId) {
  return `tmdb:visual:${VISUAL_CACHE_VERSION}:anilist:${anilistId}`;
}

/**
 * Normalized title attempts a fresh TMDB resolution would try, in trusted
 * priority order: full AniList/Jikan titles first, then season-stripped
 * franchise base titles ("One Punch Man 2" -> "One Punch Man") so sequels
 * that share one TMDB TV series can find their parent. Shared by the
 * cold-path resolver and the expanded-title retry so both attempt titles
 * identically.
 * @param {object} canonical
 * @param {number} [maxAttempts]
 * @returns {{ title: string, normalized: string }[]}
 */
function plannedTitleAttempts(canonical, maxAttempts = MAX_SEARCH_ATTEMPTS) {
  const seen = new Set();
  const attempts = [];
  const push = (title) => {
    const normalized = normalizeTitleForComparison(title);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    attempts.push({ title, normalized });
  };
  const fullTitles = extractKnownTitles(canonical);
  for (const title of fullTitles) push(title);
  for (const title of fullTitles) push(stripSeasonSuffixDeep(title));
  return attempts.slice(0, Math.max(0, maxAttempts));
}

/**
 * The normalized titles a standard TMDB enrichment would (or did) attempt,
 * used to avoid re-searching the same titles in the expanded-title retry.
 * @param {object} canonical
 * @returns {string[]}
 */
export function plannedAttemptedTitles(canonical) {
  return plannedTitleAttempts(canonical).map((attempt) => attempt.normalized);
}

/**
 * Fresh enrichment resolution (cache miss path).
 * @param {object} canonical
 * @param {{ provider: import('../providers/tmdb/tmdb.provider.js').TmdbProvider }} deps
 * @returns {Promise<import('../normalizers/tmdb.types.js').TmdbVisualResult>}
 */
async function resolveTmdbVisual(canonical, { provider }) {
  // TMDB not configured -> valid unresolved enrichment; AniList/Jikan unaffected.
  if (!provider.isConfigured()) {
    return createUnresolvedTmdbVisual('tmdb_not_configured');
  }

  // Title priority from trusted metadata only (AniList first, then Jikan).
  const titles = extractKnownTitles(canonical);
  if (titles.length === 0) {
    return createUnresolvedTmdbVisual('no_title_available');
  }

  // Media type from trusted format: MOVIE -> movie; TV/TV_SHORT/OVA/ONA/etc.
  // conservatively use tv (validated by the matcher before acceptance).
  const mediaType = canonical.format === 'MOVIE' ? 'movie' : 'tv';

  // Trusted release year for client-side validation only - the year is NOT
  // sent to TMDB search, because small calendar differences between databases
  // would wrongly exclude valid matches.
  const year = canonical.seasonYear ?? null;

  // Conservative search: at most MAX_SEARCH_ATTEMPTS title attempts (full
  // titles first, then season-stripped franchise base titles), stopping at
  // the first reliable title that yields a confident match.
  const attempts = plannedTitleAttempts(canonical);
  const accumulatedCandidates = [];

  for (const attempt of attempts) {
    const raw = mediaType === 'movie'
      ? await provider.searchMovie(attempt.title)
      : await provider.searchTv(attempt.title);
    accumulatedCandidates.push(...normalizeTmdbCandidates(raw, mediaType));

    const match = selectBestMatch(accumulatedCandidates, { titles, year, mediaType });
    if (match) {
      return finalizeTmdbVisual(match, canonical, { provider });
    }
  }

  // No sufficiently confident match exists - do NOT force a result.
  return createUnresolvedTmdbVisual('no_confident_match');
}

/**
 * Complete a confident match into its final visual result: attach the derived
 * (validated) TMDB season number for episodic TV entries. The series/movie
 * match itself is NEVER discarded because season metadata is unavailable -
 * the season simply stays unresolved (null).
 *
 * @param {import('../normalizers/tmdb.matching.js').TmdbMatch} match
 * @param {object} canonical
 * @param {{ provider: import('../providers/tmdb/tmdb.provider.js').TmdbProvider }} deps
 * @returns {Promise<import('../normalizers/tmdb.types.js').TmdbVisualResult>}
 */
async function finalizeTmdbVisual(match, canonical, { provider }) {
  const visual = normalizeTmdbVisual(match.candidate, { strategy: match.strategy });

  // Season derivation only for episodic TV entries (a movie has no season,
  // and AniList OVA/ONA/SPECIAL entry numbering is not season evidence).
  if (visual.mediaType !== 'tv' || !SEASON_ELIGIBLE_FORMATS.has(canonical?.format)) {
    return visual;
  }

  try {
    const details = await provider.getTvDetails(visual.tmdbId);
    const seasons = normalizeTmdbSeasons(details);
    const titleSeasonNumber = extractKnownTitles(canonical)
      .map((title) => extractTitleSeasonNumber(title))
      .find((n) => n !== null) ?? null;
    const seasonNumber = deriveTmdbSeasonNumber({
      seasons,
      titleSeasonNumber,
      entryYear: canonical.seasonYear ?? null,
      seriesStartYear: match.candidate.year ?? null,
    });
    if (seasonNumber !== null) {
      visual.tmdbSeasonNumber = seasonNumber;
      visual.season = seasons.find((s) => s.seasonNumber === seasonNumber) ?? null;
    }
  } catch (err) {
    // Season metadata is optional enrichment: the reliable series-level match
    // stands with tmdbSeasonNumber unresolved (never a fabricated season).
    logger.warn('tmdb.seasonDerivationSkipped', { tmdbId: visual.tmdbId, err });
  }

  return visual;
}

/**
 * Expanded-title retry for a previously UNRESOLVED enrichment: attempt titles
 * that a standard enrichment did NOT try (e.g. Jikan-provided alternates that
 * became available after Jikan enrichment completed concurrently with the
 * first TMDB resolution). Bounded to MAX_SEARCH_ATTEMPTS NEW title searches,
 * never re-searches excluded (already-attempted) titles, and only a confident
 * match is returned - otherwise null (never a forced result). A resolved
 * result overwrites the cached unresolved entry with the resolved DAY TTL.
 *
 * @param {object} canonical Jikan-merged canonical anime (richest title set).
 * @param {string[]} excludeNormalized Titles already attempted (skipped).
 * @param {object} [deps]
 * @param {import('../providers/tmdb/tmdb.provider.js').TmdbProvider} [deps.provider]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @returns {Promise<import('../normalizers/tmdb.types.js').TmdbVisualResult | null>}
 *   Resolved visual result, or null when no new title yields a confident match.
 */
export async function enrichWithExpandedTitles(canonical, excludeNormalized = [], { provider = tmdbProvider, cache = cacheManager } = {}) {
  if (!canonical || typeof canonical !== 'object') return null;
  if (!provider.isConfigured()) return null;

  const anilistId = parseRequiredId(canonical.anilistId, 'anilistId');
  const excluded = new Set(excludeNormalized);
  const newAttempts = plannedTitleAttempts(canonical, MAX_SEARCH_ATTEMPTS * 2)
    .filter((attempt) => !excluded.has(attempt.normalized))
    .slice(0, MAX_SEARCH_ATTEMPTS);
  if (newAttempts.length === 0) return null;

  const titles = extractKnownTitles(canonical);
  const mediaType = canonical.format === 'MOVIE' ? 'movie' : 'tv';
  const year = canonical.seasonYear ?? null;
  const accumulatedCandidates = [];

  for (const attempt of newAttempts) {
    const raw = mediaType === 'movie'
      ? await provider.searchMovie(attempt.title)
      : await provider.searchTv(attempt.title);
    accumulatedCandidates.push(...normalizeTmdbCandidates(raw, mediaType));

    const match = selectBestMatch(accumulatedCandidates, { titles, year, mediaType });
    if (match) {
      const visual = await finalizeTmdbVisual(match, canonical, { provider });
      // A confident match overwrites the cached unresolved entry (DAY TTL).
      await cache.set(visualCacheKey(anilistId), visual, CACHE_TTL.DAY);
      return visual;
    }
  }

  return null;
}

// --- media assets (logos, backdrops, trailers) --------------------------------

/** A cached value is valid only if it is a real media-asset result. */
const isMediaAssets = (value) =>
  Boolean(value && typeof value === 'object' && typeof value.complete === 'boolean');

/** An empty/unavailable media-asset result (valid, never fabricated data). */
function createUnavailableTmdbMedia(reason, tmdbId, mediaType) {
  return {
    complete: false,
    tmdbId,
    mediaType,
    logo: null,
    backdrops: [],
    trailer: null,
    videos: [],
    reason: reason ?? 'tmdb_media_unavailable',
  };
}

/** Guard: the upstream payload must belong to the requested TMDB entry. */
function payloadBelongsTo(payload, tmdbId) {
  return Number(payload?.id) === tmdbId;
}

/**
 * Fresh media-asset resolution (cache miss path). Images and videos are
 * fetched IN PARALLEL and degrade independently: a failing leg leaves the
 * other leg's data intact (missing logos/trailers never fail the request).
 * @param {number} tmdbId
 * @param {'tv'|'movie'} mediaType
 * @param {{ provider: import('../providers/tmdb/tmdb.provider.js').TmdbProvider }} deps
 * @returns {Promise<import('../normalizers/tmdb.types.js').TmdbMediaAssets>}
 */
async function resolveTmdbMediaAssets(tmdbId, mediaType, { provider }) {
  // TMDB not configured -> valid unavailable assets (defensive; the visual
  // enrichment is already unresolved in this state, so callers never reach here).
  if (!provider.isConfigured()) {
    return createUnavailableTmdbMedia('tmdb_not_configured', tmdbId, mediaType);
  }

  const imagesPromise = mediaType === 'movie'
    ? provider.getMovieImages(tmdbId)
    : provider.getTvImages(tmdbId);
  const videosPromise = mediaType === 'movie'
    ? provider.getMovieVideos(tmdbId)
    : provider.getTvVideos(tmdbId);

  const [imagesSettled, videosSettled] = await Promise.allSettled([imagesPromise, videosPromise]);

  /** @type {string[]} */
  const failedLegs = [];
  let logo = null;
  let backdrops = [];
  let trailer = null;
  let videos = [];

  if (imagesSettled.status === 'fulfilled' && payloadBelongsTo(imagesSettled.value, tmdbId)) {
    ({ logo, backdrops } = normalizeTmdbImageAssets(imagesSettled.value));
  } else {
    failedLegs.push('images');
  }

  if (videosSettled.status === 'fulfilled' && payloadBelongsTo(videosSettled.value, tmdbId)) {
    ({ trailer, videos } = normalizeTmdbVideoAssets(videosSettled.value));
  } else {
    failedLegs.push('videos');
  }

  if (failedLegs.length > 0) {
    logger.warn('tmdb.mediaLegUnavailable', { tmdbId, mediaType, failedLegs });
  }

  return {
    complete: failedLegs.length === 0,
    tmdbId,
    mediaType,
    logo,
    backdrops,
    trailer,
    videos,
    reason: failedLegs.length === 0 ? null : `${failedLegs.sort().join('_and_')}_unavailable`,
  };
}

/**
 * Media assets (logo, backdrops, trailer/videos) for a RESOLVED TMDB entry,
 * keyed per-tmdbId/mediaType so identical entries are never fetched twice.
 *
 * Caching policy (mirrors the visual-enrichment policy):
 *   - complete results   -> DAY TTL.
 *   - degraded results   -> overwritten with a conservative (shorter) TTL, so
 *     a temporary images/videos outage is retried soon instead of persisting
 *     empty fields for a day. Only ever written after a genuine service
 *     outcome - never on a coalesced failure.
 *
 * @param {number|string} tmdbId
 * @param {'tv'|'movie'|null|undefined} mediaType
 * @param {object} [deps]
 * @param {import('../providers/tmdb/tmdb.provider.js').TmdbProvider} [deps.provider]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @returns {Promise<import('../normalizers/tmdb.types.js').TmdbMediaAssets>}
 * @throws {ValidationError} invalid tmdbId.
 */
export async function getTmdbMediaAssets(tmdbId, mediaType, { provider = tmdbProvider, cache = cacheManager } = {}) {
  const id = parseRequiredId(tmdbId, 'tmdbId');
  const type = mediaType === 'movie' ? 'movie' : 'tv';

  const key = `tmdb:media:${type}:${id}`;
  const result = await cache.getOrLoad(
    key,
    () => resolveTmdbMediaAssets(id, type, { provider }),
    { ttlSeconds: CACHE_TTL.DAY, isValid: isMediaAssets },
  );

  // Degraded (partial) results get a conservative (shorter) TTL - same policy
  // as unresolved enrichments above.
  if (!result.complete) {
    await cache.set(key, result, UNRESOLVED_TTL_SECONDS);
  }

  return result;
}

/**
 * Sensible backdrop fallback when the images metadata is unavailable/empty:
 * the enrichment's real TMDB backdrop URL (built from the actual search-result
 * backdrop path) - never a poster, never a fabricated URL.
 * @param {import('../normalizers/tmdb.types.js').TmdbVisualResult} visual
 * @returns {import('../normalizers/tmdb.types.js').TmdbBackdrop[]}
 */
function fallbackBackdrops(visual) {
  const url = visual?.images?.backdrop ?? null;
  return url
    ? [{ path: null, url, urlOriginal: url, width: null, height: null, language: null, voteAverage: null }]
    : [];
}

/**
 * The complete /api/tmdb/:id payload: the existing visual-enrichment contract
 * (resolved/tmdbId/mediaType/images/poster/reason) PLUS the additive media
 * fields (logo, backdrops, trailer, videos). Pure composition - the cached
 * assets stay untouched and unresolved visuals never gain fabricated assets.
 *
 * @param {import('../normalizers/tmdb.types.js').TmdbVisualResult} visual
 * @param {import('../normalizers/tmdb.types.js').TmdbMediaAssets | null} media
 * @returns {object}
 */
export function composeTmdbMediaResponse(visual, media) {
  if (!media) {
    // Unresolved visual (no confident match / TMDB unavailable): additive
    // fields mirror the existing null convention (images/poster are null too).
    return { ...visual, logo: null, backdrops: null, trailer: null, videos: null };
  }
  return {
    ...visual,
    logo: media.logo ?? null,
    backdrops: Array.isArray(media.backdrops) && media.backdrops.length > 0
      ? media.backdrops
      : fallbackBackdrops(visual),
    trailer: media.trailer ?? null,
    videos: Array.isArray(media.videos) ? media.videos : [],
  };
}

/**
 * Full /api/tmdb/:id response for an enrichment result: resolved visuals get
 * cached media assets; unresolved visuals get null additive fields. Media
 * assets never fail this response (graceful null/[] degradation inside).
 *
 * @param {import('../normalizers/tmdb.types.js').TmdbVisualResult} visual
 * @param {object} [deps]
 * @param {import('../providers/tmdb/tmdb.provider.js').TmdbProvider} [deps.provider]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @returns {Promise<object>}
 * @throws {ValidationError} invalid visual input.
 */
export async function getTmdbMediaResponse(visual, { provider = tmdbProvider, cache = cacheManager } = {}) {
  if (!visual || typeof visual !== 'object') {
    throw new ValidationError('getTmdbMediaResponse requires a TMDB visual enrichment result');
  }
  if (visual.resolved !== true || visual.tmdbId === null || visual.tmdbId === undefined) {
    return composeTmdbMediaResponse(visual, null);
  }
  const media = await getTmdbMediaAssets(visual.tmdbId, visual.mediaType, { provider, cache });
  return composeTmdbMediaResponse(visual, media);
}
