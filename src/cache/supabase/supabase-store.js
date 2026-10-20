/**
 * SupabaseStore - L2 cache backend (persistent, shared across instances).
 *
 * Conforms to the Phase 1 CacheStore interface (get/set/delete/clear) - the
 * CacheManager retains ALL responsibility for fresh/stale decisions; this store
 * returns FULL entries (including expiry metadata) and does NOT delete entries
 * the moment they expire.
 *
 * DESIGN CONTRACT (unchanged from Phase 1):
 *   - `get` returning null means MISS. Freshness/stale-usability is decided by
 *     the CacheManager, not here.
 *   - Namespace/key separation is preserved: the full cache key (e.g.
 *     `anilist:anime:123`) is split at the FIRST colon into an explicit
 *     namespace (e.g. `anilist`) and cache_key (e.g. `anime:123`). A numeric
 *     ID equal across providers does NOT mean the entities are equal - the
 *     namespace column keeps them isolated (unique index in the DB).
 *   - Values are normalized application data stored as PostgreSQL jsonb -
 *     never raw provider HTTP responses, never secrets.
 *   - Atomic upserts against the unique (namespace, cache_key) identity
 *     (PostgREST merge-duplicates) so concurrent serverless instances can
 *     populate the same key safely.
 *
 * Serverless safety:
 *   - No long-running workers, no setInterval, no filesystem persistence.
 *     Expired rows are handled lazily during reads; an optional SQL cleanup
 *     function exists in the migration for rare manual use.
 *   - Uses the shared HTTP abstraction (no second HTTP client).
 *
 * Configuration: from environment (config.SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY, falling back to SUPABASE_ANON_KEY). The
 * service-role key stays server-side, is never exposed in responses, never
 * logged, never hardcoded. When Supabase is NOT configured, `isConfigured()`
 * returns false and the CacheManager runs L1-only - a missing configuration is
 * never treated as a provider failure.
 *
 * Failure behavior: Supabase failures surface as CacheError and the
 * CacheManager degrades gracefully (continue with L1/provider). A Supabase
 * outage never becomes an AniList/Jikan/TMDB outage.
 */

import { CacheStore, makeEntry, DEFAULT_STALE_WINDOW_SECONDS } from '../cache-store.js';
import { config } from '../../config/env.js';
import { CacheError } from '../../errors/index.js';
import { SupabaseRestClient } from './supabase-client.js';

export class SupabaseStore extends CacheStore {
  /**
   * @param {object} [options]
   * @param {string} [options.url] Overrides config.SUPABASE_URL (tests).
   * @param {string} [options.apiKey] Overrides the configured keys (tests).
   * @param {number} [options.staleWindowSeconds] Stale-if-error window applied
   *   to new entries (defaults to the shared 24h default).
   * @param {number} [options.timeoutMs] Overrides the default request timeout.
   */
  constructor({ url, apiKey, staleWindowSeconds, timeoutMs } = {}) {
    super('supabase');
    this._url = url !== undefined ? url : config.SUPABASE_URL;
    this._apiKey =
      apiKey !== undefined ? apiKey : config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_ANON_KEY;
    this._staleWindowSeconds = staleWindowSeconds ?? DEFAULT_STALE_WINDOW_SECONDS;
    this._timeoutMs = timeoutMs;
  }

  /**
   * Whether L2 has the configuration needed to operate. When false, the cache
   * manager simply skips L2 and uses L1 + providers.
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this._url && this._apiKey);
  }

  /**
   * Split a full cache key into an explicit namespace + cache_key at the FIRST
   * colon. Preserves namespace/key separation so cross-provider numeric-ID
   * collisions are impossible:
   *   anilist:anime:123       -> namespace "anilist", cache_key "anime:123"
   *   jikan:anime:123         -> namespace "jikan",  cache_key "anime:123"
   *   tmdb:visual:v2:anilist:123 -> namespace "tmdb", cache_key "visual:v2:anilist:123"
   * @param {string} key
   * @returns {{ namespace: string, cacheKey: string }}
   */
  _splitKey(key) {
    const index = key.indexOf(':');
    if (index === -1) {
      return { namespace: 'default', cacheKey: key };
    }
    return { namespace: key.slice(0, index), cacheKey: key.slice(index + 1) };
  }

  /**
   * @template T
   * @param {string} key
   * @returns {Promise<import('../cache-store.js').CacheEntry<T> | null>}
   *   The FULL entry (fresh OR stale OR expired) or null on miss. Freshness is
   *   the CacheManager's decision.
   */
  async get(key) {
    this._assertConfigured();
    const { namespace, cacheKey } = this._splitKey(key);
    try {
      const rows = await this._client().select({ namespace, cache_key: cacheKey });
      const row = Array.isArray(rows) ? rows[0] : null;
      return this._rowToEntry(row);
    } catch (err) {
      throw this._wrapError('Supabase cache read failed', err);
    }
  }

  /**
   * Atomic upsert. NEVER called for provider failures by the CacheManager.
   * @template T
   * @param {string} key
   * @param {T} value
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  async set(key, value, ttlSeconds) {
    this._assertConfigured();
    const { namespace, cacheKey } = this._splitKey(key);
    const now = Date.now();
    // created_at is omitted: column default applies on insert and the existing
    // value is preserved on conflict. updated_at is set on every upsert.
    const entry = makeEntry(value, ttlSeconds, now, this._staleWindowSeconds);
    try {
      await this._client().upsert({
        namespace,
        cache_key: cacheKey,
        value,
        ttl_seconds: ttlSeconds,
        expires_at: new Date(entry.expiresAt).toISOString(),
        stale_until: new Date(entry.staleUntil).toISOString(),
        updated_at: new Date(now).toISOString(),
      });
    } catch (err) {
      throw this._wrapError('Supabase cache write failed', err);
    }
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    this._assertConfigured();
    const { namespace, cacheKey } = this._splitKey(key);
    try {
      await this._client().delete({ namespace, cache_key: cacheKey });
    } catch (err) {
      throw this._wrapError('Supabase cache delete failed', err);
    }
  }

  /**
   * Delete ALL rows from the cache table (use with care - cache only).
   * @returns {Promise<void>}
   */
  async clear() {
    this._assertConfigured();
    try {
      await this._client().deleteAll();
    } catch (err) {
      throw this._wrapError('Supabase cache clear failed', err);
    }
  }

  // --- internals ------------------------------------------------------------

  /** Lazily construct the REST client (cheap; keeps construction side-effect free). */
  _client() {
    if (!this._restClient) {
      this._restClient = new SupabaseRestClient({
        url: this._url,
        apiKey: this._apiKey,
        timeoutMs: this._timeoutMs,
      });
    }
    return this._restClient;
  }

  /**
   * Map a database row to a CacheEntry. Returns null for unusable/malformed
   * rows (missing value, unparseable expiry) - the manager treats it as a miss
   * and continues to the provider.
   * @param {unknown} row
   * @returns {import('../cache-store.js').CacheEntry<unknown> | null}
   */
  _rowToEntry(row) {
    if (!row || typeof row !== 'object') return null;
    const value = row.value;
    if (value === undefined || value === null) return null;

    const expiresAt = Date.parse(/** @type {string} */ (row.expires_at));
    if (!Number.isFinite(expiresAt)) return null;

    const storedAt = Date.parse(/** @type {string} */ (row.created_at)) || Date.now();
    const ttlSecondsRaw = Number(row.ttl_seconds);
    const staleUntilRaw = row.stale_until ? Date.parse(/** @type {string} */ (row.stale_until)) : null;

    return {
      value,
      storedAt,
      expiresAt,
      ttlSeconds: Number.isFinite(ttlSecondsRaw)
        ? ttlSecondsRaw
        : Math.max(1, Math.round((expiresAt - storedAt) / 1000)),
      staleUntil: Number.isFinite(staleUntilRaw) ? staleUntilRaw : null,
    };
  }

  /** @throws {CacheError} when Supabase is not configured. */
  _assertConfigured() {
    if (!this.isConfigured()) {
      throw new CacheError('Supabase is not configured (set SUPABASE_URL and a key)', { layer: 'L2' });
    }
  }

  /**
   * Wrap any failure into a typed CacheError. The credential is never included
   * in messages or details. Cache errors are degradation signals for the
   * CacheManager (continue with L1/provider), never source-of-truth failures.
   * @param {string} message
   * @param {unknown} err
   * @returns {CacheError}
   */
  _wrapError(message, err) {
    if (err instanceof CacheError) return err;
    return new CacheError(message, {
      layer: 'L2',
      cause: err instanceof Error ? err : undefined,
      details: { provider: 'supabase' },
    });
  }
}
