/**
 * L2 (Supabase) cache reliability tests - mocked HTTP only.
 *
 * Verified (the production "Supabase cache read/write failed" fixes):
 *   - the upsert sends the EXPLICIT conflict target
 *     (?on_conflict=namespace,cache_key) so the second write for a key merges
 *     instead of failing with 23505 duplicate key,
 *   - failures carry the EXACT operation + upstream status + PostgREST error
 *     code/message (42P01 missing table, 42P10 missing unique index, 401
 *     wrong key/RLS) instead of an opaque wrapper,
 *   - the CacheManager circuit breaker stops hammering a broken L2 and the
 *     app runs L1-only (provider results unaffected, L1 still serves),
 *   - an anime API request succeeds while L2 is down (and the breaker keeps
 *     subsequent requests from re-contacting Supabase).
 */

import './helpers/test-env-cache-l2.js';

import test from 'node:test';
import assert from 'node:assert/strict';

const { SupabaseStore } = await import('../src/cache/supabase/supabase-store.js');
const { CacheManager, cacheManager } = await import('../src/cache/cache-manager.js');
const { MemoryStore } = await import('../src/cache/memory/memory-store.js');
const { RequestCoalescer } = await import('../src/cache/request-coalescer.js');
const { CacheError } = await import('../src/errors/index.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const { installApiMocks, startTestServer, resetL1Cache, anilistPage, anilistMedia } = await import('./helpers/test-server.js');

const TEST_URL = 'https://test-project.supabase.co';
const TEST_KEY = 'test-service-role-key';

const buildStore = (over = {}) => new SupabaseStore({ url: TEST_URL, apiKey: TEST_KEY, ...over });

/**
 * Reset the GLOBAL cache manager between endpoint tests: clear L1 AND close
 * the L2 breaker so each test observes its own L2 behavior (the breaker is
 * process-wide by design - production does not reset it per request).
 */
async function resetGlobalCache() {
  await resetL1Cache();
  cacheManager._l2Failures = 0;
  cacheManager._l2OpenUntil = 0;
  cacheManager._l2Trips = 0;
}

test('upsert sends on_conflict=namespace,cache_key (atomic merge path on every write)', async () => {
  const mock = installMockFetch(() => jsonResponse(null, 201));
  try {
    const store = buildStore();
    await store.set('anilist:anime:123', { v: 1 }, 300);
    await store.set('anilist:anime:123', { v: 2 }, 300);
    assert.equal(mock.calls.length, 2);
    for (const call of mock.calls) {
      const url = new URL(call.url);
      assert.equal(url.searchParams.get('on_conflict'), 'namespace,cache_key');
      assert.equal(call.method, 'POST');
      assert.ok(String(call.init.headers.Prefer).includes('resolution=merge-duplicates'));
    }
  } finally {
    mock.restore();
  }
});

test('read/write failures expose the exact operation + 42P01 (missing table)', async () => {
  const mock = installMockFetch(() => jsonResponse({
    code: '42P01',
    message: 'relation "public.cache_entries" does not exist',
  }, 404));
  try {
    const store = buildStore();
    const readError = await store.get('anilist:anime:1').then(
      () => { throw new Error('should have rejected'); },
      (err) => err,
    );
    assert.ok(readError instanceof CacheError);
    assert.equal(readError.details.provider, 'supabase');
    assert.equal(readError.details.operation, 'read');
    assert.equal(readError.details.upstreamStatus, 404);
    assert.equal(readError.details.upstreamCode, '42P01');
    assert.ok(String(readError.details.upstreamMessage).includes('does not exist'));

    const writeError = await store.set('anilist:anime:1', 'v', 300).then(
      () => { throw new Error('should have rejected'); },
      (err) => err,
    );
    assert.ok(writeError instanceof CacheError);
    assert.equal(writeError.details.operation, 'write');
    assert.equal(writeError.details.upstreamCode, '42P01');
  } finally {
    mock.restore();
  }
});

test('write failures expose 42P10 (missing unique index for the conflict target)', async () => {
  const mock = installMockFetch(() => jsonResponse({
    code: '42P10',
    message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
  }, 400));
  try {
    const error = await buildStore().set('anilist:anime:1', 'v', 300).then(
      () => { throw new Error('should have rejected'); },
      (err) => err,
    );
    assert.ok(error instanceof CacheError);
    assert.equal(error.details.operation, 'write');
    assert.equal(error.details.upstreamStatus, 400);
    assert.equal(error.details.upstreamCode, '42P10');
  } finally {
    mock.restore();
  }
});

test('read failures expose HTTP 401 (wrong key / RLS) in the details', async () => {
  const mock = installMockFetch(() => jsonResponse({ message: 'Invalid API key' }, 401));
  try {
    const error = await buildStore().get('anilist:anime:1').then(
      () => { throw new Error('should have rejected'); },
      (err) => err,
    );
    assert.ok(error instanceof CacheError);
    assert.equal(error.details.operation, 'read');
    assert.equal(error.details.upstreamStatus, 401);
  } finally {
    mock.restore();
  }
});

test('circuit breaker: repeated L2 failures stop Supabase calls, provider + L1 unaffected, recovery after cooldown', async () => {
  const mock = installMockFetch(() => jsonResponse({ message: 'supabase down' }, 500));
  try {
    const manager = new CacheManager({
      l1: new MemoryStore(),
      l2: buildStore(),
      coalescer: new RequestCoalescer(),
      l2FailureThreshold: 2,
      l2BreakerOpenMs: 60,
      l2BreakerMaxOpenMs: 120,
    });

    // 1st request: L2 get fails (1) + L2 set fails (2) -> breaker OPENS.
    const first = await manager.getOrLoad('anilist:anime:1', async () => ({ survived: 1 }));
    assert.deepEqual(first, { survived: 1 });
    const callsAfterFirst = mock.calls.length;
    assert.equal(callsAfterFirst, 2, 'one failed L2 read + one failed L2 write');

    // Breaker open: the next request must NOT touch Supabase at all.
    const second = await manager.getOrLoad('anilist:anime:2', async () => ({ survived: 2 }));
    assert.deepEqual(second, { survived: 2 });
    assert.equal(mock.calls.length, callsAfterFirst, 'breaker must stop hammering L2');

    // L1 keeps serving a previously cached key without provider or L2.
    let providerCalls = 0;
    const third = await manager.getOrLoad('anilist:anime:1', async () => {
      providerCalls += 1;
      return { reloaded: true };
    });
    assert.deepEqual(third, { survived: 1 });
    assert.equal(providerCalls, 0);

    // After the cooldown the breaker probes L2 again (and re-opens on failure).
    await new Promise((resolve) => setTimeout(resolve, 90));
    const fourth = await manager.getOrLoad('anilist:anime:3', async () => ({ survived: 3 }));
    assert.deepEqual(fourth, { survived: 3 });
    assert.ok(mock.calls.length > callsAfterFirst, 'breaker must probe L2 again after the cooldown');
  } finally {
    mock.restore();
  }
});

test('anime search API works while L2 is unavailable (L1-only fallback, no repeated Supabase calls)', async () => {
  await resetGlobalCache();
  const installed = installApiMocks({
    anilist: () => anilistPage([anilistMedia({ id: 123 })]),
    supabaseRest: () => jsonResponse({ message: 'supabase down' }, 500),
  });
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/search?q=l2-outage`);
    assert.equal(first.status, 200, 'L2 outage must never break the anime API');
    assert.equal((await first.json()).results.length, 1);
    // Exactly the failed L2 read + failed L2 write, then the breaker opens.
    assert.equal(installed.supabaseRestCalls().length, 2);

    const second = await fetch(`${server.baseUrl}/api/search?q=l2-outage`);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).results.length, 1);
    assert.equal(installed.supabaseRestCalls().length, 2, 'breaker must prevent repeated Supabase requests');
    assert.equal(installed.anilistCalls().length, 1, 'L1 must serve the cached result');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('anime DETAILS API works while L2 is unavailable (provider data intact, breaker engaged)', async () => {
  await resetGlobalCache();
  const installed = installApiMocks({
    // Details pipeline for an anime WITHOUT a MAL mapping: AniList only
    // (Jikan skipped, TMDB unconfigured -> valid unresolved result).
    anilist: (body) => {
      if (body.query.includes('airingSchedules') || body.query.includes('recommendations')) {
        throw new Error(`unexpected AniList query in details test: ${body.query}`);
      }
      return { data: { Media: anilistMedia({ id: 123, idMal: null }) } };
    },
    supabaseRest: () => jsonResponse({ message: 'supabase down' }, 500),
  });
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(first.status, 200, 'L2 outage must never break the details API');
    const firstBody = await first.json();
    assert.equal(firstBody.id, 123);
    assert.equal(firstBody.anilistId, 123);
    // Two failed L2 reads (composite key + anime key) trip the breaker; the
    // subsequent L2 writes are skipped by the open breaker.
    const callsAfterFirst = installed.supabaseRestCalls().length;
    assert.ok(callsAfterFirst <= 2, `unexpected L2 call count: ${callsAfterFirst}`);

    const second = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).id, 123);
    assert.equal(installed.supabaseRestCalls().length, callsAfterFirst, 'breaker must stop L2 contact');
    assert.equal(installed.anilistCalls().length, 1, 'L1 must serve the cached composite result');
  } finally {
    await server.stop();
    installed.restore();
  }
});
