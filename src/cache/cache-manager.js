/**
 * CacheManager - orchestrates the two-tier (L1 + L2) cache and the resilience
 * strategy the whole backend depends on.
 *
 * Read/refresh flow implemented by `getOrLoad`:
 *
 *   1. L1 fresh?            -> return immediately.
 *   2. L2 fresh? (if enabled)-> promote into L1, return.
 *   3. Otherwise load via provider (coalesced so concurrent callers share one
 *      request):
 *        - success + valid   -> write L1 (+ L2), return.
 *        - failure OR invalid -> serve STALE data (L1 then L2) if available.
 *        - nothing stale      -> only then propagate the error.
 *
 * HARD RULES enforced here:
 *   - NEVER cache provider failures or invalid/empty responses as if they were
 *     valid data. A failing loader leaves existing (stale) data untouched.
 *   - L1 is treated purely as a fast, ephemeral optimization. Correctness never
 *     depends on it: with an empty L1 the manager transparently falls back to
 *     L2 and/or the provider.
 *   - L2 (Supabase) is optional at runtime. When it is not configured (Phase 1)
 *     the manager runs L1-only and the app still works.
 *
 * PHASE 1 SCOPE: L1 is a real in-memory store, coalescing is real, and the
 * fresh/stale/stale-if-error decision logic is real. L2 is wired in but
 * DISABLED until the Supabase phase implements SupabaseStore (its methods throw
 * NotImplementedError, and `isConfigured()` returns false without env vars).
 */

import { MemoryStore } from './memory/memory-store.js';
import { SupabaseStore } from './supabase/supabase-store.js';
import { RequestCoalescer } from './request-coalescer.js';
import { isStaleUsable } from './cache-store.js';
import { config } from '../config/env.js';
import { CACHE_STATE } from '../config/constants.js';
import { logger as rootLogger } from '../utils/logger.js';

export class CacheManager {
  /**
   * @param {object} [deps]
   * @param {import('./cache-store.js').CacheStore} [deps.l1]
   * @param {(SupabaseStore | import('./cache-store.js').CacheStore) | null} [deps.l2]
   * @param {RequestCoalescer} [deps.coalescer]
   * @param {number} [deps.defaultTtlSeconds]
   */
  constructor({ l1, l2, coalescer, defaultTtlSeconds } = {}) {
    this.l1 = l1 ?? new MemoryStore();
    this.l2 = l2 ?? new SupabaseStore();
    this.coalescer = coalescer ?? new RequestCoalescer();
    this.defaultTtlSeconds = defaultTtlSeconds ?? config.CACHE_DEFAULT_TTL_SECONDS;
    this.log = rootLogger.child({ component: 'cache' });
  }

  /**
   * Read a FRESH value only (no provider load). Returns null on miss/stale.
   * @template T
   * @param {string} key
   * @returns {Promise<T | null>}
   */
  async get(key) {
    const l1 = await this._safeGet(this.l1, key);
    if (l1 && this._isFresh(l1)) {
      this.log.debug('cache.hit', { key, layer: 'L1', state: CACHE_STATE.FRESH });
      return /** @type {T} */ (l1.value);
    }

    if (this._l2Enabled()) {
      const l2 = await this._safeGet(this.l2, key);
      if (l2 && this._isFresh(l2)) {
        this.log.debug('cache.hit', { key, layer: 'L2', state: CACHE_STATE.FRESH });
        await this._safeSet(this.l1, key, l2.value, this._remainingTtl(l2));
        return /** @type {T} */ (l2.value);
      }
    }

    this.log.debug('cache.miss', { key, state: CACHE_STATE.MISS });
    return null;
  }

  /**
   * Write a value to L1 (+ L2 when enabled).
   * @template T
   * @param {string} key
   * @param {T} value
   * @param {number} [ttlSeconds]
   * @returns {Promise<void>}
   */
  async set(key, value, ttlSeconds = this.defaultTtlSeconds) {
    await this._safeSet(this.l1, key, value, ttlSeconds);
    if (this._l2Enabled()) await this._safeSet(this.l2, key, value, ttlSeconds);
  }

  /**
   * Get-or-load with fresh/stale/stale-if-error semantics and coalescing.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} loader Provider call producing fresh data.
   * @param {object} [options]
   * @param {number} [options.ttlSeconds]
   * @param {boolean} [options.staleIfError=true] Serve stale data if loader fails.
   * @param {(value: T) => boolean} [options.isValid] Reject bad responses so they
   *   are never cached (defaults to "not null/undefined"). Use this to avoid
   *   caching empty/garbage payloads.
   * @returns {Promise<T>}
   */
  async getOrLoad(key, loader, { ttlSeconds = this.defaultTtlSeconds, staleIfError = true, isValid } = {}) {
    // 1) Fresh L1.
    const l1Entry = await this._safeGet(this.l1, key);
    if (l1Entry && this._isFresh(l1Entry)) {
      this.log.debug('cache.hit', { key, layer: 'L1', state: CACHE_STATE.FRESH });
      return /** @type {T} */ (l1Entry.value);
    }

    // 2) Fresh L2 (if enabled) -> promote to L1.
    let l2Entry = null;
    if (this._l2Enabled()) {
      l2Entry = await this._safeGet(this.l2, key);
      if (l2Entry && this._isFresh(l2Entry)) {
        this.log.debug('cache.hit', { key, layer: 'L2', state: CACHE_STATE.FRESH });
        await this._safeSet(this.l1, key, l2Entry.value, this._remainingTtl(l2Entry));
        return /** @type {T} */ (l2Entry.value);
      }
    }

    // 3) Load from provider, coalesced across concurrent callers.
    try {
      const value = await this.coalescer.run(key, loader);
      const valid = isValid ? isValid(value) : value !== null && value !== undefined;
      if (!valid) {
        // Bad/empty response: DO NOT cache it. Prefer stale data if we have it.
        this.log.warn('cache.invalidResponse', { key });
        const stale = this._pickStale(l1Entry, l2Entry);
        if (staleIfError && stale) return /** @type {T} */ (stale.value);
        return value; // no stale available: return as-is, still uncached.
      }

      await this.set(key, value, ttlSeconds);
      this.log.debug('cache.fill', { key, ttlSeconds });
      return value;
    } catch (err) {
      // Provider/loader failed. Serve stale data instead of an empty response.
      if (staleIfError) {
        const stale = this._pickStale(l1Entry, l2Entry);
        if (stale) {
          this.log.warn('cache.staleIfError', { key, state: CACHE_STATE.STALE, err });
          return /** @type {T} */ (stale.value);
        }
      }
      // Nothing to fall back to: propagate so the service/handler decides.
      throw err;
    }
  }

  /**
   * Invalidate a key across both layers.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async invalidate(key) {
    await this._safeDelete(this.l1, key);
    if (this._l2Enabled()) await this._safeDelete(this.l2, key);
  }

  // --- internals ------------------------------------------------------------

  /** @param {import('./cache-store.js').CacheEntry<unknown>} entry */
  _isFresh(entry) {
    return entry.expiresAt > Date.now();
  }

  /** @param {import('./cache-store.js').CacheEntry<unknown>} entry */
  _remainingTtl(entry) {
    return Math.max(1, Math.round((entry.expiresAt - Date.now()) / 1000));
  }

  /**
   * Choose the best available STALE-USABLE entry (prefer the fresher of L1/L2).
   * Entries past their stale_until window are never served, and stale data is
   * only ever used when the provider operation failed - never as the normal
   * answer when a fresh provider/cache result is available.
   * @param {import('./cache-store.js').CacheEntry<unknown> | null} a
   * @param {import('./cache-store.js').CacheEntry<unknown> | null} b
   */
  _pickStale(a, b) {
    const usableA = a && isStaleUsable(a) ? a : null;
    const usableB = b && isStaleUsable(b) ? b : null;
    if (usableA && usableB) return usableA.storedAt >= usableB.storedAt ? usableA : usableB;
    return usableA ?? usableB;
  }

  /** L2 is usable only when it's a configured Supabase store. */
  _l2Enabled() {
    return this.l2 && (typeof this.l2.isConfigured !== 'function' || this.l2.isConfigured());
  }

  /**
   * Store access wrappers: a cache backend failure must degrade gracefully to a
   * miss/no-op, never crash the request. (This is why an unimplemented L2 in
   * Phase 1 is harmless.)
   */
  async _safeGet(store, key) {
    try {
      return await store.get(key);
    } catch (err) {
      this.log.warn('cache.getError', { key, layer: store?.name, err });
      return null;
    }
  }

  async _safeSet(store, key, value, ttlSeconds) {
    try {
      await store.set(key, value, ttlSeconds);
    } catch (err) {
      this.log.warn('cache.setError', { key, layer: store?.name, err });
    }
  }

  async _safeDelete(store, key) {
    try {
      await store.delete(key);
    } catch (err) {
      this.log.warn('cache.deleteError', { key, layer: store?.name, err });
    }
  }
}

/**
 * Default process-wide cache manager (L1 memory + L2 Supabase stub + coalescer).
 * Services import this instance. In Phase 1 it operates L1-only because Supabase
 * is not configured.
 */
export const cacheManager = new CacheManager();
