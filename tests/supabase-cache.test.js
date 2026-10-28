/**
 * Supabase L2 cache tests - schema/config, store behavior, CacheManager
 * integration, and namespace safety. All HTTP is MOCKED; no real Supabase
 * project is required for `npm test`.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { SupabaseStore } = await import('../src/cache/supabase/supabase-store.js');
const { SupabaseRestClient } = await import('../src/cache/supabase/supabase-client.js');
const { CacheManager } = await import('../src/cache/cache-manager.js');
const { MemoryStore } = await import('../src/cache/memory/memory-store.js');
const { RequestCoalescer } = await import('../src/cache/request-coalescer.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const { CacheError } = await import('../src/errors/index.js');

const TEST_URL = 'https://test-project.supabase.co';
const TEST_KEY = 'test-service-role-key';

const buildStore = (over = {}) => new SupabaseStore({ url: TEST_URL, apiKey: TEST_KEY, ...over });

/** A well-formed DB row for `key` with controllable expiry/stale instants. */
function makeRow(key, value, { ttlSeconds = 300, freshMs = 60_000, staleMs = 86_400_000, now = Date.now(), omit } = {}) {
  const row = {
    namespace: key.includes(':') ? key.slice(0, key.indexOf(':')) : 'default',
    cache_key: key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
    value,
    ttl_seconds: ttlSeconds,
    created_at: new Date(now - 1000).toISOString(),
    updated_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now - 1000 + freshMs).toISOString(),
    stale_until: new Date(now - 1000 + freshMs + staleMs).toISOString(),
  };
  for (const field of omit ?? []) delete row[field];
  return row;
}

// --- Config -------------------------------------------------------------------

test('config: valid configuration -> isConfigured true', () => {
  assert.equal(buildStore().isConfigured(), true);
});

test('config: missing configuration -> isConfigured false; operations fail with clear CacheError', async () => {
  assert.equal(new SupabaseStore({ url: '', apiKey: '' }).isConfigured(), false);
  assert.equal(new SupabaseStore({ url: TEST_URL, apiKey: '' }).isConfigured(), false);
  assert.equal(new SupabaseStore({ url: '', apiKey: TEST_KEY }).isConfigured(), false);

  const store = new SupabaseStore({ url: '', apiKey: '' });
  await assert.rejects(() => store.get('anilist:anime:1'), CacheError);
});

test('config: service-role credential stays server-side and never appears in URLs', async () => {
  const mock = installMockFetch(() => jsonResponse([]));
  try {
    const store = buildStore();
    await store.get('anilist:anime:1');
    // The key is sent ONLY via headers - never in the URL.
    assert.equal(mock.calls[0].url.includes(TEST_KEY), false);
    assert.equal(mock.calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(mock.calls[0].init.headers.apikey, TEST_KEY);
  } finally {
    mock.restore();
  }
});

test('config: credential never leaked in error messages or details', async () => {
  const mock = installMockFetch(() => jsonResponse({ message: 'boom' }, 500));
  try {
    const store = buildStore();
    const err = await store.get('anilist:anime:1').then(
      () => { throw new Error('should have thrown'); },
      (e) => e,
    );
    assert.ok(err instanceof CacheError);
    assert.equal(JSON.stringify(err).includes(TEST_KEY), false);
    assert.equal(JSON.stringify(err.toResponse()).includes(TEST_KEY), false);
  } finally {
    mock.restore();
  }
});

// --- Store behavior --------------------------------------------------------------

test('store get miss -> null', async () => {
  const mock = installMockFetch(() => jsonResponse([]));
  try {
    assert.equal(await buildStore().get('anilist:anime:123'), null);
    assert.ok(mock.calls[0].url.includes('/rest/v1/cache_entries?'));
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get('namespace'), 'eq.anilist');
    assert.equal(url.searchParams.get('cache_key'), 'eq.anime:123');
  } finally {
    mock.restore();
  }
});

test('store get hit -> full CacheEntry with value/storedAt/expiresAt/staleUntil', async () => {
  const row = makeRow('anilist:anime:123', { hello: 'world' });
  const mock = installMockFetch(() => jsonResponse([row]));
  try {
    const entry = await buildStore().get('anilist:anime:123');
    assert.equal(entry.value.hello, 'world'); // jsonb -> JS object
    assert.equal(typeof entry.storedAt, 'number');
    assert.equal(entry.expiresAt, Date.parse(row.expires_at));
    assert.equal(entry.staleUntil, Date.parse(row.stale_until));
    assert.equal(entry.ttlSeconds, 300);
  } finally {
    mock.restore();
  }
});

test('store returns STALE entries (freshness is the CacheManager decision)', async () => {
  const row = makeRow('anilist:anime:123', 'stale-data', { freshMs: -10_000, staleMs: 60_000_000 });
  const mock = installMockFetch(() => jsonResponse([row]));
  try {
    const entry = await buildStore().get('anilist:anime:123');
    assert.equal(entry.value, 'stale-data'); // full entry, not silently deleted
  } finally {
    mock.restore();
  }
});

test('store returns EXPIRED entries too (stale window handled by CacheManager)', async () => {
  const row = makeRow('anilist:anime:123', 'expired-data', { freshMs: -10_000, staleMs: -5_000 });
  const mock = installMockFetch(() => jsonResponse([row]));
  try {
    const entry = await buildStore().get('anilist:anime:123');
    assert.equal(entry.value, 'expired-data');
    assert.equal(entry.staleUntil < Date.now(), true); // manager will reject it
  } finally {
    mock.restore();
  }
});

test('store malformed rows -> null (missing value, unparseable expiry)', async () => {
  const mock = installMockFetch((call, index) =>
    jsonResponse([index === 1 ? makeRow('anilist:anime:123', 'x', { omit: ['value'] }) : makeRow('anilist:anime:123', 'x', { omit: ['expires_at'] })]),
  );
  try {
    const store = buildStore();
    assert.equal(await store.get('anilist:anime:123'), null); // missing value
    assert.equal(await store.get('anilist:anime:123'), null); // unparseable expiry
  } finally {
    mock.restore();
  }
});

test('store malformed database response (non-array) -> CacheError (degraded by manager)', async () => {
  const mock = installMockFetch(() => jsonResponse({ unexpected: true }));
  try {
    // A malformed response is a Supabase failure signal: the store surfaces it
    // as a typed CacheError, and the CacheManager degrades to L1/provider.
    await assert.rejects(() => buildStore().get('anilist:anime:123'), CacheError);
  } finally {
    mock.restore();
  }
});

test('store upsert: POST with merge-duplicates, correct payload, no created_at', async () => {
  const mock = installMockFetch(() => jsonResponse(null, 201));
  try {
    await buildStore().set('anilist:anime:123', { hello: 'world' }, 120);
    assert.equal(mock.calls[0].method, 'POST');
    assert.ok(mock.calls[0].init.headers.Prefer.includes('resolution=merge-duplicates'));
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.namespace, 'anilist');
    assert.equal(body.cache_key, 'anime:123');
    assert.deepEqual(body.value, { hello: 'world' });
    assert.equal(body.ttl_seconds, 120);
    assert.equal(typeof body.expires_at, 'string');
    assert.equal(typeof body.stale_until, 'string');
    assert.equal(typeof body.updated_at, 'string');
    assert.equal('created_at' in body, false); // preserved on conflict
  } finally {
    mock.restore();
  }
});

test('store upsert computes stale_until from expires_at + stale window', async () => {
  const mock = installMockFetch(() => jsonResponse(null, 201));
  try {
    await buildStore({ staleWindowSeconds: 3600 }).set('anilist:anime:1', 'v', 60);
    const body = JSON.parse(mock.calls[0].init.body);
    const gap = Date.parse(body.stale_until) - Date.parse(body.expires_at);
    assert.ok(Math.abs(gap - 3_600_000) < 2000, `expected ~1h stale window, got ${gap}ms`);
  } finally {
    mock.restore();
  }
});

test('store update/upsert: second set overwrites (no select-then-insert race)', async () => {
  const mock = installMockFetch(() => jsonResponse(null, 201));
  try {
    await buildStore().set('anilist:anime:1', 'first', 300);
    await buildStore().set('anilist:anime:1', 'second', 300);
    assert.equal(mock.calls.length, 2);
    assert.equal(JSON.parse(mock.calls[1].init.body).value, 'second');
    assert.equal(mock.calls[1].method, 'POST'); // upsert, not select+insert
  } finally {
    mock.restore();
  }
});

test('store delete: DELETE with namespace + cache_key filters', async () => {
  // 204 No Content responses must have NO body (Response constructor rule).
  const mock = installMockFetch(() => new Response(null, { status: 204 }));
  try {
    await buildStore().delete('jikan:anime:456');
    assert.equal(mock.calls[0].method, 'DELETE');
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get('namespace'), 'eq.jikan');
    assert.equal(url.searchParams.get('cache_key'), 'eq.anime:456');
  } finally {
    mock.restore();
  }
});

test('store errors: read/write/delete failures -> CacheError (degradation signal)', async () => {
  const mock500 = installMockFetch(() => jsonResponse({ message: 'db down' }, 500));
  try {
    const store = buildStore();
    await assert.rejects(() => store.get('anilist:anime:1'), CacheError);
    await assert.rejects(() => store.set('anilist:anime:1', 'v', 300), CacheError);
    await assert.rejects(() => store.delete('anilist:anime:1'), CacheError);
  } finally {
    mock500.restore();
  }
});

test('store timeout: hanging request -> CacheError (never hangs indefinitely)', async () => {
  const mock = installMockFetch((call) => new Promise((_, reject) => {
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    const store = buildStore({ timeoutMs: 50 });
    await assert.rejects(() => store.get('anilist:anime:1'), CacheError);
  } finally {
    mock.restore();
  }
});

// --- Namespace safety --------------------------------------------------------------

test('namespace safety: anilist:anime:123 and jikan:anime:123 query DIFFERENT records', async () => {
  const mock = installMockFetch(() => jsonResponse([]));
  try {
    const store = buildStore();
    await store.get('anilist:anime:123');
    await store.get('jikan:anime:123');
    const url1 = new URL(mock.calls[0].url);
    const url2 = new URL(mock.calls[1].url);
    assert.equal(url1.searchParams.get('namespace'), 'eq.anilist');
    assert.equal(url2.searchParams.get('namespace'), 'eq.jikan');
    // Same-looking cache_key inside a different namespace = a different row.
    assert.equal(url1.searchParams.get('cache_key'), url2.searchParams.get('cache_key'));
  } finally {
    mock.restore();
  }
});

test('namespace safety: key splitting preserves full namespace separation', async () => {
  const store = buildStore();
  // Internal helpers verified through the split logic:
  assert.deepEqual(store._splitKey('anilist:anime:123'), { namespace: 'anilist', cacheKey: 'anime:123' });
  assert.deepEqual(store._splitKey('jikan:anime:123'), { namespace: 'jikan', cacheKey: 'anime:123' });
  assert.deepEqual(store._splitKey('mal:anime:123'), { namespace: 'mal', cacheKey: 'anime:123' });
  assert.deepEqual(store._splitKey('tmdb:visual:v2:anilist:123'), { namespace: 'tmdb', cacheKey: 'visual:v2:anilist:123' });
  assert.deepEqual(store._splitKey('identity:anilist-to-mal:123'), { namespace: 'identity', cacheKey: 'anilist-to-mal:123' });
  assert.deepEqual(store._splitKey('plainkey'), { namespace: 'default', cacheKey: 'plainkey' });
});

test('namespace safety: tmdb:visual:v2:anilist:123 queries the tmdb namespace', async () => {
  const mock = installMockFetch(() => jsonResponse([]));
  try {
    await buildStore().get('tmdb:visual:v2:anilist:123');
    const url = new URL(mock.calls[0].url);
    assert.equal(url.searchParams.get('namespace'), 'eq.tmdb');
    assert.equal(url.searchParams.get('cache_key'), 'eq.visual:anilist:123');
  } finally {
    mock.restore();
  }
});

// --- CacheManager integration -------------------------------------------------------

/** Build a manager with a mocked-supabase L2 and an L1 memory store. */
function buildManager({ staleWindowSeconds } = {}) {
  const l1 = new MemoryStore({ staleWindowSeconds });
  const l2 = new SupabaseStore({ url: TEST_URL, apiKey: TEST_KEY, staleWindowSeconds });
  const manager = new CacheManager({ l1, l2, coalescer: new RequestCoalescer() });
  return { manager, l1, l2 };
}

test('manager: L2 hit promotes to L1 (promotion path)', async () => {
  // POST = the L2 seed write; GET = an L2 read returning the seeded row.
  const mock = installMockFetch((call) =>
    call.method === 'POST'
      ? jsonResponse(null, 201)
      : jsonResponse([makeRow('anilist:anime:123', { hello: 'world' }, {})]),
  );
  const { manager, l1, l2 } = buildManager();
  try {
    // Seed L2 directly (through the cache abstraction).
    await l2.set('anilist:anime:123', { hello: 'world' }, 300);
    mock.calls.length = 0;

    // L1 is empty; L2 must serve fresh and promote into L1.
    const result = await manager.getOrLoad('anilist:anime:123', async () => {
      throw new Error('loader must NOT be called on a fresh L2 hit');
    });
    assert.deepEqual(result, { hello: 'world' });
    assert.equal(mock.calls.length, 1); // only the L2 GET; no POST/write

    // Promoted into L1: a subsequent read no longer touches L2.
    mock.calls.length = 0;
    await manager.getOrLoad('anilist:anime:123', async () => { throw new Error('must be served from L1'); });
    assert.equal(mock.calls.length, 0);
    assert.equal((await l1.get('anilist:anime:123')).value.hello, 'world');
  } finally {
    mock.restore();
  }
});

test('manager: both miss -> loader runs -> L1 + L2 populated', async () => {
  const mock = installMockFetch(() => jsonResponse([]));
  const { manager, l1 } = buildManager();
  try {
    let calls = 0;
    const result = await manager.getOrLoad('anilist:anime:123', async () => {
      calls += 1;
      return { loaded: true };
    });
    assert.deepEqual(result, { loaded: true });
    assert.equal(calls, 1);
    assert.deepEqual((await l1.get('anilist:anime:123')).value, { loaded: true });
    // L2 was written via upsert (one POST after the initial miss-GET).
    const posts = mock.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].init.body).value, { loaded: true });
  } finally {
    mock.restore();
  }
});

test('manager: stale-if-error works across L2 (persistent stale data)', async () => {
  // Seed L2 with an immediately-stale but stale-window-valid entry (one POST).
  const mock = installMockFetch((call, index) =>
    index === 1
      ? jsonResponse(null, 201)
      : jsonResponse([makeRow('anilist:anime:123', 'stale-persistent', { freshMs: -10_000, staleMs: 60_000_000 })]),
  );
  const { manager, l2 } = buildManager();
  try {
    await l2.set('anilist:anime:123', 'stale-persistent', -1);
    // The L2 read must SUCCEED to find the stale entry, then the loader fails.
    const result = await manager.getOrLoad('anilist:anime:123', async () => {
      throw new Error('provider down');
    });
    assert.equal(result, 'stale-persistent'); // stale value, NOT an error
  } finally {
    mock.restore();
  }
});

test('manager: no stale served after stale_until (window respected)', async () => {
  // Stores configured with a ZERO stale window: a negative TTL makes the entry
  // immediately expired AND past its stale_until.
  const { manager } = buildManager({ staleWindowSeconds: 0 });
  const mock = installMockFetch(() => jsonResponse([makeRow('anilist:anime:123', 'too-old', { freshMs: -10_000, staleMs: -5_000 })]));
  try {
    await assert.rejects(
      manager.getOrLoad('anilist:anime:123', async () => { throw new Error('provider down'); }),
      /provider down/,
    );
  } finally {
    mock.restore();
  }
});

test('manager: provider failure never cached in L1 or L2', async () => {
  const { manager, l1 } = buildManager();
  const mock = installMockFetch(() => jsonResponse([])); // L2 miss
  try {
    await assert.rejects(
      manager.getOrLoad('anilist:anime:404', async () => { throw new Error('provider down'); }),
      /provider down/,
    );
    assert.equal(await l1.get('anilist:anime:404'), null); // failure NOT cached in L1
    const posts = mock.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 0); // failure NOT cached in L2 (no upsert)
  } finally {
    mock.restore();
  }
});

test('manager: invalid result never cached (isValid gate)', async () => {
  const { manager, l1 } = buildManager();
  const mock = installMockFetch(() => jsonResponse([]));
  try {
    const result = await manager.getOrLoad('anilist:anime:123', async () => null, {
      isValid: (v) => v !== null && v !== undefined,
    });
    assert.equal(result, null); // returned as-is, still uncached
    assert.equal(await l1.get('anilist:anime:123'), null);
    const posts = mock.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 0); // never written to L2
  } finally {
    mock.restore();
  }
});

test('manager: Supabase outage does NOT destroy provider success', async () => {
  // L2 reads AND writes fail; the provider must still run and succeed.
  const mock = installMockFetch(() => jsonResponse({ message: 'supabase down' }, 500));
  const { manager } = buildManager();
  try {
    let calls = 0;
    const result = await manager.getOrLoad('anilist:anime:123', async () => {
      calls += 1;
      return { survived: true };
    });
    assert.deepEqual(result, { survived: true }); // provider success unaffected
    assert.equal(calls, 1);
    assert.ok(mock.calls.length >= 2); // failed L2 read + failed L2 write attempted
  } finally {
    mock.restore();
  }
});

test('manager: request coalescing remains intact with L2', async () => {
  const mock = installMockFetch(() => jsonResponse([])); // L2 miss every time
  const { manager } = buildManager();
  try {
    let calls = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        manager.getOrLoad('anilist:anime:123', async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return 'shared';
        }),
      ),
    );
    assert.equal(calls, 1); // one provider load
    for (const result of results) assert.equal(result, 'shared');
  } finally {
    mock.restore();
  }
});

test('manager: namespace safety - same numeric ID across namespaces never collides', async () => {
  const mock = installMockFetch((call) => {
    const namespace = new URL(call.url).searchParams.get('namespace');
    if (namespace === 'eq.anilist') {
      return jsonResponse([makeRow('anilist:anime:123', 'anilist-value', {})]);
    }
    if (namespace === 'eq.jikan') {
      return jsonResponse([makeRow('jikan:anime:123', 'jikan-value', {})]);
    }
    return jsonResponse([]); // tmdb namespace: miss
  });
  const { manager } = buildManager();
  try {
    assert.equal(await manager.get('anilist:anime:123'), 'anilist-value');
    assert.equal(await manager.get('jikan:anime:123'), 'jikan-value'); // different record
    assert.equal(await manager.get('tmdb:visual:v2:anilist:123'), null); // separate namespace
  } finally {
    mock.restore();
  }
});

// --- Schema doc sanity (client/table constants) -------------------------------------

test('rest client targets the documented cache_entries table', async () => {
  const mock = installMockFetch(() => jsonResponse([]));
  try {
    const client = new SupabaseRestClient({ url: TEST_URL, apiKey: TEST_KEY });
    await client.select({ namespace: 'anilist', cache_key: 'anime:1' });
    assert.ok(mock.calls[0].url.includes('/rest/v1/cache_entries?'));
  } finally {
    mock.restore();
  }
});
