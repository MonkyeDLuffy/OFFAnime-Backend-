/**
 * TMDB episode mapper/normalizer - converts TMDB's SEASON-based episode
 * structure into ONE continuous anime episode list (GET /api/episodes/:id).
 *
 * THE critical numbering rule:
 *
 *   TMDB season/episode numbers are NOT the public anime episode number.
 *   The public `episode` field (and `globalEpisodeNumber`) is produced by
 *   DETERMINISTIC FLATTENING:
 *
 *     - seasons are sorted numerically by seasonNumber
 *     - Season 0 / specials are IGNORED by default (never mixed in, never
 *       silently renumbered into Episode 1, Episode 2, ...)
 *     - inside each season episodes are sorted numerically by episodeNumber
 *     - globalEpisodeNumber starts at 1 and increments EXACTLY ONCE for every
 *       accepted standard episode
 *
 *   Example: S1=62 + S2=74 + S3=12 -> global 1..148, where global 63 = S2 E1.
 *
 * Duplicate/invalid data protection (all deterministic, never guessed):
 *   - invalid season numbers (< 1 / non-integer) are rejected (dropped)
 *   - invalid episode numbers (< 1 / non-integer) are rejected (dropped)
 *   - malformed episode entries are ignored
 *   - duplicate TMDB episode records are removed using the stable
 *     deduplication key: tmdbSeriesId + seasonNumber + episodeNumber
 *   - there are NEVER duplicate global episode numbers
 *   - episode IDs come ONLY from TMDB's actual `id` field - never fabricated
 *   - missing episode data stays null - never invented
 *
 * Image URLs are built ONLY from actual TMDB `still_path` values via the
 * centralized helper (tmdbImageUrl); missing paths become null (never
 * fabricated).
 */

import { normalizeId } from '../identity/id-types.js';
import { ProviderError } from '../errors/index.js';
import { tmdbImageUrl } from '../providers/tmdb/tmdb.queries.js';

/** @typedef {import('./tmdb-episode.types.js').ExtractedTmdbSeason} ExtractedTmdbSeason */
/** @typedef {import('./tmdb-episode.types.js').TmdbEpisodeRecord} TmdbEpisodeRecord */
/** @typedef {import('./tmdb-episode.types.js').UnifiedEpisodeList} UnifiedEpisodeList */

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
 * Extract the episode data we actually need from ONE raw TMDB season payload
 * (GET /3/tv/{tmdbSeriesId}/season/{seasonNumber}).
 *
 * The seasonNumber comes from the CALLER (chosen from trusted TMDB TV details,
 * never guessed here) and is trusted as-is. Extracted (normalized) episode
 * records are what gets cached - never raw API payloads.
 *
 * @param {unknown} raw Raw TMDB season payload ({ episodes: [...] }).
 * @param {object} ids
 * @param {number|string} ids.tmdbSeriesId TMDB TV series ID (TMDB namespace).
 * @param {number|string} ids.seasonNumber Season number (>= 1; Season 0 /
 *   specials never pass through here).
 * @returns {ExtractedTmdbSeason}
 * @throws {ProviderError} when the payload is missing/malformed/has no
 *   episodes array (never cached as valid season data).
 */
export function extractTmdbSeasonEpisodes(raw, { tmdbSeriesId, seasonNumber }) {
  const seriesId = normalizeId(tmdbSeriesId);
  if (seriesId === null) {
    throw new ProviderError('TMDB season extraction requires a valid tmdbSeriesId', {
      details: { tmdbSeriesId },
    });
  }
  const season = normalizeId(seasonNumber);
  if (season === null || season < 1) {
    // Reject invalid season numbers; Season 0/specials never reach extraction.
    throw new ProviderError('TMDB season extraction requires a valid season number (>= 1)', {
      details: { tmdbSeriesId: seriesId, seasonNumber },
    });
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('TMDB season payload is missing or malformed', {
      details: { tmdbSeriesId: seriesId, seasonNumber },
    });
  }
  if (!Array.isArray(raw.episodes)) {
    // A payload without an episodes array is unusable - never cached as a
    // valid empty season.
    throw new ProviderError('TMDB season payload is missing episodes', {
      details: { tmdbSeriesId: seriesId, seasonNumber },
    });
  }

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {TmdbEpisodeRecord[]} */
  const episodes = [];

  for (const entry of raw.episodes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue; // ignore malformed

    const episodeNumber = numberOrNull(entry.episode_number);
    const tmdbEpisodeId = normalizeId(entry.id);
    if (episodeNumber === null || !Number.isInteger(episodeNumber) || episodeNumber < 1) {
      continue; // reject invalid episode numbers
    }
    if (tmdbEpisodeId === null) {
      continue; // no real TMDB episode ID -> dropped (never fabricated)
    }

    // Stable deduplication key: tmdbSeriesId + seasonNumber + episodeNumber.
    const dedupKey = `${seriesId}:${season}:${episodeNumber}`;
    if (seen.has(dedupKey)) continue; // remove duplicate TMDB episode records
    seen.add(dedupKey);

    episodes.push({
      tmdbEpisodeId,
      tmdbSeriesId: seriesId,
      seasonNumber: season,
      episodeNumber,
      name: str(entry.name),
      overview: str(entry.overview),
      airDate: str(entry.air_date),
      runtime: numberOrNull(entry.runtime),
      stillPath: str(entry.still_path),
      image: tmdbImageUrl(entry.still_path, 'w500'),
      voteAverage: numberOrNull(entry.vote_average),
      voteCount: numberOrNull(entry.vote_count),
      episodeType: str(entry.episode_type),
      source: 'tmdb',
    });
  }

  // Deterministic ordering inside the season (TMDB order is not guaranteed).
  episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

  return { tmdbSeriesId: seriesId, seasonNumber: season, episodes };
}

/**
 * Flatten extracted TMDB seasons into ONE continuous anime episode list using
 * deterministic flattening (see module doc). Pure function - never mutates
 * inputs, never invents data, never produces duplicate global numbers.
 *
 * @param {ExtractedTmdbSeason[]} seasons Extracted season objects (Season 0 /
 *   invalid seasons are rejected here too, defensively).
 * @param {object} [options]
 * @param {number|string|null} [options.tmdbSeriesId] Optional series ID
 *   (TMDB namespace) used in the deduplication key.
 * @returns {UnifiedEpisodeList}
 *   { episodes, totalEpisodes } - totalEpisodes is the unified normal episode
 *   count (e.g. Hunter x Hunter: 62 + 74 + 12 -> 148).
 */
export function mapTmdbSeasonsToGlobalEpisodes(seasons, { tmdbSeriesId = null } = {}) {
  const seriesId = normalizeId(tmdbSeriesId);

  // Reject invalid season numbers; ignore Season 0/specials by default.
  const validSeasons = (Array.isArray(seasons) ? seasons : []).filter(
    (season) =>
      season &&
      typeof season === 'object' &&
      Number.isInteger(season.seasonNumber) &&
      season.seasonNumber >= 1 &&
      Array.isArray(season.episodes),
  );

  // Sort seasons numerically by seasonNumber; drop duplicate season records
  // (keep the first occurrence for a given season number).
  validSeasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
  /** @type {Set<number>} */
  const seenSeasons = new Set();
  const dedupedSeasons = validSeasons.filter((season) => {
    if (seenSeasons.has(season.seasonNumber)) return false;
    seenSeasons.add(season.seasonNumber);
    return true;
  });

  /** @type {Set<string>} */
  const seenEpisodes = new Set();
  /** @type {Array<object>} */
  const episodes = [];
  let globalEpisodeNumber = 0;

  for (const season of dedupedSeasons) {
    // Deterministic ordering inside each season (re-sorted defensively).
    const sorted = [...season.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);

    for (const record of sorted) {
      if (!record || typeof record !== 'object') continue; // ignore malformed

      const episodeNumber = numberOrNull(record.episodeNumber);
      const tmdbEpisodeId = normalizeId(record.tmdbEpisodeId);
      if (episodeNumber === null || !Number.isInteger(episodeNumber) || episodeNumber < 1) continue;
      if (tmdbEpisodeId === null) continue; // never fabricate episode IDs

      // Stable deduplication key - guarantees no duplicate global numbers.
      const dedupKey = `${record.tmdbSeriesId ?? seriesId ?? 'unknown'}:${season.seasonNumber}:${episodeNumber}`;
      if (seenEpisodes.has(dedupKey)) continue;
      seenEpisodes.add(dedupKey);

      globalEpisodeNumber += 1; // exactly once per accepted standard episode

      episodes.push({
        // The public `episode` field IS the unified/global episode number
        // (that is what the frontend uses).
        episode: globalEpisodeNumber,
        globalEpisodeNumber,
        // TMDB's original numbering, preserved separately.
        seasonNumber: season.seasonNumber,
        episodeNumber,
        tmdbEpisodeId,
        // Existing frontend episode fields (Jikan-era names preserved); TMDB
        // never provides Japanese titles/MAL IDs/filler/recap - null, never
        // invented.
        malId: null,
        title: record.name ?? null,
        titleJapanese: null,
        overview: record.overview ?? null,
        aired: record.airDate ?? null,
        runtime: record.runtime ?? null,
        score: record.voteAverage ?? null,
        image: record.image ?? null,
        // Fields TMDB cannot provide stay null (never invented).
        filler: null,
        recap: null,
        episodeType: record.episodeType ?? null,
        source: 'tmdb',
      });
    }
  }

  return { episodes, totalEpisodes: episodes.length };
}
