/**
 * TMDB episode type definitions (JSDoc only - no runtime code).
 *
 * TMDB episode data is a SEPARATE namespace: these shapes carry ONLY TMDB IDs
 * (tmdbSeriesId / tmdbEpisodeId) - never `id`, `anilistId`, `malId`. TMDB
 * season/episode numbers are preserved separately and are NOT the public anime
 * episode number; the unified/global episode number is produced by
 * deterministic flattening (tmdb-episode.mapper.js).
 */

/**
 * One extracted TMDB episode record (from a season payload). Cached per season
 * (normalized data, never raw API payloads).
 *
 * @typedef {Object} TmdbEpisodeRecord
 * @property {number} tmdbEpisodeId  TMDB episode ID (actual `id` - never
 *   fabricated).
 * @property {number} tmdbSeriesId   TMDB TV series ID.
 * @property {number} seasonNumber   TMDB season number (>= 1).
 * @property {number} episodeNumber  TMDB episode number (>= 1).
 * @property {string|null} name
 * @property {string|null} overview
 * @property {string|null} airDate   TMDB `air_date`.
 * @property {number|null} runtime   Minutes.
 * @property {string|null} stillPath Raw TMDB still path (null when missing).
 * @property {string|null} image     Built ONLY from the actual still_path via
 *   tmdbImageUrl - never fabricated.
 * @property {number|null} voteAverage
 * @property {number|null} voteCount
 * @property {string|null} episodeType  TMDB `episode_type` (null when missing).
 * @property {'tmdb'} source
 */

/**
 * One extracted TMDB season (normalized). Cached independently per
 * tmdbSeriesId + seasonNumber so one failed season never destroys other
 * cached seasons.
 *
 * @typedef {Object} ExtractedTmdbSeason
 * @property {number} tmdbSeriesId
 * @property {number} seasonNumber
 * @property {TmdbEpisodeRecord[]} episodes
 */

/**
 * The unified episode list produced by deterministic flattening.
 *
 * @typedef {Object} UnifiedEpisodeList
 * @property {Array<object>} episodes  Frontend episode shapes with BOTH
 *   numbering systems ({ episode, globalEpisodeNumber, seasonNumber,
 *   episodeNumber, tmdbEpisodeId, ... }).
 * @property {number} totalEpisodes  Unified normal episode count (specials
 *   excluded).
 */

export {};
