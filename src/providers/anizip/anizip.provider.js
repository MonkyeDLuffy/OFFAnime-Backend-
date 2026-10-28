/**
 * AniZip provider - DEFAULT detailed-episode metadata source (api.ani.zip).
 *
 * Endpoint (verified live, AniList ID 21/One Piece + 20/Naruto):
 *
 *     GET https://api.ani.zip/mappings?anilist_id={anilist-id}
 *     -> 200 JSON: { titles, episodes, episodeCount, specialCount, images,
 *                    mappings }
 *        where `episodes` is an OBJECT keyed by episode number ("1", "2", ...)
 *        and prefixed keys ("S1", "O29") mark specials/openings.
 *     -> 404 (JSON string "Not Found") when no mapping exists for the ID.
 *
 * AniZip is an EPISODE-METADATA source, never a streaming provider: it never
 * produces playback/stream URLs (MegaPlay + proxy stay exclusively in
 * src/streaming). The request uses the PUBLIC ROUTE's AniList ID DIRECTLY -
 * never converted to a MAL ID (identity resolution stays in the identity
 * layer for the response's malId field only).
 *
 * Responsibilities:
 *   - construct the mappings request via the shared Phase 1 HTTP client
 *     (BaseProvider - no second HTTP client); the host comes exclusively from
 *     configuration (ANIZIP_API_URL)
 *   - validate the AniList ID before any request
 *   - return the RAW payload; normalization is the anizip-normalizer's job
 *   - map transport/HTTP failures onto the typed error taxonomy (an upstream
 *     404 becomes NotFoundError - "not on AniZip" is a legitimate
 *     cannot-provide outcome the episode service falls back from; every other
 *     failure stays TimeoutError/RateLimitError/ProviderError)
 *
 * This provider NEVER: resolves AniList <-> MAL identity, fabricates episode
 * numbers or image URLs, or touches the cache (caching lives in the service
 * layer through the CacheManager).
 */

import { BaseProvider } from '../base-provider.js';
import { config } from '../../config/env.js';
import { PROVIDERS } from '../../config/constants.js';
import { NotFoundError, ProviderError, ValidationError } from '../../errors/index.js';
import { parseRequiredId } from '../../identity/id-types.js';

export class AnizipProvider extends BaseProvider {
  constructor() {
    super({ name: PROVIDERS.ANIZIP, baseUrl: config.ANIZIP_API_URL });
  }

  /**
   * Fetch the RAW AniZip mappings payload for an AniList ID.
   * @param {number|string} anilistId AniList ID (the public route's canonical
   *   ID - NOT converted to a MAL ID for this request).
   * @returns {Promise<unknown>} RAW AniZip mappings payload.
   * @throws {ValidationError} invalid AniList ID.
   * @throws {NotFoundError} no mapping exists on AniZip for this AniList ID
   *   (upstream 404 - a valid cannot-provide outcome, never fabricated data).
   * @throws {TimeoutError|RateLimitError|ProviderError} per the shared HTTP
   *   client's failure mapping.
   */
  async getMappingsByAnilistId(anilistId) {
    // Validate BEFORE requesting (never send unvalidated user input upstream).
    const id = parseRequiredId(anilistId, 'anilistId');
    const path = `mappings?anilist_id=${id}`;

    try {
      const response = await this.request(path);
      return response.data;
    } catch (err) {
      // AniZip answers HTTP 404 (body "Not Found") when it has no mapping for
      // the AniList ID - a typed not-found, distinguishable from an outage.
      if (err instanceof ProviderError && err.details?.upstreamStatus === 404) {
        throw new NotFoundError(`No AniZip mapping exists for AniList ID ${id}`, { cause: err });
      }
      throw err;
    }
  }
}
