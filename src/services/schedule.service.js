/**
 * Schedule service - AniList airing schedule.
 *
 *   Controller -> Schedule Service -> CacheManager -> AniList Provider
 *
 * Design:
 *   - AniList is the ONLY schedule source; no Jikan/TMDB, no fabricated times.
 *   - Query window: optional epoch-second bounds (`from`/`to`, validated).
 *     Defaults are DETERMINISTIC within a UTC day: the default window is the
 *     current UTC day through the start of the day 8 days out (covering the
 *     next 7 days). Quantizing the defaults to day boundaries keeps the cache
 *     key stable across requests in the same day - otherwise every request
 *     would mint a fresh key (Date.now() changes every millisecond) and defeat
 *     caching entirely.
 *   - Cached under a namespace-safe, window-specific key (MEDIUM TTL).
 *   - cacheManager.getOrLoad never caches failures; stale-if-error applies.
 */

import { anilistProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL } from '../config/constants.js';
import { ValidationError } from '../errors/index.js';
import { normalizeAnilistAiringSchedule } from '../normalizers/anime.normalizer.js';

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {unknown} value @param {string} label */
function requireEpoch(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`Invalid ${label}: expected a non-negative integer (epoch seconds)`, { received: value });
  }
  return n * 1000;
}

/**
 * Airing schedule for a time window.
 * @param {{ from?: number, to?: number, page?: number }} [options]
 *   Epoch-second bounds (inclusive).
 * @returns {Promise<object>}
 * @throws {ValidationError} invalid bounds/page.
 */
export async function getAiringSchedule({ from, to, page = 1 } = {}) {
  if (!Number.isInteger(page) || page < 1) {
    throw new ValidationError('Invalid page: must be a positive integer', { received: page });
  }
  const now = Date.now();
  // Defaults quantized to UTC day boundaries: deterministic within a day, so
  // the cache key is stable across requests in the same day (still covering
  // the next 7 days from the start of today).
  const startOfToday = Math.floor(now / DAY_MS) * DAY_MS;
  const fromMs = from !== undefined ? requireEpoch(from, 'from') : startOfToday;
  const toMs = to !== undefined ? requireEpoch(to, 'to') : startOfToday + DEFAULT_WINDOW_MS + DAY_MS;
  if (toMs < fromMs) {
    throw new ValidationError('Invalid schedule window: "to" must be >= "from"', { from, to });
  }

  const key = `api:schedule:${fromMs}:${toMs}:p${page}`;
  return cacheManager.getOrLoad(
    key,
    async () => {
      const raw = await anilistProvider.getAiringSchedule({
        page,
        from: Math.floor(fromMs / 1000),
        to: Math.floor(toMs / 1000),
      });
      return {
        window: { from: fromMs, to: toMs },
        pageInfo:
          raw.pageInfo && typeof raw.pageInfo === 'object'
            ? { hasNextPage: raw.pageInfo.hasNextPage === true }
            : null,
        // Normalized airing entries (episode METADATA only - no stream URLs).
        results: normalizeAnilistAiringSchedule(raw),
      };
    },
    {
      ttlSeconds: CACHE_TTL.MEDIUM,
      isValid: (value) => Boolean(value && typeof value === 'object' && Array.isArray(value.results)),
    },
  );
}
