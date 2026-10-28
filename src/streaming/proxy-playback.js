/**
 * Proxy playback URL builder - the ONLY place frontend-safe playback URLs are
 * constructed.
 *
 * MegaPlay must NOT be played directly from the frontend. Playback goes
 * through the separately-deployed MegaPlay proxy, whose contract is:
 *
 *     GET {MEGAPLAY_PROXY_URL}/watch/:id?ep={episode}&lang={sub|dub}&idType={anilist|mal}
 *
 *   - AniList IDs use idType=anilist with the AniList ID as :id.
 *   - MAL IDs use idType=mal with the MAL ID as :id.
 *   - The two namespaces are NEVER mixed (an AniList ID is never used with
 *     idType=mal and vice versa).
 *
 * The proxy host comes exclusively from configuration (MEGAPLAY_PROXY_URL via
 * env.js) - never hardcoded, never derived from provider URLs, never user
 * controlled. Every query value is strictly validated, so no user input can
 * inject path/query tricks.
 *
 * This module is deliberately isolated from the MegaPlay provider: the
 * provider deals with MegaPlay resolution/availability; this module only
 * turns an ALREADY-RESOLVED id/episode/language into the playback URL.
 *
 * Behavior when the proxy is NOT configured (empty MEGAPLAY_PROXY_URL):
 * `isProxyConfigured()` returns false, and `buildProxyWatchUrl` fails with a
 * clear typed error - a direct MegaPlay URL is never silently returned
 * instead.
 */

import { config } from '../config/env.js';
import { NotImplementedError, ValidationError } from '../errors/index.js';
import { normalizeId, ID_TYPES } from '../identity/id-types.js';
import { normalizeEpisode, normalizeLanguage } from '../providers/megaplay/megaplay.queries.js';

/**
 * Whether the playback proxy is configured (diagnostics/health use only).
 * @returns {boolean}
 */
export function isProxyConfigured() {
  return typeof config.MEGAPLAY_PROXY_URL === 'string' && config.MEGAPLAY_PROXY_URL.trim() !== '';
}

/** @returns {string} The configured proxy base URL (trailing slash stripped). */
function proxyBaseUrl() {
  if (!isProxyConfigured()) {
    throw new NotImplementedError(
      'Playback requires the MegaPlay proxy, but MEGAPLAY_PROXY_URL is not configured',
      { proxyConfigured: false, reason: 'proxy_not_configured' },
    );
  }
  return config.MEGAPLAY_PROXY_URL.trim().replace(/\/+$/, '');
}

/**
 * Build the frontend-safe proxy playback URL for an ALREADY-RESOLVED stream.
 *
 * @param {object} params
 * @param {'anilist'|'mal'} params.idType Which namespace `params.id` belongs
 *   to (anilist = AniList ID, mal = MAL ID - never mixed).
 * @param {number|string} params.id The resolved ID for `params.idType`
 *   (AniList ID on the primary path, the IdentityResolver's MAL ID on the
 *   fallback path).
 * @param {number|string} [params.episode=1] Positive, bounded episode.
 * @param {'sub'|'dub'} [params.language='sub'] Documented language contract.
 * @param {{ baseUrl?: string }} [options] Base URL override (tests only;
 *   production always uses the configured MEGAPLAY_PROXY_URL).
 * @returns {string} `{proxy}/watch/{id}?ep={episode}&lang={language}&idType={idType}`
 * @throws {NotImplementedError} proxy not configured (and no test override).
 * @throws {ValidationError} invalid idType/id/episode/language.
 */
export function buildProxyWatchUrl({ idType, id, episode, language } = {}, options = {}) {
  if (idType !== ID_TYPES.ANILIST && idType !== ID_TYPES.MAL) {
    throw new ValidationError('Proxy playback requires an explicit idType: "anilist" or "mal"', {
      received: idType,
    });
  }
  const validId = normalizeId(id);
  if (validId === null) {
    throw new ValidationError(
      `Proxy playback requires a valid ${idType === ID_TYPES.ANILIST ? 'AniList' : 'MAL'} ID`,
      { received: id },
    );
  }
  const ep = normalizeEpisode(episode);
  const lang = normalizeLanguage(language);
  const base = options.baseUrl !== undefined ? String(options.baseUrl).trim().replace(/\/+$/, '') : proxyBaseUrl();
  return `${base}/watch/${validId}?ep=${ep}&lang=${lang}&idType=${idType}`;
}
