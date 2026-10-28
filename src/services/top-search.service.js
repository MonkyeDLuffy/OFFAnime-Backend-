/**
 * Top-search service - popular/trending search suggestions.
 *
 *   Controller -> Top-search Service -> Anime Service (cached AniList search)
 *
 * Derived from available AniList data (most popular anime, POPULARITY_DESC) -
 * no database-backed analytics, no invented search counts. Results reuse the
 * anime service's normalized cached search, so no extra provider calls are
 * made and the cache behavior is inherited from that service.
 */

import { searchAnime } from './anime.service.js';

const SUGGESTION_COUNT = 10;

/**
 * Top search suggestions (normalized anime cards, popularity-ranked).
 * @returns {Promise<Array>}
 */
export async function getTopSearch() {
  const page = await searchAnime('', { perPage: SUGGESTION_COUNT, sort: ['POPULARITY_DESC'] });
  return page.results;
}
