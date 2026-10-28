/**
 * Category service - category listings backed by AniList filtering.
 *
 *   Controller -> Category Service -> Anime Service (search) -> CacheManager
 *
 * Design:
 *   - Category types are validated BEFORE any provider request: special
 *     categories (trending/popular/top/airing/upcoming) map to AniList
 *     sort/status options, and genre categories must match AniList's standard
 *     genre list (case/punctuation-insensitive). Invalid values produce the
 *     project's ValidationError - never a provider request with arbitrary
 *     input.
 *   - Results are normalized through the anime service (namespace-safe,
 *     deterministic cache keys).
 */

import { ANILIST_GENRES } from '../config/constants.js';
import { ValidationError } from '../errors/index.js';
import { searchAnime } from './anime.service.js';

/** Special (non-genre) category types mapped to validated AniList options. */
const SPECIAL_CATEGORIES = Object.freeze({
  trending: { sort: ['TRENDING_DESC'] },
  popular: { sort: ['POPULARITY_DESC'] },
  top: { sort: ['SCORE_DESC'] },
  'top rated': { sort: ['SCORE_DESC'] },
  airing: { status: 'RELEASING', sort: ['POPULARITY_DESC'] },
  upcoming: { status: 'NOT_YET_RELEASED', sort: ['POPULARITY_DESC'] },
});

/**
 * Normalize a category type for comparison (lowercase, punctuation/separator
 * insensitive): 'Sci-Fi' / 'sci-fi' / 'sci fi' all match 'Sci-Fi'.
 * @param {unknown} type
 * @returns {string}
 */
function normalizeCategoryType(type) {
  if (typeof type !== 'string') return '';
  return type
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim();
}

/** All valid category types (special + genres). */
function allowedCategories() {
  return [...Object.keys(SPECIAL_CATEGORIES), ...ANILIST_GENRES];
}

/**
 * Resolve a category type into validated AniList search options.
 * @param {string} type
 * @returns {object}
 * @throws {ValidationError} for invalid/unknown categories.
 */
export function resolveCategoryOptions(type) {
  const normalized = normalizeCategoryType(type);
  if (normalized === '') {
    throw new ValidationError('Category type is required', { allowed: allowedCategories() });
  }

  const special = SPECIAL_CATEGORIES[normalized];
  if (special) return { ...special };

  const genre = ANILIST_GENRES.find(
    (candidate) =>
      candidate.toLowerCase() === normalized ||
      candidate.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ') === normalized,
  );
  if (genre) return { genre };

  throw new ValidationError(`Unknown category "${type}"`, { allowed: allowedCategories() });
}

/**
 * Category listing (normalized search page).
 * @param {string} type
 * @param {{ page?: number, perPage?: number }} [options]
 * @returns {Promise<object>}
 */
export async function getCategory(type, { page, perPage } = {}) {
  const options = resolveCategoryOptions(type);
  return searchAnime('', { ...options, page, perPage });
}
