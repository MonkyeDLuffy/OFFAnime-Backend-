/**
 * AniZip response normalizer/parser.
 *
 * RESPONSE SHAPE (verified live against https://api.ani.zip/mappings:
 * anilist_id=21 One Piece and anilist_id=20 Naruto):
 *
 *   {
 *     "titles":       { "<locale>": "<title>", ... },          // show titles
 *     "episodes":     {                                       // OBJECT, keyed by
 *       "1":  { ... }, "2": { ... }, ...,                     // episode NUMBER
 *       "S1": { ... }, "S2": { ... },                         // specials
 *       "O29": { ... }                                        // openings/other
 *     },
 *     "episodeCount":  1184,
 *     "specialCount":  51,
 *     "images":        [ { "coverType": "Poster", "url": "..." }, ... ],
 *     "mappings":      { "mal_id": 21, "anilist_id": 21, ... }
 *   }
 *
 *   One episode entry (all fields observed live):
 *   {
 *     "tvdbShowId": 81797, "tvdbId": 361887,
 *     "seasonNumber": 1, "episodeNumber": 1, "absoluteEpisodeNumber": 1,
 *     "title": { "ja": "...", "en": "...", "de": "...", "x-jat": "...", ... },
 *     "airDate": "1999-10-20", "airDateUtc": "1999-10-20T14:15:00Z",
 *     "runtime": 25, "length": 25,
 *     "overview": "...", "summary": "...",
 *     "image": "https://artworks.thetvdb.com/banners/.../....jpg",
 *     "episode": "1",                       // STRING episode number
 *     "anidbEid": 440, "airdate": "1999-10-20", "rating": "6.03"
 *   }
 *
 * THE critical numbering rule:
 *   - The episode number is the REAL number from the response: the NUMERIC
 *     object key (cross-checked against the entry's own episodeNumber/
 *     episode fields when present). It is NEVER derived from object iteration
 *     order, never renumbered, never fabricated.
 *   - Numbering GAPS in the provider data are preserved exactly (the frontend
 *     uses `episode` for GET /api/stream/resolve/:id?ep=N).
 *   - Prefixed keys ("S1", "O29" - clearly distinguished by the response, and
 *     consistent with the existing specials-excluded contract) are excluded
 *     from the main episode list; specialCount is preserved as metadata.
 *
 * Image URLs are used EXACTLY as returned by AniZip (validated absolute
 * http(s) URLs only) - never constructed from guessed paths. Missing
 * optional fields become null - never fabricated values.
 *
 * Failure classification: a payload without an `episodes` container (or a
 * non-object payload) is a typed ProviderError - never cached as valid
 * episode data. A VALID payload whose `episodes` container holds no normal
 * episodes normalizes to an honest empty list (the service treats that as
 * "cannot provide" and falls back).
 */

import { normalizeId } from '../identity/id-types.js';
import { ProviderError } from '../errors/index.js';

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

/** Absolute http(s) URL or null (image URLs are used as returned, or null). */
function httpUrlOrNull(value) {
  const s = str(value);
  return s !== null && /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/**
 * Resolve the REAL (absolute/global) episode number for one entry.
 *
 * LIVE-VERIFIED AniZip contract (anilist_id=11061 Hunter x Hunter 2011):
 * the `episodes` OBJECT key IS the ABSOLUTE episode number ("1".."148",
 * continuous across seasons), while each entry's `episodeNumber` is the
 * PER-SEASON TMDB number (key 62 -> episodeNumber 4, seasonNumber 2; key 148
 * -> episodeNumber 12, seasonNumber 3) and `episode` (string) mirrors the
 * absolute key. The key is therefore authoritative: it is NEVER renumbered,
 * never derived from iteration order, and gaps in it are preserved. The
 * per-season `episodeNumber` is metadata only - it must NEVER be used to
 * validate, filter, or replace the absolute number (that would silently
 * truncate every multi-cour anime after its first cour).
 * @param {string|null} key Container key (null for array entries).
 * @param {Record<string, unknown>} entry
 * @returns {number|null} Positive integer absolute episode number, or null to skip.
 */
function resolveEpisodeNumber(key, entry) {
  if (key !== null) {
    if (!/^\d+$/.test(key)) return null; // "S1"/"O29"/garbage - never a main episode
    const fromKey = Number(key);
    if (!Number.isInteger(fromKey) || fromKey < 1) return null;
    // Cross-check ONLY against the entry's own ABSOLUTE number (`episode`,
    // the string twin of the key in the live contract). The per-season
    // `episodeNumber` deliberately differs on multi-cour shows.
    const ownAbsolute = numberOrNull(entry.episode);
    if (ownAbsolute !== null && Number.isInteger(ownAbsolute) && ownAbsolute >= 1 && ownAbsolute !== fromKey) {
      return null; // inconsistent record - skip, never silently renumber
    }
    return fromKey;
  }
  // Array container: the entry's own ABSOLUTE number (`episode`, falling
  // back to `episodeNumber`) - never the position.
  const own = numberOrNull(entry.episode) ?? numberOrNull(entry.episodeNumber);
  return own !== null && Number.isInteger(own) && own >= 1 ? own : null;
}

/**
 * Normalize a RAW AniZip mappings payload into stable episode metadata.
 * Episode METADATA only - never stream/playback URLs.
 *
 * @param {unknown} raw RAW AniZip mappings payload.
 * @returns {{
 *   episodes: Array<object>,
 *   totalEpisodes: number,
 *   titles: Record<string, string> | null,
 *   images: Array<{ coverType: string|null, url: string }> | null,
 *   mappings: Record<string, unknown> | null,
 *   episodeCount: number|null,
 *   specialCount: number|null,
 * }}
 * @throws {ProviderError} when the payload is missing/malformed/has no
 *   episodes container (never cached as valid episode data).
 */
export function normalizeAnizipEpisodes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('AniZip mappings payload is missing or malformed', {
      provider: 'anizip',
    });
  }
  const container = raw.episodes;
  if (!container || typeof container !== 'object') {
    // A payload without an episodes container is unusable - never cached as a
    // valid (empty) episode list.
    throw new ProviderError('AniZip mappings payload is missing episodes', {
      provider: 'anizip',
    });
  }

  const entries = Array.isArray(container)
    ? container.map((entry) => ({ key: null, entry }))
    : Object.entries(container).map(([key, entry]) => ({ key, entry }));

  /** @type {Set<number>} */
  const seen = new Set();
  /** @type {Array<object>} */
  const episodes = [];

  for (const { key, entry } of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue; // ignore malformed

    const episodeNumber = resolveEpisodeNumber(key, entry);
    if (episodeNumber === null) continue; // specials/invalid - never renumbered in
    if (seen.has(episodeNumber)) continue; // duplicate episode records removed
    seen.add(episodeNumber);

    const hasTitleVariants =
      entry.title &&
      typeof entry.title === 'object' &&
      !Array.isArray(entry.title) &&
      Object.values(entry.title).some((v) => typeof v === 'string' && v.trim() !== '');
    const titleVariants = hasTitleVariants ? entry.title : null;

    episodes.push({
      // The REAL ABSOLUTE episode number (the object key; frontend-compatible
      // with ?ep=N streaming). Numbering gaps preserved - never renumbered.
      episode: episodeNumber,
      // AniZip's absolute numbering IS the global numbering; the field is
      // kept for contract compatibility with the TMDB-era episode shape.
      globalEpisodeNumber: episodeNumber,
      // AniZip's own numbering fields, preserved as provided. NOTE:
      // `episodeNumber` is the PER-SEASON number on multi-cour shows (key 62
      // -> episodeNumber 4, season 2) - it is metadata only, never the
      // public episode number. Absolute-numbering metadata is kept in
      // `absoluteEpisodeNumber` (falling back to the object key).
      episodeNumber: numberOrNull(entry.episodeNumber),
      seasonNumber: numberOrNull(entry.seasonNumber),
      absoluteEpisodeNumber: numberOrNull(entry.absoluteEpisodeNumber) ?? episodeNumber,
      // Real episode identifiers supplied by the response (never fabricated).
      anidbEid: normalizeId(entry.anidbEid),
      tvdbId: normalizeId(entry.tvdbId),
      // AniZip episode entries carry no per-episode MAL ID - null, never guessed.
      malId: null,
      // Titles: en (falling back to x-jat romaji) + ja, plus the full locale
      // map as provided. Missing variants stay null.
      title: str(titleVariants?.en) ?? str(titleVariants?.['x-jat']),
      titleJapanese: str(titleVariants?.ja),
      titleVariants,
      // Thumbnail/image: EXACTLY the URL AniZip returned (validated), or null.
      image: httpUrlOrNull(entry.image),
      // Overview/summary: prefer the TVDB overview, fall back to the AniDB
      // summary. Both are real provider fields.
      overview: str(entry.overview) ?? str(entry.summary),
      // Air dates as provided.
      aired: str(entry.airDate) ?? str(entry.airdate),
      airDateUtc: str(entry.airDateUtc),
      // Runtime (minutes): `runtime` is primary, `length` the AniDB twin.
      runtime: numberOrNull(entry.runtime) ?? numberOrNull(entry.length),
      // Rating/score (AniDB rating, 0-10 scale as a string) as a number.
      score: numberOrNull(entry.rating),
      // Fields AniZip does not provide stay null (never invented).
      filler: null,
      recap: null,
      episodeType: null,
      source: 'anizip',
    });
  }

  // Deterministic numeric ordering (the object key order is not guaranteed).
  episodes.sort((a, b) => a.episode - b.episode);

  const titles =
    raw.titles && typeof raw.titles === 'object' && !Array.isArray(raw.titles) ? raw.titles : null;
  const images = Array.isArray(raw.images)
    ? raw.images
        .filter((img) => img && typeof img === 'object' && !Array.isArray(img))
        .map((img) => ({ coverType: str(img.coverType), url: httpUrlOrNull(img.url) }))
        .filter((img) => img.url !== null)
    : null;
  const mappings =
    raw.mappings && typeof raw.mappings === 'object' && !Array.isArray(raw.mappings)
      ? raw.mappings
      : null;

  return {
    episodes,
    totalEpisodes: episodes.length,
    titles,
    images,
    mappings,
    episodeCount: numberOrNull(raw.episodeCount),
    specialCount: numberOrNull(raw.specialCount),
  };
}
