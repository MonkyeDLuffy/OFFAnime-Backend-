/**
 * Jikan normalized type definitions (JSDoc only - no runtime code).
 *
 * The SECONDARY representation produced by `normalizeJikanAnime` - richer
 * MAL/Jikan metadata that the merge layer (anime.merge.js) uses to enrich the
 * canonical anime without touching AniList's primary identity.
 *
 * Identity rules (CRITICAL):
 *   - This shape contains ONLY `malId`. It deliberately has NO `id` and NO
 *     `anilistId` fields - Jikan's `mal_id` is a MAL ID and must never be
 *     reinterpreted as an AniList ID.
 *   - Full AniList <-> MAL resolution belongs to the identity layer (later
 *     phase); no guessed mappings here.
 *
 * Note: Jikan's adaptation-source field ("source", e.g. "Manga") is renamed to
 * `sourceMaterial` here, because `source` in this project means provider
 * provenance ({ anilist, jikan, tmdb }).
 *
 * @typedef {Object} JikanAnime
 * @property {number} malId
 * @property {{ default: string|null, english: string|null, japanese: string|null, synonyms: string[] }} title
 * @property {string|null} type            e.g. "TV".
 * @property {string|null} sourceMaterial  e.g. "Manga".
 * @property {number|null} episodes
 * @property {string|null} status          e.g. "Finished Airing".
 * @property {boolean} airing
 * @property {{ from: string|null, to: string|null }} aired
 * @property {string|null} duration        e.g. "24 min per ep".
 * @property {string|null} rating          e.g. "R - 17+ ...".
 * @property {number|null} score           MAL score (0-10 scale).
 * @property {number|null} scoredBy
 * @property {number|null} rank
 * @property {number|null} popularity
 * @property {number|null} members
 * @property {number|null} favorites
 * @property {string|null} synopsis        Cleaned plain text.
 * @property {string|null} background      Cleaned plain text.
 * @property {string|null} season          e.g. "spring".
 * @property {number|null} year
 * @property {string[]} genres
 * @property {string[]} themes
 * @property {string[]} demographics
 * @property {string[]} studios
 * @property {string[]} producers
 * @property {{ poster: string|null, large: string|null, small: string|null }} images
 * @property {{ youtubeId: string|null, url: string|null, embedUrl: string|null } | null} trailer
 * @property {{ anilist: boolean, jikan: boolean, tmdb: boolean }} source
 */

/**
 * A lighter Jikan search-result card (used inside normalized search pages).
 * Identity remains `malId` only - never anilistId unless a trusted mapping is
 * explicitly supplied (which never happens in this shape).
 *
 * @typedef {Object} JikanMediaCard
 * @property {number} malId
 * @property {string|null} title
 * @property {string|null} type
 * @property {number|null} episodes
 * @property {string|null} status
 * @property {string|null} season
 * @property {number|null} year
 * @property {{ poster: string|null }} images
 */

/**
 * Normalized Jikan search page.
 *
 * @typedef {Object} JikanSearchPage
 * @property {{ page: number|null, lastPage: number|null, hasNextPage: boolean, total: number|null, perPage: number|null }} pageInfo
 * @property {JikanMediaCard[]} results
 */

export {};
