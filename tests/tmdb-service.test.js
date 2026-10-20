/**
 * TMDB service tests - cache-first enrichment flow:
 *   service -> cacheManager.getOrLoad -> provider -> normalizer + matcher
 *
 * HTTP is mocked; no live TMDB calls. Verifies that normalized enrichment is
 * cached, failures are never cached, stale-if-error works, unresolved results
 * follow explicit cache policy, concurrent requests coalesce, season-aware
 * matching (sequel entries -> shared TMDB series + derived season number),
 * and that TMDB failures never replace existing AniList/Jikan canonical data.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { enrichWithTmdb } = await import('../src/services/tmdb.service.js');
const { TmdbProvider } = await import('../src/providers/tmdb/tmdb.provider.js');
const { cacheManager } = await import('../src/cache/cache-manager.js');
const { normalizeAnilistAnime } = await import('../src/normalizers/anime.normalizer.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const { ProviderError } = await import('../src/errors/index.js');

/** Versioned visual cache key (must mirror tmdb.service.js). */
const visualKey = (anilistId) => `tmdb:visual:v2:anilist:${anilistId}`;

const canonical = normalizeAnilistAnime({
  id: 123,
  idMal: 456,
  title: { romaji: 'One Punch Man', english: 'One-Punch Man', native: null, userPreferred: 'One Punch Man' },
  format: 'TV',
  seasonYear: 2015,
});

/** Build a configured provider + fresh cache for isolation. */
function buildDeps({ apiKey = 'test-key', timeoutMs } = {}) {
  return {
    provider: new TmdbProvider({ apiKey, timeoutMs }),
    cache: cacheManager, // shared singleton; keys are namespaced per anilistId
  };
}

const searchPayload = (overrides = []) => ({
  page: 1,
  results: [
    {
      id: 789,
      name: 'One-Punch Man',
      original_name: 'ワンパンマン',
      first_air_date: '2015-10-04',
      popularity: 250,
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
    },
    ...overrides,
  ],
});

/** TV details payload with a seasons list (mirrors real TMDB shape). */
const tvDetailsPayload = (seasons) => ({
  id: 789,
  name: 'One-Punch Man',
  first_air_date: '2015-10-04',
  seasons,
});

const season = (n, air, eps = 12) => ({ season_number: n, name: `Season ${n}`, air_date: air, episode_count: eps, poster_path: `/season-${n}.jpg` });

/** Mock router: TV search + TV details (for season derivation). */
function tmdbRouter({ results = searchPayload(), seasons = [season(1, '2015-10-04'), season(2, '2019-04-10')] } = {}) {
  return (call) => {
    const url = String(call.url);
    if (url.includes('/search/tv')) return jsonResponse(typeof results === 'function' ? results(url) : results);
    if (url.includes('/tv/789') && !url.includes('/tv/789/')) return jsonResponse(tvDetailsPayload(seasons));
    throw new Error(`unexpected TMDB path: ${url}`);
  };
}

test('enrichWithTmdb returns a RESOLVED visual from a confident match', async () => {
  const mock = installMockFetch(tmdbRouter());
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(123));
    const visual = await enrichWithTmdb(canonical, deps);
    assert.equal(visual.resolved, true);
    assert.equal(visual.tmdbId, 789);
    assert.equal(visual.images.banner, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
    // Season derivation for an S1-shaped entry: year evidence -> season 1.
    assert.equal(visual.tmdbSeasonNumber, 1);
    assert.equal(visual.season.seasonNumber, 1);
    assert.equal(visual.matchStrategy, 'title');
    assert.equal(visual.matchedTitle, 'One-Punch Man');
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(123));
  }
});

test('SEQUEL entry ("... 2") resolves to the SHARED TMDB series with its season', async () => {
  const sequel = normalizeAnilistAnime({
    id: 97668,
    idMal: 999,
    title: { romaji: 'One Punch Man 2', english: 'One-Punch Man Season 2', native: null, userPreferred: 'One Punch Man 2' },
    format: 'TV',
    seasonYear: 2019,
  });
  const mock = installMockFetch(tmdbRouter());
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(97668));
    const visual = await enrichWithTmdb(sequel, deps);
    // The sequel shares ONE TMDB series with S1 (base-title match) - the same
    // tmdbId S1 resolves to, with the correct season derived.
    assert.equal(visual.resolved, true);
    assert.equal(visual.tmdbId, 789);
    assert.equal(visual.tmdbSeasonNumber, 2);
    assert.equal(visual.season.seasonNumber, 2);
    assert.equal(visual.season.airDate, '2019-04-10');
    assert.equal(visual.matchStrategy, 'title_base');
    assert.equal(visual.matchedTitle, 'One-Punch Man');
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(97668));
  }
});

test('multiple AniList season entries map to ONE tmdbId without cache collisions', async () => {
  const s1 = normalizeAnilistAnime({
    id: 900,
    idMal: 800,
    title: { romaji: 'One Punch Man', english: null, native: null, userPreferred: 'One Punch Man' },
    format: 'TV',
    seasonYear: 2015,
  });
  const s2 = normalizeAnilistAnime({
    id: 901,
    idMal: 801,
    title: { romaji: 'One Punch Man 2', english: null, native: null, userPreferred: 'One Punch Man 2' },
    format: 'TV',
    seasonYear: 2019,
  });
  const mock = installMockFetch(tmdbRouter());
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(900));
    await cacheManager.invalidate(visualKey(901));
    const [v1, v2] = await Promise.all([enrichWithTmdb(s1, deps), enrichWithTmdb(s2, deps)]);
    assert.equal(v1.tmdbId, 789);
    assert.equal(v2.tmdbId, 789); // same TMDB series, allowed (not one-to-one)
    assert.equal(v1.tmdbSeasonNumber, 1);
    assert.equal(v2.tmdbSeasonNumber, 2);
    // Separate cache entries keyed by the original AniList IDs.
    const c1 = await cacheManager.get(visualKey(900));
    const c2 = await cacheManager.get(visualKey(901));
    assert.equal(c1.tmdbSeasonNumber, 1);
    assert.equal(c2.tmdbSeasonNumber, 2);
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(900));
    await cacheManager.invalidate(visualKey(901));
  }
});

test('cache hit avoids TMDB request; normalized result is cached', async () => {
  const mock = installMockFetch(tmdbRouter());
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(123));
    await enrichWithTmdb(canonical, deps);
    await enrichWithTmdb(canonical, deps);
    assert.equal(mock.calls.length, 2); // search + details once; second call from cache

    const cached = await cacheManager.get(visualKey(123));
    assert.equal(cached.tmdbId, 789); // normalized enrichment cached, not raw
    assert.equal('results' in cached, false);
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(123));
  }
});

test('provider failure is NOT cached; typed error propagates', async () => {
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(124));
    await assert.rejects(() => enrichWithTmdb({ ...canonical, anilistId: 124 }, deps), ProviderError);
    assert.equal(await cacheManager.get(visualKey(124)), null);
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(124));
  }
});

test('stale-if-error: previous enrichment survives provider failure', async () => {
  const key = visualKey(125);
  await cacheManager.invalidate(key);
  const previous = { resolved: true, tmdbId: 789, mediaType: 'tv', images: { backdrop: 'https://x/b.jpg', banner: 'https://x/b.jpg' }, poster: null, reason: null };
  await cacheManager.set(key, previous, -1); // immediately stale
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  const deps = buildDeps();
  try {
    const visual = await enrichWithTmdb({ ...canonical, anilistId: 125 }, deps);
    assert.deepEqual(visual, previous); // stale value, NOT an error
  } finally {
    mock.restore();
    await cacheManager.invalidate(key);
  }
});

test('valid unresolved enrichment (no confident match) cached per explicit policy', async () => {
  const mock = installMockFetch(() => jsonResponse({ page: 1, results: [{ id: 999, name: 'Unrelated Show', first_air_date: '1990-01-01' }] }));
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(126));
    const visual = await enrichWithTmdb({ ...canonical, anilistId: 126 }, deps);
    assert.equal(visual.resolved, false); // valid unresolved, NOT a failure
    assert.equal(visual.reason, 'no_confident_match');
    // Unresolved results are cached too (shorter TTL), so repeat lookups avoid searches.
    await enrichWithTmdb({ ...canonical, anilistId: 126 }, deps);
    assert.equal(mock.calls.length, 1); // no details call without a match
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(126));
  }
});

test('TMDB not configured -> valid unresolved enrichment, AniList data fully intact', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload()));
  const deps = buildDeps({ apiKey: '' });
  try {
    await cacheManager.invalidate(visualKey(127));
    const visual = await enrichWithTmdb({ ...canonical, anilistId: 127 }, deps);
    assert.equal(visual.resolved, false);
    assert.equal(visual.reason, 'tmdb_not_configured');
    assert.equal(mock.calls.length, 0); // no TMDB call attempted
    // Existing canonical data is never replaced by null/empty objects.
    assert.equal(canonical.id, 123);
    assert.equal(canonical.title.userPreferred, 'One Punch Man');
    assert.deepEqual(canonical.images, { poster: null, cover: null, banner: null });
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(127));
  }
});

test('concurrent identical enrichments coalesce into one TMDB resolution', async () => {
  const mock = installMockFetch(tmdbRouter());
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(123));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => enrichWithTmdb(canonical, deps)),
    );
    assert.equal(mock.calls.length, 2); // 5 callers, 1 search + 1 details
    for (const visual of results) {
      assert.deepEqual(visual, results[0]);
    }
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(123));
  }
});

test('season derivation failure degrades gracefully (series match kept, season unresolved)', async () => {
  const mock = installMockFetch((call) => {
    const url = String(call.url);
    if (url.includes('/search/tv')) return jsonResponse(searchPayload());
    return jsonResponse({ error: 'boom' }, 500); // details endpoint fails
  });
  const deps = buildDeps();
  try {
    await cacheManager.invalidate(visualKey(129));
    const visual = await enrichWithTmdb({ ...canonical, anilistId: 129 }, deps);
    assert.equal(visual.resolved, true); // the entity match stands
    assert.equal(visual.tmdbId, 789);
    assert.equal(visual.tmdbSeasonNumber, null); // season unresolved, not guessed
    assert.equal(visual.season, null);
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(129));
  }
});

test('enrichment + merge: a TMDB failure never replaces existing canonical data', async () => {
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  const deps = buildDeps();
  const { mergeTmdbIntoCanonical } = await import('../src/normalizers/anime.merge.js');
  const target = { ...canonical, id: 128, anilistId: 128 }; // id mirrors anilistId
  try {
    await cacheManager.invalidate(visualKey(128));
    // Provider fails with no stale cache -> typed error propagates; the caller
    // keeps the original canonical data untouched (no destructive fallback).
    let visual = null;
    let failed = false;
    try {
      visual = await enrichWithTmdb(target, deps);
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
    assert.equal(visual, null);
    const merged = mergeTmdbIntoCanonical(target, visual);
    assert.deepEqual(merged.images, canonical.images); // unchanged
    assert.equal(merged.id, 128);
  } finally {
    mock.restore();
    await cacheManager.invalidate(visualKey(128));
  }
});
