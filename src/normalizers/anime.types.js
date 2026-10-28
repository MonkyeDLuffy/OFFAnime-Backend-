/**
 * Canonical anime type definitions (JSDoc only - no runtime code).
 *
 * The single internal anime shape produced by the normalizers and consumed by
 * services/cache. The frontend never sees raw provider payloads.
 *
 * Identity rules (CRITICAL):
 *   - `id` mirrors `anilistId` (AniList is the primary identity).
 *   - `malId` is MyAnimeList's ID, a DIFFERENT namespace; may be null.
 *   - A MAL ID is never stored as an anilistId, and vice versa.
 *
 * `source` tracks which providers have enriched this object so later phases
 * (Jikan/TMDB merge) know what has already been applied. `enrichment` holds
 * namespaced secondary-provider metadata (e.g. `enrichment.jikan`) so richer
 * details never conflict with AniList's primary fields.
 *
 * @typedef {Object} CanonicalAnime
 * @property {number} id                    Primary id (mirrors anilistId).
 * @property {number} anilistId             AniList ID.
 * @property {number|null} malId            MyAnimeList ID, or null if unknown.
 * @property {{ romaji: string|null, english: string|null, native: string|null, userPreferred: string|null }} title
 * @property {string|null} description      Cleaned plain-text description.
 * @property {{ poster: string|null, cover: string|null, banner: string|null }} images
 * @property {string|null} type             Media type (e.g. "TV").
 * @property {string|null} format           Media format (e.g. "TV", "MOVIE").
 * @property {string|null} status           e.g. "FINISHED", "RELEASING".
 * @property {number|null} episodes
 * @property {number|null} duration         Minutes per episode.
 * @property {string|null} season           e.g. "SPRING".
 * @property {number|null} seasonYear
 * @property {string[]} genres
 * @property {string[]} studios             Studio names (main studios).
 * @property {string[]} synonyms
 * @property {string|null} startDate        "YYYY-MM-DD" (or partial) or null.
 * @property {string|null} endDate          "YYYY-MM-DD" (or partial) or null.
 * @property {number|null} averageScore     AniList 0-100 score.
 * @property {number|null} popularity
 * @property {Array<{ relationType: string|null, id: number, anilistId: number, malId: number|null, title: string|null, type: string|null, format: string|null, images: { poster: string|null } }>} relations
 * @property {Array<{ id: number, relationType: string|null, relationLabel: string, type: string|null, format: string|null, title: string|null, titleEnglish: string|null, titleRomaji: string|null, titleNative: string|null, images: { poster: string|null, banner: string|null }, episodes: number|null, status: string|null, season: string|null, seasonYear: number|null, averageScore: number|null, genres: string[] }>} relatedAnime
 * @property {Array<{ id: number, title: string|null, titleEnglish: string|null, titleRomaji: string|null, titleNative: string|null, images: { poster: string|null, banner: string|null }, format: string|null, episodes: number|null, status: string|null, seasonYear: number|null, averageScore: number|null, genres: string[], recommendationRating: number|null }>} recommendations
 * @property {{ anilist: boolean, jikan: boolean, tmdb: boolean }} source
 * @property {{ jikan: import('./jikan.types.js').JikanAnime | null, tmdb: { tmdbId: number, mediaType: 'tv'|'movie'|null } | null }} enrichment
 */

export {};
