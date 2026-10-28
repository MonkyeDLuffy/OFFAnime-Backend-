/**
 * MegaPlay provider - PRIMARY streaming server (megaplay.buzz).
 *
 * The documented provider contract defines exactly two stream endpoints:
 *
 *     /stream/ani/{anilist-id}/{ep-num}/{language}
 *     /stream/mal/{mal-id}/{ep-num}/{language}
 *
 * Some titles resolve via AniList ID, others only via MAL ID, so this provider
 * exposes both lookups. WHICH to try first, and the AniList->MAL fallback, is
 * orchestrated by the streaming layer (src/streaming) together with the
 * identity layer - NOT here. This provider only knows how to ask MegaPlay for
 * a given id kind.
 *
 * Responsibilities:
 *   - construct MegaPlay requests via the shared Phase 1 HTTP client
 *     (BaseProvider - no second HTTP client)
 *   - return RAW MegaPlay payloads plus the exact documented URL used
 *   - map transport/HTTP failures onto the typed error taxonomy through the
 *     shared HTTP client (TimeoutError / RateLimitError / ProviderError)
 *
 * This provider NEVER:
 *   - resolves AniList <-> MAL identity (that is IdentityResolver's job)
 *   - performs title fuzzy matching or decides canonical identity
 *   - calls Jikan for identity, touches the cache/Supabase
 *   - fabricates stream URLs
 *
 * MegaPlay requires no authentication credentials for these public endpoints
 * (no secrets exist in the environment contract for it).
 */

import { BaseProvider } from '../base-provider.js';
import { config } from '../../config/env.js';
import { PROVIDERS, STREAM_LANGUAGES } from '../../config/constants.js';
import { buildAniListStreamUrl, buildMalStreamUrl } from './megaplay.queries.js';

export class MegaplayProvider extends BaseProvider {
  constructor() {
    super({ name: PROVIDERS.MEGAPLAY, baseUrl: config.MEGAPLAY_API_URL });
  }

  /**
   * Attempt to resolve stream sources using an AniList ID.
   * @param {number|string} anilistId AniList ID (NOT a MAL ID).
   * @param {{ episode?: number, language?: 'sub'|'dub' }} [options]
   * @returns {Promise<{ data: unknown, url: string }>} RAW MegaPlay payload
   *   plus the exact documented MegaPlay URL used.
   * @throws {ValidationError} invalid id/episode/language.
   * @throws {TimeoutError|RateLimitError|ProviderError} per the shared HTTP
   *   client's failure mapping (never fabricated, never cached here).
   */
  async resolveByAnilistId(anilistId, { episode = 1, language = STREAM_LANGUAGES.SUB } = {}) {
    return this._resolve(buildAniListStreamUrl(anilistId, episode, language));
  }

  /**
   * Attempt to resolve stream sources using a MAL ID (fallback path).
   * @param {number|string} malId MAL ID (NOT an AniList ID).
   * @param {{ episode?: number, language?: 'sub'|'dub' }} [options]
   * @returns {Promise<{ data: unknown, url: string }>} RAW MegaPlay payload
   *   plus the exact documented MegaPlay URL used.
   * @throws {ValidationError} invalid id/episode/language.
   * @throws {TimeoutError|RateLimitError|ProviderError} per the shared HTTP
   *   client's failure mapping.
   */
  async resolveByMalId(malId, { episode = 1, language = STREAM_LANGUAGES.SUB } = {}) {
    return this._resolve(buildMalStreamUrl(malId, episode, language));
  }

  /**
   * Perform the documented MegaPlay request and return the RAW payload with
   * the exact URL used. The response body is returned as-is; deciding
   * usable-vs-not is the MegaPlay response normalizer's job, never here.
   * @param {string} path Documented MegaPlay path (host comes from config).
   * @returns {Promise<{ data: unknown, url: string }>}
   */
  async _resolve(path) {
    const url = this.buildUrl(path);
    const response = await this.request(path);
    return { data: response.data, url };
  }
}
