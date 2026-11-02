/**
 * StreamResolver - isolated streaming resolution logic (dual-server capable).
 *
 * Streaming is deliberately separated from anime-metadata logic. This resolver
 * only answers "give me a playable stream for this anime/episode", orchestrating
 * the MegaPlay provider and the identity layer. It holds NO general anime-detail
 * logic.
 *
 * TWO PUBLIC FLOWS (one per streaming server the frontend can select):
 *
 * AniList-primary (legacy /api/stream/resolve/:id and /api/stream/resolve/anilist/:id):
 *
 *     anilistId  (:id is ALWAYS an AniList ID - never a MAL ID)
 *        |-> MegaPlay /stream/ani/{anilistId}/{ep}/{lang}   -- PRIMARY source
 *        |      usable stream -> proxy playback URL (idType=anilist)
 *        |      genuine no-stream (404 / explicit no-stream / empty sources /
 *        |      malformed payload)
 *        v
 *     identity.resolveAniListToMal(anilistId)       -- AniList -> MAL mapping
 *        |      malId found (mapping comes ONLY from AniList's idMal field)
 *        v
 *     MegaPlay /stream/mal/{malId}/{ep}/{lang}      -- FALLBACK source
 *        |      usable stream -> proxy playback URL (idType=mal)
 *        v
 *     none -> PRIMARY (AniList) proxy playback URL anyway
 *
 * MAL-primary (/api/stream/resolve/mal/:id):
 *
 *     malId  (:id is ALWAYS a MAL ID - never treated as an AniList ID)
 *        |-> MegaPlay /stream/mal/{malId}/{ep}/{lang}      -- PRIMARY source
 *        |      usable stream -> proxy playback URL (idType=mal)
 *        v
 *     identity.resolveMalToAniList(malId)           -- MAL -> AniList mapping
 *        |      anilistId found (mapping comes ONLY from AniList's id field)
 *        v
 *     MegaPlay /stream/ani/{anilistId}/{ep}/{lang}  -- FALLBACK source
 *        |      usable stream -> proxy playback URL (idType=anilist)
 *        v
 *     none -> PRIMARY (MAL) proxy playback URL anyway
 *
 * Both flows share ONE orchestrator (_resolveWithPrimaryFallback): the primary
 * namespace is always attempted FIRST with its own id kind; the cross-namespace
 * fallback happens ONLY on a genuine primary no-stream result, ONLY through
 * the IdentityResolver, and NEVER by reusing the primary id in the other
 * namespace (numeric equality means nothing). A MegaPlay internal id would
 * never be exposed as an AniList/MAL ID either. NO title-based fallback, no
 * fuzzy matching, no alternate streaming providers.
 *
 * AVAILABILITY (corrected architecture): the direct MegaPlay /stream endpoints
 * are SOURCE SELECTION only. A direct 410 / "Error - MegaPlay" no-stream
 * response does NOT prove playback is unavailable - the BROWSER-FACING
 * playback mechanism is the proxy (MEGAPLAY_PROXY_URL), which constructs the
 * MegaPlay URL internally and serves the playable iframe page (verified live:
 * /watch/21?ep=1&lang=sub&idType=anilist returns HTTP 200 + player iframe even
 * though the direct URL 410s). When neither direct lookup produced a usable
 * stream, the resolver returns the configured proxy playback URL for the
 * PRIMARY namespace of that request and lets the proxy handle availability.
 *
 * Failure classification:
 *   - primary lookup succeeds               -> stream (Case A)
 *   - no usable stream + mapping exists     -> cross-namespace fallback (Case B)
 *   - timeout/429/500/network               -> typed provider failure
 *     (Case C: stale-if-error applies through CacheManager; an infrastructure
 *     outage is NEVER reinterpreted as "anime not found")
 *   - genuine 404/no-stream from MegaPlay   -> may trigger the fallback
 *     (Case D: distinguishable from an infrastructure failure)
 *   - neither source yields a usable stream -> PRIMARY proxy playback URL
 *     (the proxy is the browser-facing playback mechanism and handles
 *     availability; a direct 410/no-stream is never reinterpreted as
 *     "unavailable")
 *
 * Identity lookup failures (case-specific, deliberate):
 *   - AniList-primary: a NotFoundError from identity.resolveAniListToMal
 *     propagates (documented behavior of the legacy route - AniList is the
 *     canonical identity registry, so a nonexistent AniList ID invalidates
 *     the whole request).
 *   - MAL-primary: a NotFoundError from identity.resolveMalToAniList means
 *     "no AniList Media maps to this MAL ID" - a MISSING MAPPING, not a
 *     request-level not-found (the MAL ID may still play through the proxy).
 *     It is handled gracefully: the AniList fallback is skipped and the
 *     PRIMARY (mal) namespace stands. Identity cracks in the OTHER direction
 *     pose no such asymmetry - they cannot invalidate the requested primary ID.
 *   - Infrastructure failures of the identity layer (timeout/429/500/network)
 *     always propagate as typed errors - NEVER reinterpreted as "unresolved".
 *
 * Caching (through the Phase 1/6 CacheManager - no direct Supabase access):
 *   - Namespace-safe keys (both flows, both directions):
 *       stream:megaplay:anilist:{anilistId}:episode:{episode}:language:{language}
 *       stream:megaplay:mal:{malId}:episode:{episode}:language:{language}
 *   - Only VALID normalized stream results are cached as successful streams.
 *     Provider failures (timeout/429/500/network) are NEVER cached.
 *   - The cached value is the RESOLUTION result (availability detection);
 *     the frontend-safe proxy playback URL is built per-response afterwards,
 *     so cached data never depends on proxy configuration.
 *   - Valid no-stream results are cached briefly with `usable: false`
 *     semantics - clearly distinguishable from a real stream. A no-stream
 *     marker cached under one namespace NEVER leaks into the other namespace.
 *   - Valid stream results use a conservative SHORT TTL (streaming URLs are
 *     more volatile than metadata); explicit provider expiry metadata is
 *     respected by capping the TTL when practical.
 *   - Stale-if-error and request coalescing work through the cache layer.
 *
 * Playback (Phase 10A): DIRECT MegaPlay URLs are NEVER exposed to the
 * frontend. The frontend-safe playback URL is built by the isolated
 * proxy-playback module (proxy-playback.js) from MEGAPLAY_PROXY_URL:
 *     {proxy}/watch/{resolvedId}?ep={episode}&lang={language}&idType={idType}
 * The idType/id pair mirrors the namespace that actually WON the resolution
 * (never mixed). When the proxy is not configured, a clear typed
 * configuration error is thrown instead of silently exposing a direct
 * MegaPlay URL.
 *
 * Identity safety: AniList ID and MAL ID are DIFFERENT namespaces. On the
 * AniList-primary flow the response's anilistId always mirrors the requested
 * AniList ID, and on the MAL-primary flow the response's malId always mirrors
 * the requested MAL ID; the OTHER id comes ONLY from the IdentityResolver
 * (or null). NO numeric inference, NO ID swapping, NO silent rewrite of the
 * request's own id into the other namespace.
 */

import { megaplayProvider } from '../providers/index.js';
import { cacheManager } from '../cache/cache-manager.js';
import { identityResolver } from '../identity/identity-resolver.js';
import { isProxyConfigured, buildProxyWatchUrl } from './proxy-playback.js';
import { ProviderError, NotImplementedError, ValidationError, NotFoundError } from '../errors/index.js';
import { normalizeId, ID_TYPES } from '../identity/id-types.js';
import {
  PROVIDERS,
  STREAM_LANGUAGES,
  STREAM_CACHE_TTL,
  STREAM_LIMITS,
} from '../config/constants.js';
import { normalizeEpisode, normalizeLanguage } from '../providers/megaplay/megaplay.queries.js';
import {
  normalizeMegaplayStreamResponse,
  isUsableStreamResult,
} from '../normalizers/megaplay-normalizer.js';

/**
 * Namespace-safe cache keys (never a bare numeric id - namespaces collide).
 * @param {'anilist'|'mal'} idType
 * @param {number} id
 * @param {number} episode
 * @param {'sub'|'dub'} language
 * @returns {string}
 */
function streamCacheKey(idType, id, episode, language) {
  return `stream:megaplay:${idType}:${id}:episode:${episode}:language:${language}`;
}

/**
 * A genuine MegaPlay 404 (no stream page for this id) is a not-found result
 * that may trigger the MAL fallback. A timeout/429/500/network failure is an
 * infrastructure outage and must remain a typed provider failure.
 * @param {unknown} err
 * @returns {boolean}
 */
function isUpstreamNotFound(err) {
  return err instanceof ProviderError && /** @type {ProviderError} */ (err).details?.upstreamStatus === 404;
}

/**
 * Response identity metadata for THIS request (uniform across all three
 * resolution outcomes): the requested primary id always retains ITS OWN
 * namespace field, and the counterpart field is filled ONLY when the
 * counterpart id was genuinely established for this request (the mapping the
 * identity fallback resolved). A null counterpart is honest: "identity was
 * not needed / unresolved", never ring-filled from numeric equality.
 * @param {'anilist'|'mal'} primaryIdType namespace of the request's primary id
 * @param {number} primaryId the request's primary id
 * @param {number|null} counterpartId the other namespace's id (or null)
 * @returns {{ anilistId: number|null, malId: number|null }}
 */
function responseIdentityOf(primaryIdType, primaryId, counterpartId) {
  return {
    anilistId: primaryIdType === ID_TYPES.ANILIST ? primaryId : counterpartId,
    malId: primaryIdType === ID_TYPES.MAL ? primaryId : counterpartId,
  };
}

/**
 * Parse provider expiry metadata (if any) into epoch ms. Accepts ISO date
 * strings or numeric epoch values (seconds or ms); returns null when absent
 * or unparseable.
 * @param {unknown} value
 * @returns {number | null}
 */
function parseExpiryMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export class StreamResolver {
  /**
   * @param {object} [deps]
   * @param {import('../providers/megaplay/megaplay.provider.js').MegaplayProvider} [deps.megaplay]
   * @param {import('../identity/identity-resolver.js').IdentityResolver} [deps.identity]
   * @param {import('../cache/cache-manager.js').CacheManager} [deps.cache]
   * @param {{ isConfigured: () => boolean, buildWatchUrl: (params: object, options?: object) => string }} [deps.proxy]
   *   Playback proxy URL builder (isolated in proxy-playback.js). MegaPlay
   *   resolution/availability stays in the provider; only the frontend-safe
   *   playback URL construction lives here.
   */
  constructor({ megaplay = megaplayProvider, identity = identityResolver, cache = cacheManager, proxy = { isConfigured: isProxyConfigured, buildWatchUrl: buildProxyWatchUrl } } = {}) {
    this.megaplay = megaplay;
    this.identity = identity;
    this.cache = cache;
    this.proxy = proxy;
  }

  /**
   * Resolve a playable stream for an anime episode, AniList-PRIMARY.
   *
   * Legacy entry point (unchanged contract): identical behavior with
   * resolveStreamByAniListId - one code path, no duplicated flow.
   *
   * @param {object} params
   * @param {number|string} params.anilistId  AniList ID (primary identity;
   *   NEVER assumed to be a MAL ID).
   * @param {number|string} [params.episode=1] Positive, bounded episode.
   * @param {'sub'|'dub'} [params.language='sub'] Documented language contract.
   * @returns {Promise<object>} Normalized streaming response
   * @throws {ValidationError} invalid AniList ID/episode/language.
   * @throws {NotFoundError} AniList confirms the anime does not exist (from the
   *   identity layer - never a stream-availability conclusion).
   * @throws {TimeoutError|RateLimitError|ProviderError} on provider failure
   *   (stale-if-error already applied through the cache layer).
   */
  async resolveStream({ anilistId, episode, language } = {}) {
    return this.resolveStreamByAniListId({ anilistId, episode, language });
  }

  /**
   * Resolve a playable stream, AniList-PRIMARY (Server 1).
   *
   * The route id is ALWAYS an AniList ID. MegaPlay is asked DIRECTLY with the
   * AniList ID first (/stream/ani/...); only a genuine no-stream result may
   * trigger the AniList->MAL IdentityResolver fallback. The response's
   * anilistId always mirrors the requested AniList ID; malId comes ONLY from
   * the IdentityResolver (or null) - never guessed, never back-filled.
   *
   * @param {object} params
   * @param {number|string} params.anilistId AniList ID (never a MAL ID).
   * @param {number|string} [params.episode=1] Positive, bounded episode.
   * @param {'sub'|'dub'} [params.language='sub'] Documented language contract.
   * @returns {Promise<object>} Normalized streaming response:
   *   { resolved: true, provider, idType, anilistId, malId, episode, language,
   *     playbackUrl, streams, sources, expiresAt }. playbackUrl is ALWAYS the
   *   frontend-safe proxy watch URL - never a direct MegaPlay URL.
   * @throws {ValidationError} invalid AniList ID/episode/language.
   * @throws {NotFoundError} AniList confirms the anime does not exist (identity
   *   layer - never a stream-availability conclusion).
   * @throws {TimeoutError|RateLimitError|ProviderError} on provider failure
   *   (stale-if-error already applied through the cache layer).
   */
  async resolveStreamByAniListId({ anilistId, episode, language } = {}) {
    const id = normalizeId(anilistId);
    if (id === null) {
      throw new ValidationError('resolveStreamByAniListId requires a valid AniList ID', {
        received: anilistId,
      });
    }
    return this._resolveWithPrimaryFallback(ID_TYPES.ANILIST, id, episode, language);
  }

  /**
   * Resolve a playable stream, MAL-PRIMARY (Server 2).
   *
   * The route id is ALWAYS a MAL ID. MegaPlay is asked DIRECTLY with the MAL ID
   * first (/stream/mal/... via resolveByMalId) - this is NOT the AniList
   * resolver re-badged. Only a genuine no-stream result may trigger the
   * MAL->AniList IdentityResolver fallback, with the RESOLVED AniList ID (the
   * MAL ID is never passed to the AniList provider and vice versa). Identity
   * NotFoundError (no AniList Media for the MAL ID) is a missing mapping,
   * handled gracefully: the fallback is skipped, the PRIMARY (mal) namespace
   * stands (see the class header for the direction asymmetry).
   *
   * @param {object} params
   * @param {number|string} params.malId MAL ID (never an AniList ID).
   * @param {number|string} [params.episode=1] Positive, bounded episode.
   * @param {'sub'|'dub'} [params.language='sub'] Documented language contract.
   * @returns {Promise<object>} Normalized streaming response (same contract as
   *   resolveStreamByAniListId; malId mirrors the requested MAL ID).
   * @throws {ValidationError} invalid MAL ID/episode/language.
   * @throws {TimeoutError|RateLimitError|ProviderError} on provider failure
   *   (stale-if-error already applied through the cache layer).
   */
  async resolveStreamByMalId({ malId, episode, language } = {}) {
    const id = normalizeId(malId);
    if (id === null) {
      throw new ValidationError('resolveStreamByMalId requires a valid MAL ID', {
        received: malId,
      });
    }
    return this._resolveWithPrimaryFallback(ID_TYPES.MAL, id, episode, language);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Shared primary->fallback orchestration for BOTH flows.
   *
   * 1) The PRIMARY namespace is ALWAYS attempted first with its OWN id kind
   *    (anilist -> resolveByAnilistId, mal -> resolveByMalId). A usable stream
   *    is returned immediately - the counterpart lookup never happens, so no
   *    duplicate provider request is made.
   * 2) A genuine no-stream PRIMARY result (never an infrastructure failure) is
   *    the ONLY thing that may consult the IdentityResolver for the
   *    counterpart direction; with an actual mapping, the FALLBACK namespace
   *    is attempted with the RESOLVED counterpart id.
   * 3) When neither direct MegaPlay lookup produced a usable stream, the
   *    PRIMARY namespace of THIS request stands: the proxy is the
   *    browser-facing playback mechanism and handles availability (a direct
   *    410/no-stream is never reinterpreted as "unavailable"). The counterpart
   *    id (when genuinely resolved) rides along as metadata only.
   *
   * @param {'anilist'|'mal'} primaryIdType
   * @param {number} primaryId
   * @param {number|string|undefined} episode
   * @param {unknown} language
   * @returns {Promise<object>}
   * @throws {ValidationError} invalid episode/language (the id was normalized
   *   by the public caller).
   * @throws {NotFoundError} AniList-primary identity cannot confirm the anime
   *   exists (@see resolveStreamByAniListId). @throws
   *   {TimeoutError|RateLimitError|ProviderError} typed provider/identity
   *   failures propagate unchanged.
   */
  async _resolveWithPrimaryFallback(primaryIdType, primaryId, episode, language) {
    const ep = normalizeEpisode(episode);
    const lang = normalizeLanguage(language);

    // 1) PRIMARY namespace with its OWN id kind - always first.
    const primaryResult = await this._lookupStream(primaryIdType, primaryId, ep, lang);
    if (isUsableStreamResult(primaryResult)) {
      return this._toStreamResponse(primaryResult, {
        idType: primaryIdType,
        ...responseIdentityOf(primaryIdType, primaryId, null),
        resolvedId: primaryId, // the primary id was used - primary idType
        episode: ep,
        language: lang,
      });
    }

    // 2) Genuine no-stream result -> cross-namespace fallback through the
    //    IdentityResolver ONLY (a real provider-confirmed mapping in the
    //    direction this flow needs). No title search, no fuzzy matching, no
    //    guessing, no numeric inference in either direction.
    const counterpartId = await this._counterpartId(primaryIdType, primaryId);
    if (counterpartId !== null) {
      const fallbackIdType = primaryIdType === ID_TYPES.ANILIST ? ID_TYPES.MAL : ID_TYPES.ANILIST;
      const fallbackResult = await this._lookupStream(fallbackIdType, counterpartId, ep, lang);
      if (isUsableStreamResult(fallbackResult)) {
        return this._toStreamResponse(fallbackResult, {
          idType: fallbackIdType,
          ...responseIdentityOf(primaryIdType, primaryId, counterpartId),
          resolvedId: counterpartId, // the RESOLVED counterpart was used
          episode: ep,
          language: lang,
        });
      }
    }

    // 3) Neither direct MegaPlay lookup produced a usable stream. A direct
    //    MegaPlay 410 / no-stream response does NOT prove playback is
    //    unavailable: the BROWSER-FACING playback mechanism is the proxy, which
    //    constructs the MegaPlay URL internally and serves the playable iframe
    //    page. The direct lookups above selected the source namespace; the
    //    PRIMARY namespace stands here. The proxy handles availability. The
    //    counterpart id is included only when genuinely resolved by the
    //    IdentityResolver - never guessed, never back-filled.
    return this._toStreamResponse(primaryResult, {
      idType: primaryIdType,
      ...responseIdentityOf(primaryIdType, primaryId, counterpartId),
      resolvedId: primaryId, // the primary id was used - primary idType
      episode: ep,
      language: lang,
    });
  }

  /**
   * Resolve the COUNTERPART id for the primary namespace (the cross-namespace
   * fallback id), through the IdentityResolver for the correct direction.
   *
   * Returns null when the mapping is genuinely unresolved OR when the identity
   * lookup fails with direction-appropriate semantics:
   *   - MAL-primary: identity NotFoundError == "no AniList Media maps to this
   *     MAL ID" - a missing mapping (graceful; the PRIMARY namespace stands).
   *   - AniList-primary: identity NotFoundError propagates (existing documented
   *     behavior - AniList is the canonical identity registry; a nonexistent
   *     AniList ID invalidates the whole request).
   *   - Infrastructure failures (timeout/429/500/network) ALWAYS propagate in
   *     both directions - never reinterpreted as "unresolved".
   *
   * @param {'anilist'|'mal'} primaryIdType
   * @param {number} primaryId
   * @returns {Promise<number|null>} the counterpart id, or null when unresolved.
   */
  async _counterpartId(primaryIdType, primaryId) {
    try {
      const identity =
        primaryIdType === ID_TYPES.ANILIST
          ? await this.identity.resolveAniListToMal(primaryId)
          : await this.identity.resolveMalToAniList(primaryId);
      if (!identity.resolved) return null;
      return primaryIdType === ID_TYPES.ANILIST ? identity.malId : identity.anilistId;
    } catch (err) {
      if (primaryIdType === ID_TYPES.MAL && err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * One MegaPlay lookup (by id kind) with cache/stale-if-error semantics.
   *
   * Cache flow: fresh usable stream -> return; cache miss -> MegaPlay ->
   * valid stream -> cache -> return; provider failure -> stale usable stream
   * if available (CacheManager), else the typed failure propagates.
   *
   * A genuine no-stream outcome (explicit no-stream response, empty sources,
   * malformed payload, or a genuine MegaPlay 404) is returned as a
   * `usable: false` result - it may trigger the MAL fallback and is cached
   * only briefly with clearly distinguishable semantics. Infrastructure
   * failures (timeout/429/500/network) are NEVER cached or reinterpreted.
   *
   * @param {'anilist'|'mal'} idType
   * @param {number} id
   * @param {number} episode
   * @param {'sub'|'dub'} language
   * @returns {Promise<import('../normalizers/megaplay-normalizer.js').MegaplayStreamResult>}
   */
  async _lookupStream(idType, id, episode, language) {
    const key = streamCacheKey(idType, id, episode, language);
    try {
      const result = await this.cache.getOrLoad(
        key,
        () => this._fetchAndNormalize(idType, id, episode, language),
        { ttlSeconds: STREAM_CACHE_TTL.STREAM, isValid: isUsableStreamResult },
      );

      if (isUsableStreamResult(result)) {
        // Respect explicit provider expiry metadata when practical: cap the
        // cache TTL so a stream is never cached past its declared lifetime.
        // Deliberate overwrite through the cache abstraction (never L1
        // internals), only after a successful provider response.
        if (result.expiresAt !== null && result.expiresAt !== undefined) {
          const cappedTtl = this._ttlForStream(result);
          if (cappedTtl !== STREAM_CACHE_TTL.STREAM) {
            await this.cache.set(key, result, cappedTtl);
          }
        }
        return result;
      }

      // Fresh genuine no-stream response (provider answered; no usable stream,
      // and no stale data existed). Cache it briefly with `usable: false`
      // semantics so repeat requests skip the provider without poisoning the
      // cache - it is clearly distinguishable from a real stream and from a
      // provider failure (which is never cached).
      await this.cache.set(key, result, STREAM_CACHE_TTL.NO_RESULT);
      return result;
    } catch (err) {
      if (isUpstreamNotFound(err)) {
        // Genuine MegaPlay 404 on this endpoint: no stream page exists for
        // this id (Case D). If stale data had existed, the CacheManager would
        // already have served it (stale-if-error) and we would not be here.
        /** @type {import('../normalizers/megaplay-normalizer.js').MegaplayStreamResult} */
        const marker = { usable: false, sources: [], reason: 'not_found', episode: null, expiresAt: null };
        await this.cache.set(key, marker, STREAM_CACHE_TTL.NO_RESULT);
        return marker;
      }
      // timeout/429/500/network: typed provider failure (Case C). Stale-if-
      // error already applied through the cache layer; propagate as-is so the
      // handler preserves the real failure semantics. NEVER reinterpreted as
      // "anime not found", NEVER cached.
      throw err;
    }
  }

  /**
   * Call the MegaPlay provider for one id kind and normalize the RAW response.
   * All response parsing stays in the MegaPlay normalizer (single place to
   * adjust when the exact live response schema is confirmed).
   * @param {'anilist'|'mal'} idType
   * @param {number} id
   * @param {number} episode
   * @param {'sub'|'dub'} language
   * @returns {Promise<import('../normalizers/megaplay-normalizer.js').MegaplayStreamResult>}
   */
  async _fetchAndNormalize(idType, id, episode, language) {
    const raw =
      idType === ID_TYPES.ANILIST
        ? await this.megaplay.resolveByAnilistId(id, { episode, language })
        : await this.megaplay.resolveByMalId(id, { episode, language });
    return normalizeMegaplayStreamResponse(raw);
  }

  /**
   * Cache TTL for a valid stream result: a conservative SHORT TTL, capped by
   * explicit provider expiry metadata when present and parseable.
   * @param {import('../normalizers/megaplay-normalizer.js').MegaplayStreamResult} result
   * @returns {number} seconds (>= 1)
   */
  _ttlForStream(result) {
    const expiryMs = parseExpiryMs(result.expiresAt);
    if (expiryMs === null) return STREAM_CACHE_TTL.STREAM;
    const secondsUntilExpiry = Math.floor((expiryMs - Date.now()) / 1000);
    if (secondsUntilExpiry <= 0) return 1; // already expired: do not retain
    return Math.min(STREAM_CACHE_TTL.STREAM, secondsUntilExpiry);
  }

  /**
   * Build the normalized streaming response expected by the frontend. Identity
   * metadata comes ONLY from actual resolution and is computed by the
   * orchestrator (responseIdentityOf): the winning namespace's id mirrors the
   * request's id in THAT namespace; the other id comes only from the
   * IdentityResolver (or is null). No MegaPlay internal id is ever exposed as
   * an AniList/MAL ID.
   *
   * Playback: DIRECT MegaPlay URLs are NEVER exposed to the frontend. When
   * the playback proxy is configured, the frontend-safe playback URL is
   * `{MEGAPLAY_PROXY_URL}/watch/{resolvedId}?ep={episode}&lang={language}&idType={idType}`
   * (built by the isolated proxy-playback module from the ALREADY-RESOLVED
   * id/episode/language - the correct namespace at every step). When the
   * proxy is NOT configured, a clear typed configuration error is thrown
   * instead of silently exposing a direct MegaPlay URL.
   *
   * @param {import('../normalizers/megaplay-normalizer.js').MegaplayStreamResult} result
   * @param {{ idType: 'anilist'|'mal', anilistId: number, malId: number|null, resolvedId: number, episode: number, language: 'sub'|'dub' }} identity
   * @returns {object}
   */
  _toStreamResponse(result, { idType, anilistId, malId, resolvedId, episode, language }) {
    // Configuration state first: when the playback proxy is not configured, a
    // clear typed configuration error is thrown - a direct MegaPlay URL is
    // NEVER silently exposed to the frontend.
    if (!this.proxy.isConfigured()) {
      throw new NotImplementedError(
        'Playback requires the MegaPlay proxy, but MEGAPLAY_PROXY_URL is not configured',
        { proxyConfigured: false, reason: 'proxy_not_configured' },
      );
    }
    const playbackUrl = this.proxy.buildWatchUrl(
      { idType, id: resolvedId, episode, language },
    );
    // Frontend-safe: proxy watch URLs only - never a direct MegaPlay
    // playback/stream URL. Both languages are exposed for the SAME resolved
    // identity (idType + resolvedId mirror playbackUrl); the proxy handles
    // availability for the language that was not requested.
    const altLanguage = language === STREAM_LANGUAGES.SUB ? STREAM_LANGUAGES.DUB : STREAM_LANGUAGES.SUB;
    const altPlaybackUrl = this.proxy.buildWatchUrl(
      { idType, id: resolvedId, episode, language: altLanguage },
    );
    return {
      resolved: true,
      provider: PROVIDERS.MEGAPLAY,
      idType,
      anilistId,
      malId,
      episode,
      language,
      playbackUrl,
      streams: {
        [language]: { url: playbackUrl, type: 'proxy', language },
        [altLanguage]: { url: altPlaybackUrl, type: 'proxy', language: altLanguage },
      },
      sources: [
        { url: playbackUrl, type: 'proxy', language },
        { url: altPlaybackUrl, type: 'proxy', language: altLanguage },
      ],
      expiresAt: result.expiresAt ?? null,
    };
  }
}

/** Default shared stream resolver instance. */
export const streamResolver = new StreamResolver();
