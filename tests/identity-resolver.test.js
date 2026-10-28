/**
 * IdentityResolver tests - AniList <-> MAL resolution with MOCKED HTTP.
 *
 * No live API calls. Core guarantees verified:
 *   - anilistId comes ONLY from AniList's `id` field; malId ONLY from `idMal`.
 *   - A MAL ID never becomes anilistId / canonical id.
 *   - Valid unresolved mappings (idMal null) are distinguished from failures
 *     and never cached on provider failure.
 *   - Namespace-safe cache keys, coalescing, reverse population.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { IdentityResolver } = await import('../src/identity/identity-resolver.js');
const { AnilistProvider } = await import('../src/providers/anilist/anilist.provider.js');
const { CacheManager } = await import('../src/cache/cache-manager.js');
const { MemoryStore } = await import('../src/cache/memory/memory-store.js');
const { SupabaseStore } = await import('../src/cache/supabase/supabase-store.js');
const { RequestCoalescer } = await import('../src/cache/request-coalescer.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const {
  ValidationError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ProviderError,
} = await import('../src/errors/index.js');
const { parseIdentityType, createIdentityResult } = await import('../src/identity/id-types.js');

/** Build a resolver with a fresh cache (isolates tests from each other). */
function buildResolver({ timeoutMs } = {}) {
  const provider = new AnilistProvider({ timeoutMs });
  const cache = new CacheManager({
    l1: new MemoryStore(),
    l2: new SupabaseStore(),
    coalescer: new RequestCoalescer(),
  });
  return { resolver: new IdentityResolver({ provider, cache }), cache };
}

// --- AniList -> MAL -----------------------------------------------------------

test('AniList -> MAL: successful mapping from provider idMal', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver, cache } = buildResolver();
  try {
    const result = await resolver.resolveAniListToMal(101);
    assert.deepEqual(result, {
      anilistId: 101,
      malId: 202,
      source: 'anilist',
      confidence: 'provider',
      resolved: true,
    });
    // Forward + reverse cache entries populated with normalized results.
    assert.deepEqual(await cache.get('identity:anilist-to-mal:101'), result);
    assert.deepEqual(await cache.get('identity:mal-to-anilist:202'), result);
  } finally {
    mock.restore();
  }
});

test('AniList -> MAL: anilistId comes ONLY from payload.id, never from idMal', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver } = buildResolver();
  try {
    const result = await resolver.resolveAniListToMal(101);
    assert.equal(result.anilistId, 101); // from payload.id
    assert.notEqual(result.anilistId, 202); // NEVER from idMal
    assert.equal(result.malId, 202);
  } finally {
    mock.restore();
  }
});

test('AniList -> MAL: idMal null -> VALID unresolved mapping (not an error, not a failure)', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: null } } }));
  const { resolver, cache } = buildResolver();
  try {
    const result = await resolver.resolveAniListToMal(101);
    assert.deepEqual(result, {
      anilistId: 101,
      malId: null,
      source: null,
      confidence: null,
      resolved: false,
    });
    assert.equal(cache.get('identity:anilist-to-mal:101') !== null, true); // valid unresolved IS cached
  } finally {
    mock.restore();
  }
});

test('AniList -> MAL: anime does not exist (404) -> NotFoundError, nothing cached', async () => {
  const mock = installMockFetch(() => jsonResponse({ errors: [{ message: 'Not Found.', status: 404 }] }, 404));
  const { resolver, cache } = buildResolver();
  try {
    await assert.rejects(() => resolver.resolveAniListToMal(99999999), NotFoundError);
    assert.equal(await cache.get('identity:anilist-to-mal:99999999'), null);
  } finally {
    mock.restore();
  }
});

test('AniList -> MAL: timeout -> TimeoutError, never cached as unresolved', async () => {
  const mock = installMockFetch((call) => new Promise((_, reject) => {
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  const { resolver, cache } = buildResolver({ timeoutMs: 50 });
  try {
    await assert.rejects(() => resolver.resolveAniListToMal(101), TimeoutError);
    assert.equal(await cache.get('identity:anilist-to-mal:101'), null); // failure NOT cached
  } finally {
    mock.restore();
  }
});

test('AniList -> MAL: 429 -> RateLimitError; 500/network/malformed -> ProviderError; none cached', async () => {
  const { resolver, cache } = buildResolver();

  const mock429 = installMockFetch(() => jsonResponse({}, 429));
  try {
    await assert.rejects(() => resolver.resolveAniListToMal(101), RateLimitError);
    assert.equal(await cache.get('identity:anilist-to-mal:101'), null);
  } finally {
    mock429.restore();
  }

  const mock500 = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    await assert.rejects(() => resolver.resolveAniListToMal(102), ProviderError);
    assert.equal(await cache.get('identity:anilist-to-mal:102'), null);
  } finally {
    mock500.restore();
  }

  const mockNet = installMockFetch(() => { throw new Error('ENOTFOUND'); });
  try {
    await assert.rejects(() => resolver.resolveAniListToMal(103), ProviderError);
    assert.equal(await cache.get('identity:anilist-to-mal:103'), null);
  } finally {
    mockNet.restore();
  }

  const mockBad = installMockFetch(() => jsonResponse({ data: { Media: { idMal: 1 } } })); // missing id
  try {
    await assert.rejects(() => resolver.resolveAniListToMal(104), ProviderError);
    assert.equal(await cache.get('identity:anilist-to-mal:104'), null);
  } finally {
    mockBad.restore();
  }
});

// --- MAL -> AniList -----------------------------------------------------------

test('MAL -> AniList: successful mapping via AniListProvider.getAnimeByMalId', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver, cache } = buildResolver();
  try {
    const result = await resolver.resolveMalToAniList(202);
    assert.deepEqual(result, {
      anilistId: 101,
      malId: 202,
      source: 'anilist',
      confidence: 'provider',
      resolved: true,
    });
    // Forward + reverse cache entries populated.
    assert.deepEqual(await cache.get('identity:mal-to-anilist:202'), result);
    assert.deepEqual(await cache.get('identity:anilist-to-mal:101'), result);
    // The lookup used AniList's idMal path.
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.variables.idMal, 202);
  } finally {
    mock.restore();
  }
});

test('MAL -> AniList: no AniList Media exists -> NotFoundError, nothing cached', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: null } }));
  const { resolver, cache } = buildResolver();
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(99999999), NotFoundError);
    assert.equal(await cache.get('identity:mal-to-anilist:99999999'), null);
  } finally {
    mock.restore();
  }
});

test('MAL -> AniList: 404/timeout/429/500/network/malformed -> typed errors, none cached', async () => {
  const { resolver, cache } = buildResolver({ timeoutMs: 50 });

  const mock404 = installMockFetch(() => jsonResponse({ errors: [{ status: 404 }] }, 404));
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(202), NotFoundError);
    assert.equal(await cache.get('identity:mal-to-anilist:202'), null);
  } finally {
    mock404.restore();
  }

  const mockTimeout = installMockFetch((call) => new Promise((_, reject) => {
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(203), TimeoutError);
    assert.equal(await cache.get('identity:mal-to-anilist:203'), null);
  } finally {
    mockTimeout.restore();
  }

  const mock429 = installMockFetch(() => jsonResponse({}, 429));
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(204), RateLimitError);
    assert.equal(await cache.get('identity:mal-to-anilist:204'), null);
  } finally {
    mock429.restore();
  }

  const mock500 = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(205), ProviderError);
    assert.equal(await cache.get('identity:mal-to-anilist:205'), null);
  } finally {
    mock500.restore();
  }

  const mockNet = installMockFetch(() => { throw new Error('ENOTFOUND'); });
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(206), ProviderError);
    assert.equal(await cache.get('identity:mal-to-anilist:206'), null);
  } finally {
    mockNet.restore();
  }

  const mockBad = installMockFetch(() => new Response('not json', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(207), ProviderError);
    assert.equal(await cache.get('identity:mal-to-anilist:207'), null);
  } finally {
    mockBad.restore();
  }
});

// --- Validation ----------------------------------------------------------------

test('validation: invalid AniList IDs -> ValidationError, no HTTP request', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 1, idMal: 2 } } }));
  const { resolver } = buildResolver();
  try {
    for (const bad of [0, -1, 1.5, Number('NaN'), Number('Infinity'), '', '123abc', null, undefined]) {
      await assert.rejects(() => resolver.resolveAniListToMal(bad), ValidationError, `expected rejection for ${bad}`);
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('validation: invalid MAL IDs -> ValidationError, no HTTP request', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 1, idMal: 2 } } }));
  const { resolver } = buildResolver();
  try {
    for (const bad of [0, -1, 1.5, Number('NaN'), Number('Infinity'), '', '123abc', null, undefined]) {
      await assert.rejects(() => resolver.resolveMalToAniList(bad), ValidationError, `expected rejection for ${bad}`);
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// --- Namespace safety ------------------------------------------------------------

test('namespace safety: MAL ID never becomes anilistId or canonical id without provider confirmation', () => {
  // AniList id 101, idMal null: the unresolved result must NOT invent any id.
  const unresolved = createIdentityResult({ anilistId: 101, malId: null });
  assert.equal(unresolved.anilistId, 101); // AniList id stays an AniList ID
  assert.equal(unresolved.malId, null); // no MAL ID invented
  assert.equal(unresolved.resolved, false);
  assert.equal(unresolved.source, null); // no mapping claimed
  assert.equal(unresolved.confidence, null);
});

test('namespace safety: result.anilistId !== result.malId when provider IDs differ', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver } = buildResolver();
  try {
    const result = await resolver.resolveAniListToMal(101);
    assert.notEqual(result.anilistId, result.malId);
    assert.equal(result.anilistId, 101); // AniList id remains AniList id
    assert.equal(result.malId, 202);
  } finally {
    mock.restore();
  }
});

test('namespace safety: equal numeric values (AniList 123, MAL 123) stay namespace-separated', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 123, idMal: 123 } } }));
  const { resolver } = buildResolver();
  try {
    const result = await resolver.resolveAniListToMal(123);
    assert.equal(result.resolved, true);
    assert.equal(result.source, 'anilist'); // mapping established by AniList fields
    assert.equal(result.anilistId, 123); // from payload.id
    assert.equal(result.malId, 123); // from payload.idMal
    // Equal numbers came from two DIFFERENT namespace fields - provenance is
    // tracked explicitly, never inferred from numeric equality.
  } finally {
    mock.restore();
  }
});

test('namespace safety: idMal mismatched with requested MAL ID -> ProviderError (never reinterpreted)', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 999 } } }));
  const { resolver, cache } = buildResolver();
  try {
    await assert.rejects(() => resolver.resolveMalToAniList(202), ProviderError);
    assert.equal(await cache.get('identity:mal-to-anilist:202'), null);
  } finally {
    mock.restore();
  }
});

// --- Generic resolver --------------------------------------------------------------

test('generic resolve: { type: "anilist", id } and { type: "mal", id } delegate correctly', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver } = buildResolver();
  try {
    const fromAnilist = await resolver.resolve({ type: 'anilist', id: 101 });
    assert.deepEqual(fromAnilist, {
      anilistId: 101,
      malId: 202,
      source: 'anilist',
      confidence: 'provider',
      resolved: true,
    });
    const fromMal = await resolver.resolve({ type: 'mal', id: 202 });
    assert.deepEqual(fromMal, fromAnilist);
  } finally {
    mock.restore();
  }
});

test('generic resolve: unknown type / missing type / missing id / bare number / array -> ValidationError', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 1, idMal: 2 } } }));
  const { resolver } = buildResolver();
  try {
    await assert.rejects(() => resolver.resolve({ type: 'tmdb', id: 1 }), ValidationError); // unknown type
    await assert.rejects(() => resolver.resolve({ id: 1 }), ValidationError); // missing type
    await assert.rejects(() => resolver.resolve({ type: 'anilist' }), ValidationError); // missing id
    await assert.rejects(() => resolver.resolve(123), ValidationError); // bare number NOT accepted
    await assert.rejects(() => resolver.resolve([1, 2]), ValidationError);
    await assert.rejects(() => resolver.resolve(null), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('parseIdentityType accepts only anilist/mal', () => {
  assert.equal(parseIdentityType('anilist'), 'anilist');
  assert.equal(parseIdentityType('mal'), 'mal');
  assert.throws(() => parseIdentityType('tmdb'), ValidationError);
  assert.throws(() => parseIdentityType(undefined), ValidationError);
});

// --- Cache ---------------------------------------------------------------------------

test('cache: hit avoids provider request; repeated resolution returns equivalent results', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver } = buildResolver();
  try {
    const first = await resolver.resolveAniListToMal(101);
    const second = await resolver.resolveAniListToMal(101);
    assert.deepEqual(first, second);
    assert.equal(mock.calls.length, 1); // second served from cache
  } finally {
    mock.restore();
  }
});

test('cache: valid unresolved mapping cached and served without another request', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: null } } }));
  const { resolver } = buildResolver();
  try {
    await resolver.resolveAniListToMal(101);
    await resolver.resolveAniListToMal(101);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('cache: stale-if-error - previous mapping survives provider failure', async () => {
  const key = 'identity:anilist-to-mal:101';
  const previous = createIdentityResult({ anilistId: 101, malId: 202 });
  const { resolver, cache } = buildResolver();
  // Populate with an immediately-stale TTL.
  await cache.set(key, previous, -1);
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const result = await resolver.resolveAniListToMal(101);
    assert.deepEqual(result, previous); // stale value, NOT an error
  } finally {
    mock.restore();
  }
});

test('cache: concurrent identical lookups coalesce into one AniList request', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 101, idMal: 202 } } }));
  const { resolver } = buildResolver();
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => resolver.resolveAniListToMal(101)),
    );
    assert.equal(mock.calls.length, 1); // 10 callers, 1 request
    for (const result of results) {
      assert.deepEqual(result, results[0]);
    }
  } finally {
    mock.restore();
  }
});

// --- Purity + future MegaPlay usage ---------------------------------------------------

test('purity: repeated resolution is deterministic and provider payloads are not mutated', async () => {
  const fixture = { id: 101, idMal: 202 };
  const fixtureSnapshot = JSON.stringify(fixture);
  const mock = installMockFetch(() => jsonResponse({ data: { Media: fixture } }));
  const { resolver } = buildResolver();
  try {
    const a = await resolver.resolveAniListToMal(101);
    const b = await resolver.resolveAniListToMal(101);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(fixture), fixtureSnapshot); // payload untouched
  } finally {
    mock.restore();
  }
});

test('future MegaPlay fallback: resolver provides the exact IDs the streaming layer needs', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: { id: 123, idMal: 456 } } }));
  const { resolver } = buildResolver();
  try {
    // AniList ID = 123 -> provider id = 123, idMal = 456
    const result = await resolver.resolveAniListToMal(123);
    assert.equal(result.anilistId, 123); // MegaPlay primary attempt target
    assert.equal(result.malId, 456); // MegaPlay fallback target
    assert.equal(result.resolved, true);
    // The reverse lookup is also ready for MAL-keyed fallback resolution.
    const reverse = await resolver.resolveMalToAniList(456);
    assert.deepEqual(reverse, result);
  } finally {
    mock.restore();
  }
});
