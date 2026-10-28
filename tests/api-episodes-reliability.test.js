/**
 * Episode reliability tests for GET /api/episodes/:id (the isolated episode
 * resolver/service): Jikan transient failures, stale-if-error, caching
 * behavior, and typed error propagation (Jikan is the ONLY detailed source -
 * no TMDB, no AniList fallback).
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. No live providers required. TMDB is NOT configured
 * in this file, so a TMDB call would fail the test loudly - exactly the proof
 * that TMDB is never part of episode details.
 *
 * Covered:
 *   - Jikan 200 -> normalized episodes cached (composite + Jikan page caches);
 *     second request served from cache with ZERO additional provider calls.
 *   - Jikan 504 -> exactly ONE bounded retry, then recovery on 200.
 *   - Jikan 504 with a STALE cached composite -> stale data returned, failure
 *     NEVER cached as episode data.
 *   - Jikan 504 without cache -> typed PROVIDER_ERROR propagated (a provider
 *     outage is never hidden behind fake/empty episode data) - nothing cached.
 *   - Jikan 200 with an empty data array -> honest empty episodes response.
 *   - Jikan 404 -> NO retry; typed NOT_FOUND propagated; nothing cached.
 *   - Jikan 429 -> single retry after the rate-limit window.
 *   - Multiple different AniList IDs resolve through the identity layer with
 *     id/anilistId/malId namespaces preserved; no fake MAL IDs.
 *   - Page-2 episode numbering uses the requested page (Jikan's mal_id).
 */

// Env setup MUST be the first import (ESM evaluates imports depth-first in
// order, so this runs before config/env.js loads).
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  expireL1Entry,
  anilistMedia,
  jikanEpisodes,
  jikanEpisode,
  anizipNotFound,
} from './helpers/test-server.js';
import { cacheManager } from '../src/cache/cache-manager.js';

/** Composite episode cache key (namespace-safe, AniList ID + page). */
function compositeKey(anilistId, page = 1) {
  return `episodes:anilist:${anilistId}:page:${page}`;
}

/** Jikan page cache key (namespace-safe, ACTUAL MAL ID + page). */
function jikanKey(malId, page = 1) {
  return `episodes:jikan:${malId}:page:${page}`;
}

/** @param {string} query */
function anilistKind(query) {
  // 'airingSchedule' matches both the per-anime airingSchedule field and the
  // legacy airingSchedules connection; the byId/byMal queries contain neither.
  if (query.includes('airingSchedule')) return 'schedule';
  if (query.includes('recommendations')) return 'recommendations';
  if (query.includes('relations')) return 'relations';
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  if (query.includes('$idMal')) return 'byMal';
  return 'byId';
}

/**
 * AniList mock serving per-ID Media for the byId query. The AniList provider
 * is the IDENTITY source only (idMal) - it never serves episode objects here.
 */
function anilistHandlerFactory(mapping) {
  return (body) => {
    const kind = anilistKind(body.query);
    if (kind !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
    const id = Number(body.variables?.id);
    if (!(id in mapping)) throw new Error(`unexpected AniList id requested: ${id}`);
    return { data: { Media: anilistMedia({ id, idMal: mapping[id] }) } };
  };
}

/** Raw JSON body describing a Jikan episodes page for a MAL ID. */
function episodesFor(malId, titles = ['Episode 1', 'Episode 2']) {
  return jikanEpisodes(titles.map((title, i) => jikanEpisode({ malId, number: i + 1, title })));
}

/** Count only Jikan EPISODE calls (excludes /full anime lookups). */
function episodeCallCount(mock) {
  return mock.jikanCalls().filter((u) => u.includes('/episodes')).length;
}

test('Jikan 200 -> normalized episodes are cached; second request served from cache', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) return episodesFor(456);
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.malId, 456);
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);

    // Concrete cache-write checks: the normalized page is cached under the
    // namespace-safe Jikan key (ACTUAL MAL ID + page) AND the composite under
    // the AniList ID + page key.
    const cachedPage = await cacheManager.get(jikanKey(456));
    assert.ok(cachedPage, 'Jikan episode page was NOT cached after a successful request');
    assert.ok(Array.isArray(cachedPage.episodes) && cachedPage.episodes.length === 2);
    assert.equal(cachedPage.episodes[0].title, 'Episode 1');
    assert.equal('mal_id' in cachedPage.episodes[0], false); // normalized, never raw

    const cachedComposite = await cacheManager.get(compositeKey(123));
    assert.ok(cachedComposite, 'composite episode result was NOT cached');
    assert.equal(cachedComposite.source, 'jikan');

    // Second request is served from cache: no additional Jikan episode call.
    const res2 = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res2.status, 200);
    assert.equal(episodeCallCount(mock), 1);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('Jikan 504 then 200 -> exactly ONE retry recovers, success is cached', async () => {
  await resetL1Cache();
  let episodeCalls = 0;
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) {
        episodeCalls += 1;
        if (episodeCalls === 1) return { status: 504, json: {} };
        return episodesFor(456);
      }
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);
    assert.equal(body.source, 'jikan');

    // Bounded retry: exactly one additional attempt, not an aggressive loop.
    assert.equal(episodeCalls, 2);

    // The recovered success IS cached for future resilience.
    assert.ok(await cacheManager.get(jikanKey(456)));
    assert.ok(await cacheManager.get(compositeKey(123)));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('Jikan 504 with stale cached episodes -> stale data returned, failure never cached', async () => {
  await resetL1Cache();
  let failEpisodes = false;
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) {
        if (failEpisodes) return { status: 504, json: {} };
        return episodesFor(456);
      }
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    // Prime the cache with a successful response, then age BOTH the composite
    // and the Jikan page out (stale entries are retained for stale-if-error).
    const first = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(first.status, 200);
    await expireL1Entry(compositeKey(123));
    await expireL1Entry(jikanKey(456));

    failEpisodes = true;
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.malId, 456);
    // STALE episode data - never an error or invented data.
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);
    assert.equal(body.episodes[0].title, 'Episode 1');
    assert.equal(body.episodes[1].title, 'Episode 2');

    // The failure was NOT cached: the L1 composite entry still holds the
    // original successful episode data, untouched by the 504.
    const entry = cacheManager.l1._map.get(compositeKey(123));
    assert.ok(entry);
    assert.ok(Array.isArray(entry.value.episodes));
    assert.equal(entry.value.episodes[0].title, 'Episode 1');
    assert.equal(entry.value.source, 'jikan');

    // Bounded retry applied (504 attempted twice), never more.
    assert.equal(episodeCallCount(mock) - 1, 2); // -1 for the priming success
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('Jikan 504 without cache -> typed PROVIDER_ERROR propagated (no fake/empty data, nothing cached)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) return { status: 504, json: {} };
      throw new Error(`unexpected Jikan path: ${url}`);
    },
    // No TMDB handler: TMDB is NOT configured in this env, so no TMDB request
    // may happen at all (TMDB is never part of episode details).
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    // A provider outage is NEVER hidden behind fake/empty episode data: the
    // typed Jikan error propagates (one bounded retry, then the error).
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');

    // Identity was still resolved through the AniList provider (idMal only):
    // one call for the canonical metadata + one for the IdentityResolver.
    assert.equal(mock.anilistCalls().length, 2);

    // One bounded Jikan retry (2 attempts), never a loop; NO TMDB calls.
    assert.equal(episodeCallCount(mock), 2);
    assert.equal(mock.tmdbCalls().length, 0);

    // The failure was NOT cached as episode data.
    assert.equal(await cacheManager.get(compositeKey(123)), null);
    assert.equal(await cacheManager.get(jikanKey(456)), null);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('Jikan 200 with an empty data array -> honest empty episodes response (cached)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) {
        return jikanEpisodes([], { last_visible_page: 1, has_next_page: false, current_page: 1, items: { count: 0, total: 0, per_page: 100 } });
      }
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // A valid Jikan 200 with zero listed episodes is reported honestly (never
    // fabricated, never an error). Jikan's pagination info is preferred.
    assert.equal(body.id, 123);
    assert.equal(body.anilistId, 123);
    assert.equal(body.malId, 456);
    assert.equal(body.source, 'jikan');
    assert.deepEqual(body.episodes, []);
    assert.equal(body.pageInfo.total, 0);
    assert.equal(body.totalEpisodes, 0);

    // Valid empty data IS cached (a successful Jikan response, not an error).
    assert.ok(await cacheManager.get(jikanKey(456)));
    assert.ok(await cacheManager.get(compositeKey(123)));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('Jikan 404 -> NO retry, typed NOT_FOUND propagated (nothing cached)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) return { status: 404, json: { error: 'not found' } };
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    // 404 (no episode list on MAL) is a typed not-found error - never hidden
    // behind fabricated data, never an empty success.
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');

    // Exactly one attempt: 404 is never retried, never cached.
    assert.equal(episodeCallCount(mock), 1);
    assert.equal(await cacheManager.get(jikanKey(456)), null);
    assert.equal(await cacheManager.get(compositeKey(123)), null);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('Jikan 429 then 200 -> single retry after the rate-limit window', async () => {
  await resetL1Cache();
  let episodeCalls = 0;
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) {
        episodeCalls += 1;
        if (episodeCalls === 1) {
          return new Response(JSON.stringify({}), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0' },
          });
        }
        return episodesFor(456);
      }
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);
    assert.equal(episodeCalls, 2); // one retry, not a loop
    assert.ok(await cacheManager.get(jikanKey(456)));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('multiple different AniList IDs resolve via IdentityResolver and return episodes', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 11: 111, 22: 222, 33: 333 }),
    jikan: (url) => {
      const full = url.match(/\/anime\/(\d+)\/full/);
      if (full) return { data: { mal_id: Number(full[1]), title: 'Test Anime' } };
      const eps = url.match(/\/anime\/(\d+)\/episodes/);
      if (eps) return episodesFor(Number(eps[1]), [`${eps[1]} Ep 1`]);
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    for (const [anilistId, malId] of [[11, 111], [22, 222], [33, 333]]) {
      const res = await fetch(`${server.baseUrl}/api/episodes/${anilistId}`);
      assert.equal(res.status, 200, `expected 200 for anilist id=${anilistId}`);
      const body = await res.json();
      // AniList ID stays canonical; MAL ID comes from the identity layer.
      assert.equal(body.id, anilistId);
      assert.equal(body.anilistId, anilistId);
      assert.equal(body.malId, malId);
      assert.ok(Array.isArray(body.episodes) && body.episodes.length === 1);
      assert.equal(body.episodes[0].malId, malId);
      assert.equal(body.episodes[0].source, 'jikan');
    }
    // No title-based/fuzzy identity substitution: no Jikan search requests.
    assert.ok(!mock.jikanCalls().some((u) => u.includes('q=')));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('page 2 request uses the requested page (Jikan page 2 requested, mal_id episode numbers)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> every test here exercises the existing Jikan fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes?page=2')) {
        return jikanEpisodes(
          [jikanEpisode({ malId: 456, number: 101, title: 'Episode 101' }), jikanEpisode({ malId: 456, number: 102, title: 'Episode 102' })],
          { last_visible_page: 2, has_next_page: false, current_page: 2, items: { count: 2, total: 2, per_page: 100 } },
        );
      }
      throw new Error(`unexpected Jikan path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123?page=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pageInfo.page, 2);
    assert.equal(body.pageInfo.lastPage, 2);
    assert.equal(body.pageInfo.hasNextPage, false);
    // `episode` comes from Jikan's mal_id (456), never derived from the page.
    assert.equal(body.episodes[0].episode, 456);
    assert.equal(body.episodes[1].episode, 456);
    assert.equal(body.episodes[0].title, 'Episode 101');
    // Exactly Jikan page 2 was requested - no other page, no multi-page fetch.
    const episodeCalls = mock.jikanCalls().filter((u) => u.includes('/episodes'));
    assert.equal(episodeCalls.length, 1);
    assert.ok(episodeCalls[0].includes('page=2'));
    assert.ok(await cacheManager.get(jikanKey(456, 2)));
    assert.ok(await cacheManager.get(compositeKey(123, 2)));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});
