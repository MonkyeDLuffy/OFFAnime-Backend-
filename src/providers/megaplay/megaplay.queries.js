/**
 * MegaPlay query/url construction - the ONLY place MegaPlay paths are built.
 *
 * The documented MegaPlay endpoint contract defines exactly two stream route
 * templates on the megaplay.buzz host:
 *
 *     /stream/ani/{anilist-id}/{ep-num}/{language}   (AniList ID lookup)
 *     /stream/mal/{mal-id}/{ep-num}/{language}       (MAL ID lookup)
 *
 * These builders produce ONLY those paths. The host comes exclusively from
 * configuration (MEGAPLAY_API_URL via BaseProvider) - user input can never
 * replace the host. Every path segment is strictly validated (positive
 * integer IDs, positive bounded episode, sub|dub language), so no user input
 * can inject path tricks (e.g. "../") or arbitrary external URLs.
 *
 * No search endpoints, no title-based URLs, no fabricated IDs, no alternate
 * providers.
 */

import { STREAM_LANGUAGES, STREAM_LIMITS } from '../../config/constants.js';
import { ValidationError } from '../../errors/index.js';
import { normalizeId } from '../../identity/id-types.js';

/**
 * Language path segment. Only the documented sub|dub values are accepted;
 * a missing value falls back to the documented default ('sub').
 * @param {unknown} value
 * @param {string} [label='language'] Used in the error message.
 * @returns {'sub'|'dub'}
 * @throws {ValidationError} for values outside the documented contract.
 */
export function normalizeLanguage(value, label = 'language') {
  const lang = value === undefined || value === null || value === '' ? STREAM_LANGUAGES.SUB : value;
  if (lang !== STREAM_LANGUAGES.SUB && lang !== STREAM_LANGUAGES.DUB) {
    throw new ValidationError(`${label} must be "sub" or "dub"`, { received: value });
  }
  return lang;
}

/**
 * Episode path segment: a positive integer bounded to a sensible maximum;
 * a MISSING value (undefined/null) falls back to episode 1. A SUPPLIED value
 * is never silently replaced: empty strings, arrays (repeated/array query
 * params) and any other non positive-integer value are rejected.
 * @param {unknown} value
 * @param {string} [label='episode'] Used in the error message.
 * @returns {number}
 * @throws {ValidationError} for zero/negative/non-integer/excessive/empty/array values.
 */
export function normalizeEpisode(value, label = 'episode') {
  if (Array.isArray(value)) {
    throw new ValidationError(`${label} must be a positive integer`, { received: value });
  }
  const ep = normalizeId(value === undefined || value === null ? 1 : value);
  if (ep === null) {
    throw new ValidationError(`${label} must be a positive integer`, { received: value });
  }
  if (ep > STREAM_LIMITS.MAX_EPISODE) {
    throw new ValidationError(`${label} exceeds the maximum of ${STREAM_LIMITS.MAX_EPISODE}`, {
      received: value,
    });
  }
  return ep;
}

/**
 * @param {'ani'|'mal'} kind Documented endpoint kind ('ani' = AniList, 'mal' = MAL).
 * @param {unknown} id
 * @param {unknown} episode
 * @param {unknown} language
 * @returns {string} The documented MegaPlay path (no host - the host comes
 *   from config via BaseProvider).
 * @throws {ValidationError} invalid id/episode/language.
 */
function buildStreamPath(kind, id, episode, language) {
  const validId = normalizeId(id);
  if (validId === null) {
    throw new ValidationError(
      `${kind === 'ani' ? 'anilistId' : 'malId'} must be a positive integer`,
      { received: id },
    );
  }
  const ep = normalizeEpisode(episode);
  const lang = normalizeLanguage(language);
  return `/stream/${kind}/${validId}/${ep}/${lang}`;
}

/**
 * Documented MegaPlay AniList-ID stream path: /stream/ani/{id}/{ep}/{language}.
 * @param {unknown} anilistId AniList ID (NOT a MAL ID - different namespaces).
 * @param {unknown} [episode=1]
 * @param {unknown} [language='sub']
 * @returns {string}
 * @throws {ValidationError}
 */
export function buildAniListStreamUrl(anilistId, episode = 1, language = STREAM_LANGUAGES.SUB) {
  return buildStreamPath('ani', anilistId, episode, language);
}

/**
 * Documented MegaPlay MAL-ID stream path: /stream/mal/{id}/{ep}/{language}.
 * @param {unknown} malId MAL ID (NOT an AniList ID - different namespaces).
 * @param {unknown} [episode=1]
 * @param {unknown} [language='sub']
 * @returns {string}
 * @throws {ValidationError}
 */
export function buildMalStreamUrl(malId, episode = 1, language = STREAM_LANGUAGES.SUB) {
  return buildStreamPath('mal', malId, episode, language);
}
