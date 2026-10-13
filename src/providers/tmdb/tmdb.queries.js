/**
 * TMDB REST endpoint + image URL helpers.
 *
 * TMDB (The Movie Database) API v3/v4 is REST-based. These helpers build only
 * the endpoints the visual-enrichment flow actually needs, and centralize TMDB
 * image URL construction (built ONLY from actual TMDB paths - never fabricated,
 * never a made-up domain).
 *
 * All API paths are relative to the provider's baseUrl (.../3).
 */

/**
 * Build an image URL from an actual TMDB image path (e.g. "/abc.jpg"),
 * following TMDB's documented scheme. Returns null for missing paths - URLs
 * are never generated for null paths, and posters are never turned into
 * fake backdrops.
 * @param {string | null | undefined} path
 * @param {'original' | 'w500' | 'w780'} [size='original']
 * @returns {string | null}
 */
export function tmdbImageUrl(path, size = 'original') {
  if (!path || typeof path !== 'string') return null;
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `https://image.tmdb.org/t/p/${size}${clean}`;
}

/**
 * TV search endpoint.
 * @param {{ query: string, page?: number }} options
 * @returns {string}
 */
export function tvSearchPath({ query, page } = {}) {
  const params = new URLSearchParams();
  params.set('query', query);
  if (Number.isInteger(page) && page > 0) params.set('page', String(page));
  return `/search/tv?${params.toString()}`;
}

/**
 * TV details endpoint.
 * @param {number} tmdbId
 * @returns {string}
 */
export const tvDetailsPath = (tmdbId) => `/tv/${tmdbId}`;

/**
 * Movie search endpoint.
 * @param {{ query: string, page?: number }} options
 * @returns {string}
 */
export function movieSearchPath({ query, page } = {}) {
  const params = new URLSearchParams();
  params.set('query', query);
  if (Number.isInteger(page) && page > 0) params.set('page', String(page));
  return `/search/movie?${params.toString()}`;
}

/**
 * Movie details endpoint.
 * @param {number} tmdbId
 * @returns {string}
 */
export const movieDetailsPath = (tmdbId) => `/movie/${tmdbId}`;

/**
 * TV season details endpoint (season episode list).
 * @param {number} tmdbId
 * @param {number} seasonNumber
 * @returns {string}
 */
export const tvSeasonPath = (tmdbId, seasonNumber) => `/tv/${tmdbId}/season/${seasonNumber}`;
