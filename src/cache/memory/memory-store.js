/**
 * MemoryStore - L1 cache backend (in-memory, per-instance).
 *
 * This is a genuine but intentionally small implementation: a Map with expiry
 * metadata and a size cap. It is a PERFORMANCE OPTIMIZATION ONLY.
 *
 * Hard rules it respects:
 *   - It is ephemeral. A cold start / new serverless instance starts empty, and
 *     the application must remain correct with an empty L1 (correctness comes
 *     from L2 + providers, never from L1).
 *   - It retains expired entries (up to the size cap) so the CacheManager can
 *     serve stale-if-error. Freshness is decided by the manager, not here.
 *   - A bounded size (FIFO eviction of the oldest key) prevents unbounded
 *     memory growth in a long-lived instance.
 */

import { CacheStore, makeEntry, DEFAULT_STALE_WINDOW_SECONDS } from '../cache-store.js';

const DEFAULT_MAX_ENTRIES = 1000;

export class MemoryStore extends CacheStore {
  /**
   * @param {{ maxEntries?: number, staleWindowSeconds?: number }} [options]
   */
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, staleWindowSeconds } = {}) {
    super('memory');
    /** @type {Map<string, import('../cache-store.js').CacheEntry<unknown>>} */
    this._map = new Map();
    this._maxEntries = maxEntries;
    this._staleWindowSeconds = staleWindowSeconds ?? DEFAULT_STALE_WINDOW_SECONDS;
  }

  /**
   * @template T
   * @param {string} key
   * @returns {Promise<import('../cache-store.js').CacheEntry<T> | null>}
   */
  async get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    // Refresh LRU-ish recency so hot keys survive eviction longer.
    this._map.delete(key);
    this._map.set(key, entry);
    return /** @type {import('../cache-store.js').CacheEntry<T>} */ (entry);
  }

  /**
   * @template T
   * @param {string} key
   * @param {T} value
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  async set(key, value, ttlSeconds) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, makeEntry(value, ttlSeconds, Date.now(), this._staleWindowSeconds));
    this._evictIfNeeded();
  }

  /** @param {string} key @returns {Promise<void>} */
  async delete(key) {
    this._map.delete(key);
  }

  /** @returns {Promise<void>} */
  async clear() {
    this._map.clear();
  }

  /** Current number of stored entries (fresh + retained stale). */
  get size() {
    return this._map.size;
  }

  /** Evict oldest entries until within the size cap. */
  _evictIfNeeded() {
    while (this._map.size > this._maxEntries) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey === undefined) break;
      this._map.delete(oldestKey);
    }
  }
}
