/**
 * CacheStore - the storage interface every cache backend implements.
 *
 * Two backends are planned:
 *   - L1: in-memory (fast, per-instance, ephemeral)      -> memory/memory-store.js
 *   - L2: Supabase (persistent, shared across instances)  -> supabase/supabase-store.js
 *
 * DESIGN CONTRACT (important for stale-if-error):
 *   A store returns the FULL entry (including expiry metadata) and does NOT
 *   delete entries the moment they expire. Deciding whether an entry is "fresh"
 *   or "stale but usable" is the CacheManager's job, not the store's. This is
 *   what lets us serve stale data when a provider is down instead of returning
 *   empty results.
 *
 * A store `get` returning `null` means MISS. It must never throw for a plain
 * miss; genuine backend failures should throw CacheError so the manager can
 * treat them as a miss and continue to the provider.
 */

/**
 * @template T
 * @typedef {Object} CacheEntry
 * @property {T} value            The cached value (already normalized data).
 * @property {number} storedAt    Epoch ms when the value was written.
 * @property {number} expiresAt   Epoch ms after which the entry is stale.
 * @property {number} ttlSeconds  TTL used when the entry was written.
 * @property {number | null} staleUntil  Epoch ms until which a STALE entry is
 *   still usable for stale-if-error. Null means no stale-window limit.
 */

/**
 * Abstract base. Concrete stores must override every method.
 * @abstract
 */
export class CacheStore {
  /** @param {string} name Identifier used in logs (e.g. "memory", "supabase"). */
  constructor(name) {
    this.name = name;
  }

  /**
   * @template T
   * @param {string} _key
   * @returns {Promise<CacheEntry<T> | null>} Entry (fresh OR stale) or null on miss.
   */
  async get(_key) {
    throw new Error(`${this.name}: get() not implemented`);
  }

  /**
   * @template T
   * @param {string} _key
   * @param {T} _value
   * @param {number} _ttlSeconds
   * @returns {Promise<void>}
   */
  async set(_key, _value, _ttlSeconds) {
    throw new Error(`${this.name}: set() not implemented`);
  }

  /**
   * @param {string} _key
   * @returns {Promise<void>}
   */
  async delete(_key) {
    throw new Error(`${this.name}: delete() not implemented`);
  }

  /**
   * @returns {Promise<void>}
   */
  async clear() {
    throw new Error(`${this.name}: clear() not implemented`);
  }
}

/**
 * Default stale-if-error window (seconds) applied to new entries when the
 * store is not configured with an explicit one. Entries are fresh until
 * `expiresAt`, then remain usable-for-stale-if-error until `staleUntil`.
 */
export const DEFAULT_STALE_WINDOW_SECONDS = 86_400; // 24 hours

/**
 * Helper to construct a well-formed CacheEntry.
 * @template T
 * @param {T} value
 * @param {number} ttlSeconds
 * @param {number} [now=Date.now()]
 * @param {number} [staleWindowSeconds=DEFAULT_STALE_WINDOW_SECONDS]
 * @returns {CacheEntry<T>}
 */
export function makeEntry(value, ttlSeconds, now = Date.now(), staleWindowSeconds = DEFAULT_STALE_WINDOW_SECONDS) {
  return {
    value,
    storedAt: now,
    expiresAt: now + ttlSeconds * 1000,
    ttlSeconds,
    staleUntil: now + (ttlSeconds + staleWindowSeconds) * 1000,
  };
}

/**
 * Whether a STALE entry (past its fresh expiry) is still usable for
 * stale-if-error. A stale entry is usable until its `staleUntil` instant;
 * null/undefined staleUntil means no limit (legacy entries).
 *
 * The CacheManager calls this ONLY when the provider operation failed - stale
 * data is never the normal answer when a fresh provider/cache result exists.
 * @param {CacheEntry<unknown>} entry
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isStaleUsable(entry, now = Date.now()) {
  if (!entry) return false;
  if (entry.expiresAt > now) return false; // not stale (fresh or handled elsewhere)
  return entry.staleUntil === null || entry.staleUntil === undefined || entry.staleUntil > now;
}
