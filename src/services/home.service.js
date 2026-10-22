/**
 * Home service - aggregated homepage feed from AniList-backed services.
 *
 *   Controller -> Home Service -> CacheManager -> Anime Service (sections)
 *
 * Design:
 *   - Sections: trending, popular, seasonal (current season), topRated. Each
 *     section is an AniList-backed cached search (anime.service.searchAnime).
 *   - top10: a dedicated Top 10 collection derived from the topRated section
 *     (AniList SCORE_DESC - the ranking source this backend already uses).
 *     No extra provider call; deduplicated by AniList ID, capped at 10.
 *   - The aggregated response is cached under a namespace-safe key so repeat
 *     home requests make ZERO provider calls within the TTL.
 *   - Section resilience: a failing section is OMITTED from the response (with
 *     a warn log) so a temporary provider failure never turns the entire home
 *     response into an empty page. If EVERY section fails, the error
 *     propagates and stale-if-error on the home cache serves the previous
 *     good response - provider failures are never converted into [].
 *   - The seasonal section uses the CURRENT calendar season (deterministic
 *     computation, not fabricated data).
 */

import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL } from '../config/constants.js';
import { normalizeId } from '../identity/id-types.js';
import { logger } from '../utils/logger.js';
import { searchAnime } from './anime.service.js';

const SECTION_SIZE = 20;
const TOP10_SIZE = 10;

/**
 * Build the current AniList season + year from the calendar (deterministic).
 * @returns {{ season: string, seasonYear: number }}
 */
function currentSeason() {
  const month = new Date().getUTCMonth(); // 0-11
  if (month <= 1 || month === 11) return { season: 'WINTER', seasonYear: new Date().getUTCFullYear() };
  if (month <= 4) return { season: 'SPRING', seasonYear: new Date().getUTCFullYear() };
  if (month <= 7) return { season: 'SUMMER', seasonYear: new Date().getUTCFullYear() };
  return { season: 'FALL', seasonYear: new Date().getUTCFullYear() };
}

/**
 * Section definitions (AniList-backed, all validated enum values).
 * @returns {Record<string, object>}
 */
function homeSections() {
  return {
    trending: { sort: ['TRENDING_DESC'], perPage: SECTION_SIZE },
    popular: { sort: ['POPULARITY_DESC'], perPage: SECTION_SIZE },
    seasonal: { ...currentSeason(), sort: ['POPULARITY_DESC'], perPage: SECTION_SIZE },
    topRated: { sort: ['SCORE_DESC'], perPage: SECTION_SIZE },
  };
}

/**
 * Build the Top 10 collection from the already-fetched topRated results
 * (AniList SCORE_DESC ranking order, preserved). Only valid entries are kept,
 * deduplicated by AniList ID, capped at TOP10_SIZE - never fabricated, never
 * duplicated.
 * @param {Record<string, unknown>} sections
 * @returns {object[]}
 */
function buildTop10(sections) {
  const source = Array.isArray(sections.topRated) ? sections.topRated : [];
  const seen = new Set();
  const top10 = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const id = normalizeId(entry.anilistId ?? entry.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    top10.push(entry);
    if (top10.length >= TOP10_SIZE) break;
  }
  return top10;
}

/**
 * Aggregated home feed. Only sections that loaded successfully are included.
 * @param {object} [deps]
 * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
 * @param {typeof searchAnime} [deps.search]
 * @returns {Promise<object>}
 */
export async function getHomeFeed({ cache = cacheManager, search = searchAnime } = {}) {
  // v3: anime cards now carry titleEnglish/titleRomaji/titleNative (and
  // `title` prefers English) - the version bump keeps stale pre-change
  // responses from hiding the new fields.
  return cache.getOrLoad(
    'api:home:v3',
    async () => {
      const sections = {};
      const definitions = homeSections();
      let failed = 0;
      let total = 0;
      /** @type {unknown} */
      let lastError = null;

      for (const [name, options] of Object.entries(definitions)) {
        total += 1;
        try {
          const page = await search('', options);
          sections[name] = page.results;
        } catch (err) {
          failed += 1;
          lastError = err;
          logger.warn('home.sectionFailed', { section: name, err });
        }
      }

      // Every section failed -> propagate so stale-if-error on the home cache
      // serves the previous good response (never a fabricated empty page).
      if (failed === total && lastError) {
        throw lastError;
      }

      // Top 10 collection: present only when the topRated ranking loaded (a
      // failing section stays omitted - never an empty fabrication).
      if (sections.topRated !== undefined) {
        sections.top10 = buildTop10(sections);
      }

      return sections;
    },
    {
      ttlSeconds: CACHE_TTL.MEDIUM,
      isValid: (value) => Boolean(value && typeof value === 'object'),
    },
  );
}
