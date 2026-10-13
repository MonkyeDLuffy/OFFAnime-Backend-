/**
 * Smoke test: the whole module graph loads, and the pieces that ARE implemented
 * in Phase 1 behave correctly.
 *
 * This catches syntax/import/circular-dependency problems across folders that
 * the health route alone does not import (providers, cache, identity, streaming,
 * normalizers), and verifies the behavior of the real Phase 1 utilities.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports (after env assignment) so LOG_LEVEL applies to config.
const { providers } = await import('../src/providers/index.js');
const { CacheManager } = await import('../src/cache/cache-manager.js');
const { MemoryStore } = await import('../src/cache/memory/memory-store.js');
const { SupabaseStore } = await import('../src/cache/supabase/supabase-store.js');
const { RequestCoalescer } = await import('../src/cache/request-coalescer.js');
const { createAnimeIdentity, normalizeId } = await import('../src/identity/id-types.js');
const { streamResolver } = await import('../src/streaming/stream-resolver.js');
const { createBaseAnime } = await import('../src/normalizers/anime.normalizer.js');
const { ValidationError } = await import('../src/errors/index.js');

test('provider registry exposes all providers (AniZip included)', () => {
  assert.deepEqual(Object.keys(providers).sort(), ['anilist', 'anizip', 'jikan', 'megaplay', 'tmdb']);
});

test('identity: MAL id is never stored as the AniList id', () => {
  const identity = createAnimeIdentity({ malId: 456 });
  assert.equal(identity.anilistId, null);
  assert.equal(identity.malId, 456);
  assert.equal(identity.id, null); // id mirrors AniList id, never a MAL id
});

test('identity: AniList id populates both id and anilistId', () => {
  const identity = createAnimeIdentity({ anilistId: 123 });
  assert.deepEqual(identity, { id: 123, anilistId: 123, malId: null });
});

test('identity: building with neither id throws ValidationError', () => {
  assert.throws(() => createAnimeIdentity({}), ValidationError);
});

test('normalizeId rejects junk and coerces numeric strings', () => {
  assert.equal(normalizeId('123'), 123);
  assert.equal(normalizeId(0), null);
  assert.equal(normalizeId(-5), null);
  assert.equal(normalizeId('abc'), null);
});

test('createBaseAnime yields the canonical shape', () => {
  const anime = createBaseAnime({ anilistId: 1, malId: 2 });
  assert.equal(anime.id, 1);
  assert.equal(anime.malId, 2);
  assert.deepEqual(anime.genres, []);
});

test('L2 (Supabase) is not configured in Phase 1', () => {
  assert.equal(new SupabaseStore().isConfigured(), false);
});

test('CacheManager.getOrLoad returns fresh then serves cached value', async () => {
  const cache = new CacheManager({ l1: new MemoryStore(), l2: new SupabaseStore(), coalescer: new RequestCoalescer() });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { value: 'data' };
  };
  const first = await cache.getOrLoad('k', loader, { ttlSeconds: 60 });
  const second = await cache.getOrLoad('k', loader, { ttlSeconds: 60 });
  assert.deepEqual(first, { value: 'data' });
  assert.deepEqual(second, { value: 'data' });
  assert.equal(calls, 1); // second call served from L1
});

test('CacheManager serves STALE data when the loader fails (stale-if-error)', async () => {
  const cache = new CacheManager({ l1: new MemoryStore(), l2: new SupabaseStore(), coalescer: new RequestCoalescer() });
  await cache.getOrLoad('k', async () => 'good', { ttlSeconds: -1 }); // immediately stale
  const result = await cache.getOrLoad('k', async () => {
    throw new Error('provider down');
  });
  assert.equal(result, 'good'); // stale value, NOT an error / empty response
});

test('CacheManager propagates the error when nothing is cached', async () => {
  const cache = new CacheManager({ l1: new MemoryStore(), l2: new SupabaseStore(), coalescer: new RequestCoalescer() });
  await assert.rejects(
    cache.getOrLoad('missing', async () => {
      throw new Error('provider down');
    }),
    /provider down/,
  );
});

test('RequestCoalescer shares one in-flight promise across callers', async () => {
  const coalescer = new RequestCoalescer();
  let calls = 0;
  const op = () => coalescer.run('same', async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return 'x';
  });
  const [a, b, c] = await Promise.all([op(), op(), op()]);
  assert.deepEqual([a, b, c], ['x', 'x', 'x']);
  assert.equal(calls, 1);
});

// Phase 8 implemented the streaming layers, so the old Phase 1 expectation
// (NotImplementedError) no longer holds. The layers must now be LIVE and
// validate input BEFORE any network call - never returning fake data.
test('streaming layers are live: invalid input is rejected before any network call', async () => {
  await assert.rejects(() => streamResolver.resolveStream({ anilistId: 0 }), ValidationError);
  await assert.rejects(() => providers.megaplay.resolveByAnilistId(0), ValidationError);
  await assert.rejects(() => providers.megaplay.resolveByAnilistId(1, { language: 'eng' }), ValidationError);
});
