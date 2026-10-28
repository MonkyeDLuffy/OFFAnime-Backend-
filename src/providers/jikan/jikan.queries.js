/**
 * Jikan REST endpoint helpers.
 *
 * Jikan (MyAnimeList unofficial API) is REST-based, unlike AniList's GraphQL.
 * These helpers build only the endpoints the application actually needs -
 * no attempt to cover the whole Jikan API surface.
 *
 * All paths are relative to the provider's baseUrl (which already ends with
 * /v4, e.g. https://api.jikan.moe/v4).
 */

/**
 * Full anime record by MAL ID (richer metadata - preferred for details and
 * enrichment).
 * @param {number} malId
 * @returns {string}
 */
export const animeFullPath = (malId) => `/anime/${malId}/full`;

/**
 * Basic anime record by MAL ID.
 * @param {number} malId
 * @returns {string}
 */
export const animePath = (malId) => `/anime/${malId}`;

/**
 * Anime search endpoint with query params. Uses URLSearchParams (portable -
 * available in Node 18+, Vercel, and Cloudflare runtimes).
 *
 * @param {{ q?: string, page?: number, limit?: number }} options
 * @returns {string}
 */
export function animeSearchPath({ q, page, limit } = {}) {
  const params = new URLSearchParams();
  if (typeof q === 'string' && q.trim()) params.set('q', q.trim());
  if (Number.isInteger(page) && page > 0) params.set('page', String(page));
  if (Number.isInteger(limit) && limit > 0) params.set('limit', String(limit));
  const qs = params.toString();
  return qs ? `/anime?${qs}` : '/anime';
}

/**
 * Episode LIST endpoint for an anime (episode metadata only - never stream
 * URLs). Jikan returns up to 100 episodes per page.
 * @param {number} malId
 * @param {number} [page=1]
 * @returns {string}
 */
/**
 * Page 1 omits the `page` param entirely (Jikan defaults to page 1 anyway) -
 * the `?page=1` variant reproducibly hits a Jikan-side upstream failure
 * (HTTP 200 + in-band { status: 500 } body) for some anime.
 * @param {number} malId
 * @param {number} [page=1]
 * @returns {string}
 */
export const animeEpisodesPath = (malId, page = 1) => {
  if (!Number.isInteger(page) || page <= 1) return `/anime/${malId}/episodes`;
  return `/anime/${malId}/episodes?page=${page}`;
};
