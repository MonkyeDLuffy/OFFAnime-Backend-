/**
 * IdentityResolver - the single home for AniList <-> MAL mapping.
 *
 * THE critical contract:
 *   - AniList ID and MAL ID are DIFFERENT namespaces.
 *   - `id === anilistId` always; a MAL ID must NEVER become `id` or
 *     `anilistId` unless an actual AniList provider response explicitly
 *     confirms the relationship (AniList's `id` / `idMal` fields).
 *   - Namespace determines meaning, NOT numeric equality: AniList 123 and MAL
 *     123 are two separate namespace values, never assumed to be related.
 *
 * Mapping authority: AniList's actual relationship fields ONLY.
 *   - AniList -> MAL: AniListProvider.getAnimeById -> payload.idMal.
 *   - MAL -> AniList: AniListProvider.getAnimeByMalId -> payload.id.
 *   - NO title-based/fuzzy matching, NO Jikan search, NO numeric derivation,
 *     NO URL tricks. If the provider cannot establish the mapping, the result
 *     is explicitly unresolved (or NotFoundError when the anime doesn't exist).
 *
 * Identity result shape (see id-types.js IdentityResult):
 *   { anilistId, malId, source: 'anilist'|null, confidence: 'provider'|null, resolved }
 *
 * Cache integration (via the Phase 1 cache manager - no second cache system):
 *   - Namespace-safe keys: `identity:anilist-to-mal:{id}` and
 *     `identity:mal-to-anilist:{id}` - never a bare `identity:{id}`.
 *   - NORMALIZED identity results are cached, never raw provider payloads.
 *   - Valid unresolved mappings (provider succeeded, idMal was null) are
 *     cached with a conservative (shorter) TTL.
 *   - Provider failures (timeout/429/500/network/malformed) are NEVER cached
 *     as unresolved mappings; they propagate (stale-if-error still applies).
 *   - Resolving one direction also populates the reverse cache entry (an
 *     optimization through the cache abstraction, never L1 internals).
 *   - Concurrent identical lookups coalesce through cacheManager.getOrLoad.
 *
 * Provider failures NEVER silently become `malId: null` - that distinction is
 * the core of this layer.
 */

import { anilistProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { CACHE_TTL } from '../config/constants.js';
import { ProviderError, ValidationError } from '../errors/index.js';
import {
  parseRequiredId,
  parseIdentityType,
  createIdentityResult,
} from './id-types.js';

/** Valid unresolved mappings get a conservative (shorter) TTL than resolved ones. */
const UNRESOLVED_TTL_SECONDS = CACHE_TTL.MEDIUM;

/** A cached value is valid only if it is a real identity result. */
const isIdentityResult = (value) =>
  Boolean(value && typeof value === 'object' && typeof value.resolved === 'boolean');

export class IdentityResolver {
  /**
   * @param {object} [deps]
   * @param {import('../providers/anilist/anilist.provider.js').AnilistProvider} [deps.provider]
   * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
   */
  constructor({ provider = anilistProvider, cache = cacheManager } = {}) {
    this.provider = provider;
    this.cache = cache;
  }

  /**
   * Resolve the MAL ID for an AniList ID, using AniList's `idMal` field ONLY.
   *
   * @param {number|string} anilistId
   * @returns {Promise<import('./id-types.js').IdentityResult>}
   * @throws {ValidationError} invalid ID. @throws {NotFoundError} anime does
   *   not exist on AniList. @throws {TimeoutError|RateLimitError|ProviderError}
   *   on provider failure (never cached as unresolved).
   */
  async resolveAniListToMal(anilistId) {
    const id = parseRequiredId(anilistId, 'anilistId');
    const key = `identity:anilist-to-mal:${id}`;

    const result = await this.cache.getOrLoad(
      key,
      () => this._resolveAniListToMalFresh(id),
      { ttlSeconds: CACHE_TTL.DAY, isValid: isIdentityResult },
    );

    // Valid unresolved mappings get a conservative (shorter) TTL. This is a
    // deliberate overwrite through the cache abstraction - it only happens
    // after a successful provider response, never on provider failure.
    if (!result.resolved) {
      await this.cache.set(key, result, UNRESOLVED_TTL_SECONDS);
    }

    return result;
  }

  /**
   * Resolve the AniList ID for a MAL ID via AniListProvider.getAnimeByMalId.
   *
   * @param {number|string} malId
   * @returns {Promise<import('./id-types.js').IdentityResult>}
   * @throws {ValidationError} invalid ID. @throws {NotFoundError} no AniList
   *   Media exists for the MAL ID. @throws {TimeoutError|RateLimitError|
   *   ProviderError} on provider failure.
   */
  async resolveMalToAniList(malId) {
    const id = parseRequiredId(malId, 'malId');
    const key = `identity:mal-to-anilist:${id}`;

    return this.cache.getOrLoad(
      key,
      () => this._resolveMalToAniListFresh(id),
      { ttlSeconds: CACHE_TTL.DAY, isValid: isIdentityResult },
    );
  }

  /**
   * Generic resolver. The namespace must be explicit - a bare number is
   * ambiguous and never accepted.
   *
   * @param {{ type: 'anilist'|'mal', id: number|string }} input
   * @returns {Promise<import('./id-types.js').IdentityResult>}
   */
  async resolve(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError(
        'resolve requires an explicit identity input like { type: "anilist", id: 123 } or { type: "mal", id: 456 }',
      );
    }
    const type = parseIdentityType(input.type);
    return type === 'anilist' ? this.resolveAniListToMal(input.id) : this.resolveMalToAniList(input.id);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Fresh AniList -> MAL resolution (cache miss path). anilistId comes ONLY
   * from the provider payload's `id` field; malId ONLY from `idMal`.
   * @param {number} id
   * @returns {Promise<import('./id-types.js').IdentityResult>}
   */
  async _resolveAniListToMalFresh(id) {
    const media = await this.provider.getAnimeById(id);

    // Cross-check: the payload's id must match the requested AniList ID.
    const payloadAnilistId = requirePayloadId(media.id, this.provider.name);
    if (payloadAnilistId !== id) {
      throw new ProviderError(
        `AniList returned id ${payloadAnilistId} for requested AniList ID ${id}`,
        { provider: this.provider.name },
      );
    }

    // The mapping comes ONLY from AniList's idMal field - no guessing.
    const result = createIdentityResult({ anilistId: payloadAnilistId, malId: media.idMal });

    if (result.resolved) {
      // Populate the reverse mapping through the cache abstraction.
      await this.cache.set(`identity:mal-to-anilist:${result.malId}`, result, CACHE_TTL.DAY);
    }

    return result;
  }

  /**
   * Fresh MAL -> AniList resolution (cache miss path). anilistId comes ONLY
   * from the provider payload's `id` field, cross-checked against `idMal`.
   * @param {number} id
   * @returns {Promise<import('./id-types.js').IdentityResult>}
   */
  async _resolveMalToAniListFresh(id) {
    // NotFoundError propagates when no AniList Media exists for the MAL ID.
    const media = await this.provider.getAnimeByMalId(id);

    const payloadAnilistId = requirePayloadId(media.id, this.provider.name);
    const payloadMalId = media.idMal === null || media.idMal === undefined ? null : Number(media.idMal);
    if (payloadMalId !== id) {
      throw new ProviderError(
        `AniList returned idMal ${payloadMalId} for requested MAL ID ${id}`,
        { provider: this.provider.name },
      );
    }

    const result = createIdentityResult({ anilistId: payloadAnilistId, malId: payloadMalId });

    // Populate the forward mapping through the cache abstraction.
    await this.cache.set(`identity:anilist-to-mal:${payloadAnilistId}`, result, CACHE_TTL.DAY);

    return result;
  }
}

/** @param {unknown} value @param {string} provider */
function requirePayloadId(value, provider) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ProviderError('AniList payload is missing a valid id', { provider });
  }
  return id;
}

/** Default shared resolver instance (AniList provider + default cache manager). */
export const identityResolver = new IdentityResolver();
