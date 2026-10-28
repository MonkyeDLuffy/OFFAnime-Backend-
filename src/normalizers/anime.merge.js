/**
 * Anime merge layer - enriches a canonical anime with normalized secondary
 * provider data (currently Jikan) under EXPLICIT, documented precedence rules.
 *
 * PRECEDENCE RULES (AniList is the primary identity/source layer):
 *
 *   AniList ALWAYS wins (never overwritten by Jikan):
 *     - id, anilistId          (identity is untouched)
 *     - title.userPreferred    (AniList's fallback chain)
 *     - title.romaji
 *     - description, poster, cover
 *     - banner                 (NEVER filled from Jikan - no fake banners;
 *                               TMDB handles banner enrichment later)
 *     - format, status, episodes
 *     - season/seasonYear      (filled only when AniList has none)
 *     - genres, studios, synonyms (AniList's list wins unless empty)
 *     - relations, startDate, endDate
 *     - averageScore, popularity  (different scales - AniList 0-100 vs MAL
 *                               0-10 - so Jikan's score is NOT merged into
 *                               canonical scores; it lives in enrichment)
 *
 *   Jikan may FILL (only when the canonical value is null/empty):
 *     - malId                  (Jikan is MAL-keyed, so its malId is trusted)
 *     - title.english, title.native
 *     - description, poster, cover
 *     - format, status, episodes, season/seasonYear
 *     - genres, studios, synonyms
 *
 *   Jikan-only enrichment (attached namespaced, never flattened into primary
 *   fields - so nothing can silently overwrite AniList data):
 *     - enrichment.jikan = the full normalized Jikan object (background,
 *       trailer, rating, rank, members, favorites, themes, demographics,
 *       producers, aired, sourceMaterial, score, etc.)
 *
 * Pure function: returns a NEW canonical object, never mutates inputs.
 * No guessed IDs, no fabricated values, no "random source wins" system.
 */

import { ValidationError } from '../errors/index.js';

/** @typedef {import('./anime.types.js').CanonicalAnime} CanonicalAnime */
/** @typedef {import('./jikan.types.js').JikanAnime} JikanAnime */

/**
 * Validate that the input is a real canonical anime (has an AniList identity).
 * @param {unknown} value
 * @returns {boolean}
 */
function isCanonicalAnime(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Number.isInteger(value.anilistId) &&
      value.anilistId > 0 &&
      value.title &&
      typeof value.title === 'object' &&
      value.images &&
      typeof value.images === 'object',
  );
}

/**
 * Validate that the input is normalized Jikan data (has a trusted malId).
 * @param {unknown} value
 * @returns {boolean}
 */
function isJikanNormalized(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Number.isInteger(value.malId) &&
      value.malId > 0 &&
      value.title &&
      typeof value.title === 'object' &&
      value.images &&
      typeof value.images === 'object' &&
      value.source?.jikan === true,
  );
}

/**
 * Fill a scalar only when the current value is null/undefined (never
 * overwrite). Returns the current value otherwise.
 * @template T
 * @param {T | null | undefined} current
 * @param {T | null | undefined} incoming
 * @returns {T | null | undefined}
 */
function fillScalar(current, incoming) {
  return current === null || current === undefined ? (incoming ?? null) : current;
}

/**
 * Fill an array only when the current array is empty (never overwrite).
 * @template T
 * @param {T[]} current
 * @param {T[]} incoming
 * @returns {T[]}
 */
function fillArray(current, incoming) {
  return Array.isArray(current) && current.length > 0 ? current : Array.isArray(incoming) ? incoming : [];
}

/**
 * Enrich a canonical anime with normalized Jikan data.
 *
 * @param {CanonicalAnime} canonical
 * @param {JikanAnime} jikan
 * @returns {CanonicalAnime}
 * @throws {ValidationError} for unusable inputs (never silently coerced).
 */
export function mergeJikanIntoCanonical(canonical, jikan) {
  if (!isCanonicalAnime(canonical)) {
    throw new ValidationError(
      'mergeJikanIntoCanonical requires a canonical anime with a valid AniList identity',
    );
  }
  if (!isJikanNormalized(jikan)) {
    throw new ValidationError('mergeJikanIntoCanonical requires normalized Jikan data with a valid malId');
  }

  return {
    // AniList identity ALWAYS wins - untouched by Jikan.
    id: canonical.id,
    anilistId: canonical.anilistId,
    // Jikan fills malId only when the canonical object doesn't know it yet.
    malId: canonical.malId ?? jikan.malId,

    // AniList is primary for titles; Jikan fills only missing variants.
    title: {
      romaji: canonical.title.romaji,
      english: canonical.title.english ?? jikan.title.english,
      native: canonical.title.native ?? jikan.title.japanese,
      userPreferred: canonical.title.userPreferred, // never overwritten
    },

    description: canonical.description ?? jikan.synopsis,

    // AniList primary for images; banner is NEVER filled from Jikan.
    images: {
      poster: canonical.images.poster ?? jikan.images.poster,
      cover: canonical.images.cover ?? jikan.images.poster,
      banner: canonical.images.banner,
    },

    // AniList primary; Jikan fills only null fields.
    type: fillScalar(canonical.type, jikan.type),
    format: fillScalar(canonical.format, jikan.type),
    status: fillScalar(canonical.status, jikan.status),
    episodes: canonical.episodes ?? jikan.episodes,
    // Duration is NOT filled from Jikan's formatted string; it lives in
    // enrichment (canonical duration is numeric minutes from AniList).
    duration: canonical.duration,
    season: fillScalar(canonical.season, jikan.season),
    seasonYear: canonical.seasonYear ?? jikan.year,

    // AniList's lists win unless empty.
    genres: fillArray(canonical.genres, jikan.genres),
    studios: fillArray(canonical.studios, jikan.studios),
    synonyms: fillArray(canonical.synonyms, jikan.title.synonyms),

    // Dates remain AniList's (Jikan's full ISO strings live in enrichment).
    startDate: canonical.startDate,
    endDate: canonical.endDate,

    // Scores/popularity are AniList-scale; Jikan's values live in enrichment.
    averageScore: canonical.averageScore,
    popularity: canonical.popularity,

    // Relations are AniList-only.
    relations: canonical.relations,

    // Provenance: record that Jikan enriched this object.
    source: {
      anilist: canonical.source?.anilist ?? false,
      jikan: true,
      tmdb: canonical.source?.tmdb ?? false,
    },

    // Jikan-only enrichment, namespaced so nothing silently overwrites
    // AniList's primary fields. Any other enrichment (e.g. tmdb) is preserved.
    enrichment: { ...canonical.enrichment, jikan },
  };
}

/**
 * Enrich a canonical anime with TMDB visuals.
 *
 * PRECEDENCE RULES (TMDB enriches visuals; it NEVER establishes identity):
 *
 *   TMDB must NEVER overwrite:
 *     - id, anilistId, malId   (identity untouched - TMDB IDs are a completely
 *                               separate namespace)
 *     - any title variant, description, format, status, episodes, duration,
 *       season/seasonYear, genres, studios, relations, dates,
 *       AniList averageScore/popularity
 *     - Jikan enrichment (enrichment.jikan preserved as-is)
 *
 *   Banner precedence (explicit):
 *     AniList genuine bannerImage  -> always wins
 *     TMDB backdrop/banner         -> fills only when AniList banner is null
 *     null                         -> otherwise
 *     A poster is NEVER turned into a banner/backdrop.
 *
 *   TMDB identity storage: the tmdbId lives ONLY in the namespaced
 *   enrichment.tmdb ({ tmdbId, mediaType }) - never in id/anilistId/malId.
 *
 * Pure function: returns a NEW canonical object, never mutates inputs.
 * For an unresolved visual result, an unchanged copy is returned (existing
 * AniList/Jikan data remains fully intact).
 *
 * @param {CanonicalAnime} canonical
 * @param {import('./tmdb.types.js').TmdbVisualResult | null | undefined} tmdbVisual
 * @returns {CanonicalAnime}
 * @throws {ValidationError} for an unusable canonical input.
 */
export function mergeTmdbIntoCanonical(canonical, tmdbVisual) {
  if (!isCanonicalAnime(canonical)) {
    throw new ValidationError(
      'mergeTmdbIntoCanonical requires a canonical anime with a valid AniList identity',
    );
  }

  // Unresolved/no-match: no TMDB visual is attached - never forced.
  if (!tmdbVisual || tmdbVisual.resolved !== true) {
    return { ...canonical };
  }

  if (!Number.isInteger(tmdbVisual.tmdbId) || tmdbVisual.tmdbId <= 0) {
    throw new ValidationError('mergeTmdbIntoCanonical requires a valid tmdbId on a resolved visual result');
  }

  return {
    ...canonical,
    // Banner: AniList wins; TMDB fills only when AniList has none.
    images: {
      ...canonical.images,
      banner: canonical.images.banner ?? tmdbVisual.images?.banner ?? null,
    },
    source: { ...canonical.source, tmdb: true },
    // TMDB-only namespace: identity stays completely isolated.
    enrichment: {
      ...canonical.enrichment,
      tmdb: { tmdbId: tmdbVisual.tmdbId, mediaType: tmdbVisual.mediaType ?? null },
    },
  };
}
