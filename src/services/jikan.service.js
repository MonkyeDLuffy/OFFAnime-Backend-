/**
 * Jikan service - business logic for secondary MAL metadata, following the
 * established Phase 2 service pattern:
 *
 *   request -> service -> cacheManager.getOrLoad -> Jikan provider
 *                                        -> normalizeJikanAnime
 *                                        -> cache CANONICAL/normalized result
 *
 * Rules respected here:
 *   - No Jikan REST paths in services (provider owns them).
 *   - Cache stores NORMALIZED Jikan data, never raw provider payloads.
 *   - cacheManager.getOrLoad never caches failures or malformed responses;
 *     stale-if-error and request coalescing work through the cache layer.
 *   - No provider-level caching. No frontend routes activated in this phase.
 */

import { jikanProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { ValidationError } from '../errors/index.js';
import {
  normalizeJikanAnime,
  normalizeJikanEpisodes,
  normalizeJikanPage,
} from '../normalizers/anime.normalizer.js';

/** A cached result is valid only if it carries a trusted malId. */
const isValidJikanAnime = (value) =>
  Boolean(value && typeof value === 'object' && value.malId !== null && value.malId !== undefined);

/** A cached search result is valid only if it has a results array. */
const isValidJikanSearchPage = (value) =>
  Boolean(value && typeof value === 'object' && Array.isArray(value.results));

/**
 * Normalized Jikan anime details by MyAnimeList ID.
 * @param {number|string} malId MyAnimeList ID (NOT an AniList ID).
 * @returns {Promise<import('../normalizers/jikan.types.js').JikanAnime>}
 * @throws {ValidationError|NotFoundError|ProviderError} per provider mapping.
 */
export async function getAnimeByMalId(malId) {
  const id = parseRequiredId(malId, 'malId');
  return cacheManager.getOrLoad(
    `jikan:anime:${id}`,
    async () => normalizeJikanAnime(await jikanProvider.getAnimeByMalId(id)),
    { ttlSeconds: CACHE_TTL.DAY, isValid: isValidJikanAnime },
  );
}

/**
 * Normalized Jikan episode list (episode METADATA only - never stream URLs).
 * Cached per ACTUAL MAL ID + page under a namespace-safe key
 * (episodes:jikan:{malId}:page:{page}) - failures are never cached.
 * @param {number|string} malId MyAnimeList ID (NOT an AniList ID).
 * @param {{ page?: number }} [options]
 * @returns {Promise<object>}
 */
export async function getEpisodes(malId, { page = 1 } = {}) {
  const id = parseRequiredId(malId, 'malId');
  return cacheManager.getOrLoad(
    `episodes:jikan:${id}:page:${page}`,
    async () =>
      normalizeJikanEpisodes(await jikanProvider.getAnimeEpisodes(id, { page }), { page }),
    {
      ttlSeconds: CACHE_TTL.MEDIUM,
      isValid: (value) => Boolean(value && typeof value === 'object' && Array.isArray(value.episodes)),
    },
  );
}

/**
 * Normalized Jikan search results (cards + page info).
 * @param {string} query
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<import('../normalizers/jikan.types.js').JikanSearchPage>}
 */
export async function searchAnime(query, options = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ValidationError('Search query is required');
  }
  const key = `jikan:search:${query.trim()}:${JSON.stringify(options)}`;
  return cacheManager.getOrLoad(
    key,
    async () => normalizeJikanPage(await jikanProvider.searchAnime(query, options)),
    { ttlSeconds: CACHE_TTL.MEDIUM, isValid: isValidJikanSearchPage },
  );
}
