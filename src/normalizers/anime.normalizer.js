/**
 * Anime normalizer - converts raw provider payloads into ONE canonical anime
 * object so the rest of the application never depends on raw provider shapes.
 *
 * Canonical identity rules (ABSOLUTELY CRITICAL):
 *   - AniList's `id` and MAL's `idMal` are DIFFERENT namespaces.
 *   - `id === anilistId` always; `id` is NEVER populated from a MAL ID.
 *   - `malId` may be null. IDs are only taken from trusted provider payloads -
 *     never guessed in either direction.
 *
 * Defensive guarantees:
 *   - Missing optional fields normalize to null / empty arrays, never
 *     undefined, and never throw.
 *   - Only a malformed payload itself (missing/invalid) throws, and only with
 *     ProviderError - it is a provider anomaly, not an optional field issue.
 *
 * Enrichment-ready: later providers (Jikan/TMDB) merge into this shape via
 * mergeAnimeSources without overwriting known IDs or corrupting fields.
 */

import { createAnimeIdentity, normalizeId } from '../identity/id-types.js';
import { cleanDescription } from '../utils/html.js';
import { ProviderError } from '../errors/index.js';

/** @typedef {import('./anime.types.js').CanonicalAnime} CanonicalAnime */

// --- small defensive coercion helpers ---------------------------------------

/** String or null (empty/whitespace-only strings count as missing). */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Positive integer or null. */
function positiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Finite number or null (scores can legitimately be 0). */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Integer or null (used for counts that can be large, e.g. popularity). */
function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Boolean or null (missing/absent stays null - never fabricated as false). */
function boolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/** Array of non-empty strings, or [] for anything else. */
function strArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim() !== '') : [];
}

/**
 * Normalize an AniList FuzzyDate ({ year, month, day }) into an honest,
 * non-fabricated string: "YYYY-MM-DD" (full), "YYYY-MM", "YYYY", or null.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeFuzzyDate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const year = positiveInt(raw.year);
  if (year === null) return null;
  const month = positiveInt(raw.month);
  if (month === null) return String(year);
  const day = positiveInt(raw.day);
  if (day === null) return `${year}-${String(month).padStart(2, '0')}`;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- title handling ----------------------------------------------------------

/**
 * Normalize AniList title variants, preserving all of them.
 * When `userPreferred` is missing, fall back using existing AniList fields
 * (english -> romaji -> native). No titles are invented.
 * @param {unknown} raw
 * @returns {{ romaji: string|null, english: string|null, native: string|null, userPreferred: string|null }}
 */
export function normalizeAnilistTitle(raw) {
  const empty = { romaji: null, english: null, native: null, userPreferred: null };
  if (!raw || typeof raw !== 'object') return empty;

  const title = {
    romaji: str(raw.romaji),
    english: str(raw.english),
    native: str(raw.native),
    userPreferred: str(raw.userPreferred),
  };
  if (title.userPreferred === null) {
    title.userPreferred = title.english ?? title.romaji ?? title.native;
  }
  return title;
}

/**
 * Pick a single display title from a raw title object (fallback chain:
 * userPreferred -> english -> romaji -> native -> null). Used for list cards.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function displayTitleFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return str(raw.userPreferred) ?? str(raw.english) ?? str(raw.romaji) ?? str(raw.native);
}

/**
 * Normalize the three AniList title variants into explicit, null-safe fields.
 * Missing/empty variants become null - never undefined, never "null" strings.
 * @param {unknown} raw
 * @returns {{ english: string|null, romaji: string|null, native: string|null }}
 */
function titleVariantsFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return { english: null, romaji: null, native: null };
  return {
    english: str(raw.english),
    romaji: str(raw.romaji),
    native: str(raw.native),
  };
}

/**
 * Pick a display title preferring the official English title (fallback chain:
 * english -> romaji -> native -> null). Used for list-card `title` fields.
 * @param {{ english: string|null, romaji: string|null, native: string|null }} variants
 * @returns {string | null}
 */
function displayTitleEnglishFirst(variants) {
  return variants.english ?? variants.romaji ?? variants.native;
}

// --- card trailer handling (AniList-native) -----------------------------------

/**
 * Sites whose trailer URL format is known and reliable. AniList's `trailer.site`
 * is matched case-insensitively; anything outside this map keeps its real
 * `id`/`site` with `url: null` - URLs are never guessed.
 */
const TRAILER_URL_BUILDERS = {
  youtube: (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
  dailymotion: (id) => `https://www.dailymotion.com/video/${encodeURIComponent(id)}`,
};

/**
 * Normalize an AniList card's native `trailer { id site }` entry.
 *
 * Rules (never fabricate anything):
 *   - Missing/malformed entry, missing `id` or `site`, or an id containing
 *     whitespace/control characters (never a valid video key) -> null.
 *   - `site` is normalized to lowercase (AniList uses "youtube"); the URL is
 *     built ONLY for known sites (YouTube watch URL, Dailymotion video URL).
 *   - Unknown sites keep their real id/site/key with `url: null`.
 * @param {unknown} raw
 * @returns {{ id: string, site: string, key: string, url: string|null } | null}
 */
export function normalizeAnilistCardTrailer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  const site = str(raw.site);
  if (id === null || site === null) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(id)) return null; // whitespace/control chars: invalid video key
  const normalizedSite = site.toLowerCase();
  const build = TRAILER_URL_BUILDERS[normalizedSite];
  return {
    id,
    site: normalizedSite,
    key: id,
    url: build ? build(id) : null,
  };
}

// --- image handling ----------------------------------------------------------

/**
 * Normalize AniList image data into the stable { poster, cover, banner } shape.
 * - poster: best available cover art (extraLarge -> large -> medium).
 * - cover:  standard cover art (large -> medium).
 * - banner: only AniList's genuine bannerImage; never a disguised poster.
 * @param {unknown} raw
 * @returns {{ poster: string|null, cover: string|null, banner: string|null }}
 */
export function normalizeAnilistImages(raw) {
  const coverImage = raw && typeof raw === 'object' ? raw.coverImage : null;
  return {
    poster: str(coverImage?.extraLarge) ?? str(coverImage?.large) ?? str(coverImage?.medium),
    cover: str(coverImage?.large) ?? str(coverImage?.medium),
    banner: str(raw?.bannerImage),
  };
}

// --- relation / list-card handling -------------------------------------------

/**
 * Normalize a related-anime node into a minimal relation entry.
 * Returns null for unusable nodes (missing id) - never fabricates.
 * @param {unknown} node
 * @returns {{ relationType: string|null, id: number, anilistId: number, malId: number|null, title: string|null, type: string|null, format: string|null, images: { poster: string|null } } | null}
 */
export function normalizeAnilistRelation(node) {
  const anilistId = normalizeId(node?.id);
  if (anilistId === null) return null;
  return {
    relationType: str(node?.relationType),
    id: anilistId,
    anilistId,
    malId: normalizeId(node?.idMal),
    title: displayTitleFromRaw(node?.title),
    type: str(node?.type),
    format: str(node?.format),
    images: { poster: str(node?.coverImage?.large) ?? str(node?.coverImage?.medium) },
  };
}

/**
 * Normalize a minimal anime card (search/seasonal/home/recommendation results).
 *
 * Title contract (backward-compatible):
 *   - `title`: display string preferring the English title
 *     (english -> romaji -> native), or null when no variant exists.
 *   - `titleEnglish` / `titleRomaji` / `titleNative`: the individual AniList
 *     variants, each null when unavailable.
 *
 * Trailer contract: `trailer` carries AniList's NATIVE trailer metadata
 * (requested in the SAME GraphQL request - no extra API call, no TMDB):
 * `{ id, site, key, url }` with the URL built only for known sites
 * (YouTube/Dailymotion), or null when AniList has no usable trailer.
 * @param {unknown} node
 * @returns {{ id: number, anilistId: number, malId: number|null, title: string|null, titleEnglish: string|null, titleRomaji: string|null, titleNative: string|null, type: string|null, format: string|null, status: string|null, episodes: number|null, season: string|null, seasonYear: number|null, images: { poster: string|null, banner: string|null }, trailer: { id: string, site: string, key: string, url: string|null } | null} | null}
 */
export function normalizeAnilistMediaCard(node) {
  const anilistId = normalizeId(node?.id);
  if (anilistId === null) return null;
  const titleVariants = titleVariantsFromRaw(node?.title);
  return {
    id: anilistId,
    anilistId,
    malId: normalizeId(node?.idMal),
    title: displayTitleEnglishFirst(titleVariants),
    titleEnglish: titleVariants.english,
    titleRomaji: titleVariants.romaji,
    titleNative: titleVariants.native,
    type: str(node?.type),
    format: str(node?.format),
    status: str(node?.status),
    episodes: positiveInt(node?.episodes),
    season: str(node?.season),
    seasonYear: positiveInt(node?.seasonYear),
    images: {
      poster: str(node?.coverImage?.large) ?? str(node?.coverImage?.medium),
      banner: str(node?.bannerImage),
    },
    trailer: normalizeAnilistCardTrailer(node?.trailer),
  };
}

/**
 * Normalize an AniList Page payload (search/seasonal) into a stable page shape.
 * @param {unknown} raw
 * @returns {{ pageInfo: { total: number|null, currentPage: number|null, lastPage: number|null, hasNextPage: boolean, perPage: number|null }, results: Array<object> }}
 */
export function normalizeAnilistPage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('AniList page payload is missing or malformed');
  }
  const pageInfo = raw.pageInfo && typeof raw.pageInfo === 'object' ? raw.pageInfo : {};
  const media = Array.isArray(raw.media) ? raw.media : [];
  return {
    pageInfo: {
      total: intOrNull(pageInfo.total),
      currentPage: intOrNull(pageInfo.currentPage),
      lastPage: intOrNull(pageInfo.lastPage),
      hasNextPage: Boolean(pageInfo.hasNextPage),
      perPage: intOrNull(pageInfo.perPage),
    },
    results: media.map((node) => normalizeAnilistMediaCard(node)).filter(Boolean),
  };
}

/**
 * Normalize an AniList recommendations payload (Media.recommendations).
 * @param {unknown} raw
 * @returns {Array<object & { rating: number|null }>}
 */
export function normalizeAnilistRecommendations(raw) {
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  return nodes
    .map((node) => {
      const card = normalizeAnilistMediaCard(node?.mediaRecommendation);
      if (card === null) return null;
      return { ...card, rating: numberOrNull(node?.rating) };
    })
    .filter(Boolean);
}

/**
 * Normalize an AniList airing-schedule payload (Page.airingSchedules).
 * @param {unknown} raw
 * @returns {Array<{ airingAt: number|null, episode: number|null, anime: { id: number, anilistId: number, malId: number|null, title: string|null } | null }>}
 */
export function normalizeAnilistAiringSchedule(raw) {
  const schedules = Array.isArray(raw?.airingSchedules) ? raw.airingSchedules : [];
  return schedules
    .map((node) => {
      const airingAt = intOrNull(node?.airingAt);
      const media = node?.media;
      const anilistId = normalizeId(media?.id);
      if (airingAt === null || anilistId === null) return null;
      return {
        airingAt,
        episode: positiveInt(node?.episode),
        anime: {
          id: anilistId,
          anilistId,
          malId: normalizeId(media?.idMal),
          title: displayTitleFromRaw(media?.title),
        },
      };
    })
    .filter(Boolean);
}

// --- canonical model ---------------------------------------------------------

/**
 * Build a canonical anime skeleton with a correct identity and empty content
 * fields. Pure; later mappers/enrichment fill in the content fields.
 * @param {{ anilistId?: unknown, malId?: unknown }} ids
 * @returns {CanonicalAnime}
 */
export function createBaseAnime(ids) {
  const identity = createAnimeIdentity(ids);
  return {
    ...identity,
    title: { romaji: null, english: null, native: null, userPreferred: null },
    description: null,
    images: { poster: null, cover: null, banner: null },
    type: null,
    format: null,
    status: null,
    episodes: null,
    duration: null,
    season: null,
    seasonYear: null,
    genres: [],
    studios: [],
    synonyms: [],
    startDate: null,
    endDate: null,
    averageScore: null,
    popularity: null,
    relations: [],
    source: { anilist: false, jikan: false, tmdb: false },
    // Namespaced enrichment from secondary providers (filled by merge layers).
    enrichment: { jikan: null },
  };
}

/**
 * Normalize a raw AniList `Media` payload into the canonical anime object.
 *
 * @param {unknown} raw Raw AniList Media (from AnilistProvider).
 * @returns {CanonicalAnime}
 * @throws {ProviderError} when the payload itself is missing/malformed
 *   (missing id). Optional fields never cause a throw.
 */
export function normalizeAnilistAnime(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('AniList media payload is missing or malformed');
  }

  const anilistId = normalizeId(raw.id);
  if (anilistId === null) {
    throw new ProviderError('AniList media payload is missing a valid id');
  }
  // Identity is built exclusively through the identity layer: id mirrors the
  // AniList id; idMal maps to malId. A MAL ID NEVER becomes an anilistId.
  const identity = createAnimeIdentity({ anilistId, malId: raw.idMal });

  return {
    ...identity,
    title: normalizeAnilistTitle(raw.title),
    description: raw.description == null ? null : cleanDescription(raw.description),
    images: normalizeAnilistImages(raw),
    type: str(raw.type),
    format: str(raw.format),
    status: str(raw.status),
    episodes: positiveInt(raw.episodes),
    duration: positiveInt(raw.duration),
    season: str(raw.season),
    seasonYear: positiveInt(raw.seasonYear),
    genres: strArray(raw.genres),
    studios: strArray(Array.isArray(raw.studios?.nodes) ? raw.studios.nodes.map((n) => n?.name) : null),
    synonyms: strArray(raw.synonyms),
    startDate: normalizeFuzzyDate(raw.startDate),
    endDate: normalizeFuzzyDate(raw.endDate),
    averageScore: numberOrNull(raw.averageScore),
    popularity: intOrNull(raw.popularity),
    relations: Array.isArray(raw.relations?.nodes)
      ? raw.relations.nodes.map((node) => normalizeAnilistRelation(node)).filter(Boolean)
      : [],
    source: { anilist: true, jikan: false, tmdb: false },
    // Namespaced enrichment from secondary providers (filled by merge layers).
    enrichment: { jikan: null },
  };
}

// --- Jikan normalizer (secondary metadata/enrichment source) ----------------

/**
 * Normalize a Jikan name-list field ({ mal_id, name }[]) into string names.
 * @param {unknown} value
 * @returns {string[]}
 */
function jikanNameList(value) {
  return Array.isArray(value)
    ? value.map((entry) => str(entry?.name)).filter((name) => name !== null)
    : [];
}

/**
 * Normalize Jikan image variants into a stable { poster, large, small } shape.
 * - poster: best large cover art (webp large -> jpg large -> plain image_url).
 * - large:  standard large art (jpg large -> webp large).
 * - small:  small art (jpg small -> webp small).
 * No banners are invented - TMDB handles banner enrichment later.
 * @param {unknown} raw
 * @returns {{ poster: string|null, large: string|null, small: string|null }}
 */
export function normalizeJikanImages(raw) {
  const jpg = raw && typeof raw === 'object' ? raw.jpg : null;
  const webp = raw && typeof raw === 'object' ? raw.webp : null;
  return {
    poster: str(webp?.large_image_url) ?? str(jpg?.large_image_url) ?? str(jpg?.image_url) ?? str(webp?.image_url),
    large: str(jpg?.large_image_url) ?? str(webp?.large_image_url),
    small: str(jpg?.small_image_url) ?? str(webp?.small_image_url),
  };
}

/**
 * Normalize Jikan trailer info. Returns null when no trailer data exists -
 * YouTube URLs are never fabricated.
 * @param {unknown} raw
 * @returns {{ youtubeId: string|null, url: string|null, embedUrl: string|null } | null}
 */
export function normalizeJikanTrailer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const trailer = {
    youtubeId: str(raw.youtube_id),
    url: str(raw.url),
    embedUrl: str(raw.embed_url),
  };
  if (trailer.youtubeId === null && trailer.url === null && trailer.embedUrl === null) return null;
  return trailer;
}

/**
 * Normalize Jikan aired dates into { from, to } (ISO strings as provided, or
 * null when missing). Partial dates stay honest - no fabrication.
 * @param {unknown} raw
 * @returns {{ from: string|null, to: string|null }}
 */
export function normalizeJikanAired(raw) {
  if (!raw || typeof raw !== 'object') return { from: null, to: null };
  return { from: str(raw.from), to: str(raw.to) };
}

/**
 * Normalize a raw Jikan anime payload (from JikanProvider) into a stable
 * SECONDARY representation - richer MAL metadata for enrichment.
 *
 * Identity rules (CRITICAL):
 *   - Produces ONLY `malId` (from Jikan's `mal_id`). There is NO `id` and NO
 *     `anilistId` field in this shape - a MAL ID is never reinterpreted as an
 *     AniList ID, and no mapping is guessed from titles/URLs.
 *   - Full AniList <-> MAL resolution is the identity layer's job (later phase).
 *
 * Defensive guarantees (same as the AniList normalizer): missing optional
 * fields become null/[] (never undefined, never a throw); only a malformed
 * payload lacking a valid MAL identity throws (ProviderError).
 *
 * @param {unknown} raw Raw Jikan anime object (JikanProvider.getAnimeByMalId).
 * @returns {import('./jikan.types.js').JikanAnime}
 * @throws {ProviderError} when the payload is missing/has no valid mal_id.
 */
export function normalizeJikanAnime(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('Jikan anime payload is missing or malformed');
  }
  const malId = normalizeId(raw.mal_id);
  if (malId === null) {
    throw new ProviderError('Jikan anime payload is missing a valid mal_id');
  }

  return {
    malId,
    title: {
      default: str(raw.title),
      english: str(raw.title_english),
      japanese: str(raw.title_japanese),
      synonyms: strArray(raw.title_synonyms),
    },
    type: str(raw.type),
    sourceMaterial: str(raw.source),
    episodes: positiveInt(raw.episodes),
    status: str(raw.status),
    airing: raw.airing === true,
    aired: normalizeJikanAired(raw.aired),
    duration: str(raw.duration),
    rating: str(raw.rating),
    score: numberOrNull(raw.score),
    scoredBy: intOrNull(raw.scored_by),
    rank: intOrNull(raw.rank),
    popularity: intOrNull(raw.popularity),
    members: intOrNull(raw.members),
    favorites: intOrNull(raw.favorites),
    synopsis: raw.synopsis == null ? null : cleanDescription(raw.synopsis),
    background: raw.background == null ? null : cleanDescription(raw.background),
    season: str(raw.season),
    year: positiveInt(raw.year),
    genres: jikanNameList(raw.genres),
    themes: jikanNameList(raw.themes),
    demographics: jikanNameList(raw.demographics),
    studios: jikanNameList(raw.studios),
    producers: jikanNameList(raw.producers),
    images: normalizeJikanImages(raw.images),
    trailer: normalizeJikanTrailer(raw.trailer),
    source: { anilist: false, jikan: true, tmdb: false },
  };
}

/**
 * Normalize a lighter Jikan search-result card. Identity remains `malId` only.
 * @param {unknown} node
 * @returns {import('./jikan.types.js').JikanMediaCard | null}
 */
export function normalizeJikanMediaCard(node) {
  const malId = normalizeId(node?.mal_id);
  if (malId === null) return null;
  return {
    malId,
    title: displayTitleFromRaw({
      userPreferred: node?.title,
      english: node?.title_english,
      native: node?.title_japanese,
    }),
    type: str(node?.type),
    episodes: positiveInt(node?.episodes),
    status: str(node?.status),
    season: str(node?.season),
    year: positiveInt(node?.year),
    images: {
      poster: str(node?.images?.jpg?.large_image_url) ??
        str(node?.images?.webp?.large_image_url) ??
        str(node?.images?.jpg?.image_url) ??
        str(node?.images?.webp?.image_url),
    },
  };
}

/**
 * Normalize a raw Jikan search payload ({ pagination, data }) into a stable
 * page shape consistent with the AniList page normalizer.
 * @param {unknown} raw
 * @returns {import('./jikan.types.js').JikanSearchPage}
 * @throws {ProviderError} when the payload is missing/malformed.
 */
export function normalizeJikanPage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('Jikan page payload is missing or malformed');
  }
  const data = Array.isArray(raw.data) ? raw.data : null;
  if (data === null) {
    // A payload without a data array is malformed - the service must not cache
    // it as a valid empty search result.
    throw new ProviderError('Jikan page payload is missing data');
  }
  const pagination = raw.pagination && typeof raw.pagination === 'object' ? raw.pagination : {};
  const items = pagination.items && typeof pagination.items === 'object' ? pagination.items : {};
  return {
    pageInfo: {
      page: intOrNull(pagination.current_page),
      lastPage: intOrNull(pagination.last_visible_page),
      hasNextPage: pagination.has_next_page === true,
      total: intOrNull(items.total),
      perPage: intOrNull(items.per_page),
    },
    results: data.map((node) => normalizeJikanMediaCard(node)).filter(Boolean),
  };
}

/**
 * Normalize a raw Jikan episode-list payload ({ pagination, data }) into a
 * stable episode-metadata shape. Episode METADATA only - never stream URLs.
 *
 * The episode number comes from Jikan's own `mal_id` field (Jikan's episode
 * identity) - never derived from the list position, never fabricated.
 * Entries without a title or id are dropped (never fabricated); fields Jikan
 * does not provide stay null (filler/recap are null when absent, never
 * fabricated as false).
 *
 * @param {unknown} raw
 * @param {{ page?: number }} [options]
 * @returns {{ pageInfo: { page: number|null, lastPage: number|null, hasNextPage: boolean, total: number|null, perPage: number }, episodes: Array<{ episode: number|null, malId: number|null, title: string|null, titleJapanese: string|null, aired: string|null, score: number|null, filler: boolean|null, recap: boolean|null }> }}
 * @throws {ProviderError} when the payload is missing/has no data array.
 */
export function normalizeJikanEpisodes(raw, { page = 1 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('Jikan episodes payload is missing or malformed');
  }
  const data = Array.isArray(raw.data) ? raw.data : null;
  if (data === null) {
    // A payload without a data array is malformed - never cache as valid empty.
    throw new ProviderError('Jikan episodes payload is missing data');
  }
  const pagination = raw.pagination && typeof raw.pagination === 'object' ? raw.pagination : {};
  const items = pagination.items && typeof pagination.items === 'object' ? pagination.items : {};
  const perPage = intOrNull(items.per_page) ?? 100;

  return {
    pageInfo: {
      page: intOrNull(pagination.current_page) ?? page,
      lastPage: intOrNull(pagination.last_visible_page),
      hasNextPage: pagination.has_next_page === true,
      total: intOrNull(items.total),
      perPage,
    },
    episodes: data
      .map((entry) => ({
        episode: normalizeId(entry?.mal_id),
        malId: normalizeId(entry?.mal_id),
        title: str(entry?.title),
        titleJapanese: str(entry?.title_japanese),
        aired: str(entry?.aired),
        score: numberOrNull(entry?.score),
        filler: boolOrNull(entry?.filler),
        recap: boolOrNull(entry?.recap),
      }))
      .filter((entry) => entry.title !== null || entry.episode !== null),
  };
}
