/**
 * TMDB normalizer - converts raw TMDB payloads into stable visual-enrichment
 * shapes. Identity is NEVER established here: these shapes contain only
 * `tmdbId` (a completely separate namespace from AniList/MAL IDs).
 *
 * Image URLs are built ONLY from actual TMDB paths via the centralized helper;
 * missing paths become null (never fabricated, never a disguised poster).
 */

import { normalizeId } from '../identity/id-types.js';
import { ProviderError } from '../errors/index.js';
import { tmdbImageUrl } from '../providers/tmdb/tmdb.queries.js';

/** @typedef {import('./tmdb.types.js').TmdbCandidate} TmdbCandidate */
/** @typedef {import('./tmdb.types.js').TmdbVisualResult} TmdbVisualResult */

/** String or null (empty/whitespace-only strings count as missing). */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Finite number or null. */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract a year from a TMDB date string ("YYYY-MM-DD" or "YYYY").
 * @param {unknown} value
 * @returns {number | null}
 */
function extractYear(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) && year > 0 ? year : null;
}

/**
 * Normalize a raw TMDB search-result entry (TV or movie) into a candidate.
 * Returns null for unusable entries (missing id) - never fabricates.
 * @param {unknown} raw
 * @param {'tv'|'movie'} [defaultMediaType='tv'] Search endpoints do not set
 *   media_type, so the searched kind is used.
 * @returns {TmdbCandidate | null}
 */
export function normalizeTmdbCandidate(raw, defaultMediaType = 'tv') {
  const tmdbId = normalizeId(raw?.id);
  if (tmdbId === null) return null;
  const mediaType = str(raw?.media_type) ?? defaultMediaType;
  return {
    tmdbId,
    mediaType: mediaType === 'movie' ? 'movie' : 'tv',
    title: str(raw?.name) ?? str(raw?.title),
    originalTitle: str(raw?.original_name) ?? str(raw?.original_title),
    year: extractYear(raw?.first_air_date ?? raw?.release_date),
    popularity: numberOrNull(raw?.popularity),
    images: {
      poster: tmdbImageUrl(raw?.poster_path, 'w500'),
      backdrop: tmdbImageUrl(raw?.backdrop_path, 'original'),
    },
  };
}

/**
 * Normalize an array of raw TMDB search results into candidates, dropping
 * unusable entries.
 * @param {unknown} raw Raw TMDB search payload ({ results: [...] }).
 * @param {'tv'|'movie'} [defaultMediaType='tv']
 * @returns {TmdbCandidate[]}
 */
export function normalizeTmdbCandidates(raw, defaultMediaType = 'tv') {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  return results
    .map((entry) => normalizeTmdbCandidate(entry, defaultMediaType))
    .filter(Boolean);
}

/**
 * Build a resolved visual-enrichment result from a selected candidate.
 * @param {TmdbCandidate} candidate
 * @param {object} [options]
 * @param {'title' | 'title_base' | null} [options.strategy] How the candidate
 *   matched (filled by the service's matcher).
 * @returns {TmdbVisualResult}
 */
export function normalizeTmdbVisual(candidate, { strategy = null } = {}) {
  return {
    resolved: true,
    tmdbId: candidate.tmdbId,
    mediaType: candidate.mediaType,
    images: {
      // Both come from the actual TMDB backdrop path - a poster is never
      // turned into a fake backdrop/banner.
      backdrop: candidate.images.backdrop,
      banner: candidate.images.backdrop,
    },
    poster: candidate.images.poster,
    // Season information: derived (and validated against TMDB season
    // metadata) by the service - null here, never guessed.
    tmdbSeasonNumber: null,
    season: null,
    // Match provenance (the TMDB entry that matched, and how).
    matchedTitle: candidate.title ?? candidate.originalTitle,
    matchStrategy: strategy ?? null,
    reason: null,
  };
}

/**
 * Build a VALID unresolved visual-enrichment result (no confident match / TMDB
 * unavailable). This is not a provider failure and never fabricates visuals.
 * @param {string} reason
 * @returns {TmdbVisualResult}
 */
export function createUnresolvedTmdbVisual(reason) {
  return {
    resolved: false,
    tmdbId: null,
    mediaType: null,
    images: null,
    poster: null,
    tmdbSeasonNumber: null,
    season: null,
    matchedTitle: null,
    matchStrategy: null,
    reason: str(reason) ?? 'unresolved',
  };
}

/**
 * Normalize raw TMDB details into a visual result (used when details are
 * fetched for a selected candidate instead of search results).
 * @param {unknown} raw Raw TMDB details payload.
 * @param {'tv'|'movie'} mediaType
 * @returns {TmdbVisualResult | null}
 */
export function normalizeTmdbDetails(raw, mediaType = 'tv') {
  const tmdbId = normalizeId(raw?.id);
  if (tmdbId === null) return null;
  return {
    resolved: true,
    tmdbId,
    mediaType: mediaType === 'movie' ? 'movie' : 'tv',
    images: {
      backdrop: tmdbImageUrl(raw?.backdrop_path, 'original'),
      banner: tmdbImageUrl(raw?.backdrop_path, 'original'),
    },
    poster: tmdbImageUrl(raw?.poster_path, 'w500'),
    tmdbSeasonNumber: null,
    season: null,
    matchedTitle: str(raw?.name) ?? str(raw?.title),
    matchStrategy: null,
    reason: null,
  };
}

/**
 * Normalize a raw TMDB TV details payload's seasons list into stable season
 * metadata (used for tmdbSeasonNumber derivation and season-level artwork).
 * Season 0 (specials) is kept with its number - callers filter it.
 * @param {unknown} raw Raw TMDB TV details payload ({ seasons: [...] }).
 * @returns {TmdbSeason[]}
 */
export function normalizeTmdbSeasons(raw) {
  const entries = Array.isArray(raw?.seasons) ? raw.seasons : [];
  return entries
    .map((entry) => {
      const seasonNumber = numberOrNull(entry?.season_number);
      if (seasonNumber === null || seasonNumber < 0) return null;
      return {
        seasonNumber,
        name: str(entry?.name),
        airDate: str(entry?.air_date),
        posterPath: str(entry?.poster_path),
        poster: tmdbImageUrl(entry?.poster_path, 'w500'),
        episodeCount: numberOrNull(entry?.episode_count),
      };
    })
    .filter(Boolean);
}

/**
 * Normalize a raw TMDB TV season payload ({ episodes: [...] }) into canonical
 * episode entries (episode METADATA only - never stream URLs).
 *
 * Episode numbers come ONLY from TMDB's actual `episode_number` field - never
 * from list position, never fabricated. Values TMDB does not provide
 * (Japanese titles, filler/recap flags, MAL IDs) stay null - never invented.
 *
 * @param {unknown} raw
 * @returns {Array<{ episode: number, malId: number|null, title: string|null, titleJapanese: string|null, aired: string|null, score: number|null, filler: boolean|null, recap: boolean|null, source: 'tmdb' }>}
 * @throws {ProviderError} when the payload is missing/has no episodes array.
 */
export function normalizeTmdbSeasonEpisodes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('TMDB season payload is missing or malformed');
  }
  const episodes = Array.isArray(raw.episodes) ? raw.episodes : null;
  if (episodes === null) {
    // A payload without an episodes array is unusable - never cache as valid empty.
    throw new ProviderError('TMDB season payload is missing episodes');
  }
  return episodes
    .map((entry) => ({
      episode: numberOrNull(entry?.episode_number),
      malId: null, // TMDB has no MAL IDs - never invented
      title: str(entry?.name),
      titleJapanese: null, // not provided by TMDB - never invented
      aired: str(entry?.air_date),
      score: numberOrNull(entry?.vote_average),
      filler: null, // not provided by TMDB - never invented
      recap: null, // not provided by TMDB - never invented
      source: 'tmdb',
    }))
    .filter((entry) => entry.episode !== null);
}

// --- image/video metadata (logos, backdrops, trailers) ------------------------

/** Backdrop cap per response (lightweight; the top-ranked entries suffice). */
const MAX_BACKDROPS = 6;

/** Candidate video cap per response (trailers/teasers only). */
const MAX_VIDEOS = 8;

/** Language preference for logos: en, then ja, then languageless, then rest. */
function logoLanguageRank(language) {
  if (language === 'en') return 0;
  if (language === 'ja') return 1;
  if (language === null) return 2;
  return 3;
}

/** File extension from an actual TMDB file path (null when none). */
function pathExtension(path) {
  const match = typeof path === 'string' ? path.match(/\.([A-Za-z0-9]+)$/) : null;
  return match ? match[1].toLowerCase() : null;
}

/**
 * Select the best logo from raw TMDB image metadata. Transparent PNG logos are
 * preferred when available; within that, language (en > ja > languageless) and
 * TMDB's community vote decide. Built ONLY from actual file paths.
 * @param {unknown} raw Raw TMDB images payload ({ logos: [...] }).
 * @returns {import('./tmdb.types.js').TmdbLogo | null}
 */
export function normalizeTmdbLogo(raw) {
  const entries = Array.isArray(raw?.logos) ? raw.logos : [];
  const candidates = entries
    .map((entry) => {
      const path = str(entry?.file_path);
      if (path === null) return null;
      return {
        path,
        language: str(entry?.iso_639_1),
        extension: pathExtension(path),
        voteAverage: numberOrNull(entry?.vote_average),
      };
    })
    .filter(Boolean);

  if (candidates.length === 0) return null;

  // PNG (transparent raster, universally supported) wins when available.
  const pngOnly = candidates.filter((logo) => logo.extension === 'png');
  const pool = pngOnly.length > 0 ? pngOnly : candidates;

  pool.sort((a, b) =>
    logoLanguageRank(a.language) - logoLanguageRank(b.language)
    || (b.voteAverage ?? 0) - (a.voteAverage ?? 0),
  );

  const logo = pool[0];
  return {
    path: logo.path,
    url: tmdbImageUrl(logo.path, 'w500'),
    urlOriginal: tmdbImageUrl(logo.path, 'original'),
    language: logo.language,
    extension: logo.extension,
    voteAverage: logo.voteAverage,
  };
}

/**
 * Normalize ranked, high-quality backdrops from raw TMDB image metadata.
 * Landscape by definition (backdrops); ranked by TMDB community vote, then
 * intrinsic resolution. URLs are built ONLY from actual file paths - never a
 * stretched poster, never fabricated.
 * @param {unknown} raw Raw TMDB images payload ({ backdrops: [...] }).
 * @returns {import('./tmdb.types.js').TmdbBackdrop[]}
 */
export function normalizeTmdbBackdrops(raw) {
  const entries = Array.isArray(raw?.backdrops) ? raw.backdrops : [];
  return entries
    .map((entry) => {
      const path = str(entry?.file_path);
      if (path === null) return null;
      return {
        path,
        url: tmdbImageUrl(path, 'w1280'),
        urlOriginal: tmdbImageUrl(path, 'original'),
        width: numberOrNull(entry?.width),
        height: numberOrNull(entry?.height),
        language: str(entry?.iso_639_1),
        voteAverage: numberOrNull(entry?.vote_average),
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      (b.voteAverage ?? 0) - (a.voteAverage ?? 0)
      || (b.width ?? 0) - (a.width ?? 0),
    )
    .slice(0, MAX_BACKDROPS);
}

/**
 * Normalize raw TMDB image metadata into the logo + backdrops pair.
 * @param {unknown} raw Raw TMDB images payload.
 * @returns {{ logo: import('./tmdb.types.js').TmdbLogo | null, backdrops: import('./tmdb.types.js').TmdbBackdrop[] }}
 */
export function normalizeTmdbImageAssets(raw) {
  return {
    logo: normalizeTmdbLogo(raw),
    backdrops: normalizeTmdbBackdrops(raw),
  };
}

/** Only official trailer/teaser material qualifies as trailer metadata. */
const TRAILER_VIDEO_TYPES = new Set(['Trailer', 'Teaser']);

/**
 * Normalize one raw TMDB video entry into stable metadata. Watch/embed URLs
 * are built ONLY for YouTube keys (documented scheme) - never invented for
 * other providers. Returns null for unusable entries (missing key/site/type).
 * @param {unknown} entry
 * @returns {import('./tmdb.types.js').TmdbVideo | null}
 */
function normalizeTmdbVideo(entry) {
  const key = str(entry?.key);
  const site = str(entry?.site);
  const type = str(entry?.type);
  if (key === null || site === null || type === null) return null;
  const isYouTube = site === 'YouTube';
  return {
    name: str(entry?.name),
    key,
    site,
    type,
    official: typeof entry?.official === 'boolean' ? entry.official : null,
    publishedAt: str(entry?.published_at),
    url: isYouTube ? `https://www.youtube.com/watch?v=${encodeURIComponent(key)}` : null,
    embedUrl: isYouTube ? `https://www.youtube.com/embed/${encodeURIComponent(key)}` : null,
  };
}

/** Trailer ranking: type (Trailer > Teaser), official first, newest first. */
function videoRank(video) {
  return {
    type: video.type === 'Trailer' ? 0 : 1,
    official: video.official === true ? 0 : 1,
    publishedAt: video.publishedAt ? Date.parse(video.publishedAt) || 0 : 0,
  };
}

/**
 * Normalize raw TMDB video metadata into the selected trailer + a bounded
 * candidate list. YouTube trailers/teasers only; the primary trailer prefers
 * official Trailer type, then official Teaser, newest first. Missing videos
 * yield { trailer: null, videos: [] } - never fabricated keys/URLs.
 * @param {unknown} raw Raw TMDB videos payload ({ results: [...] }).
 * @returns {{ trailer: import('./tmdb.types.js').TmdbVideo | null, videos: import('./tmdb.types.js').TmdbVideo[] }}
 */
export function normalizeTmdbVideoAssets(raw) {
  const entries = Array.isArray(raw?.results) ? raw.results : [];
  const videos = entries
    .map((entry) => normalizeTmdbVideo(entry))
    .filter((video) => video !== null && video.site === 'YouTube' && TRAILER_VIDEO_TYPES.has(video.type))
    .sort((a, b) => {
      const ra = videoRank(a);
      const rb = videoRank(b);
      return ra.type - rb.type
        || ra.official - rb.official
        || rb.publishedAt - ra.publishedAt;
    })
    .slice(0, MAX_VIDEOS);

  return { trailer: videos.length > 0 ? videos[0] : null, videos };
}
