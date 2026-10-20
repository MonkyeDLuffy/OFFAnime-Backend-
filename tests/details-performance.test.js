/**
 * Details-pipeline performance & resilience tests (performance pass).
 *
 * Uses the real Express app on an ephemeral port with mocked fetch routed by
 * provider host, with TMDB CONFIGURED and a SHORT enrichment deadline so the
 * bounded-deadline behavior is observable without slow tests.
 *
 * Every test uses its OWN anime ID: these tests intentionally leave slow
 * in-flight background loads behind (deadline-skipped enrichments keep running
 * and later fill their component caches), so shared cache/coalescer keys would
 * leak state between tests.
 *
 * Covered:
 *   1. Jikan + TMDB enrichment run CONCURRENTLY (not sequentially).
 *   2. A slow optional provider (past ENRICHMENT_TIMEOUT_MS) does not delay
 *      core AniList details beyond the deadline (enrichment simply skipped,
 *      existing schema behavior).
 *   3. A late-completing enrichment still populates its component cache, so a
 *      later composite refresh includes it without a new upstream call.
 *   4. Optional provider failures (HTTP 500) keep AniList details intact.
 *   5. TMDB expanded-title fallback: unresolved first pass + Jikan alternate
 *      titles -> one bounded retry with NEW titles only; banner preserved.
 *   6. Concurrent same-anime requests are coalesced (single upstream load).
 *   7. Required AniList failure keeps the canonical 502 error behavior.
 */

// Env setup MUST be the first import: TMDB configured + short deadline.
import './helpers/test-env-details-perf.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  expireL1Entry,
  anilistMedia,
  jikanAnime,
  tmdbSearchResults,
  tmdbTvCandidate,
} from './helpers/test-server.js';

function anilistHandler({ anilistId, malId, title = 'Test Anime', sparseTitles = false } = {}) {
  return (body) => {
    if (body.variables?.id !== anilistId) return { data: { Media: null } };
    return {
      data: {
        Media: anilistMedia({
          id: anilistId,
          idMal: malId,
          title,
          extra: sparseTitles
            ? { title: { romaji: title, english: null, native: null, userPreferred: title } }
            : {},
        }),
      },
    };
  };
}

/**
 * TMDB router: search results with a confident match + TV details (with a
 * seasons list) for the season-derivation step.
 */
const tmdbMatchHandler = (url) => {
  const u = String(url);
  if (u.includes('/search/')) {
    return tmdbSearchResults([tmdbTvCandidate({ id: 789, name: 'Test Anime' })]);
  }
  return {
    status: 200,
    json: {
      id: 789,
      name: 'Test Anime',
      first_air_date: '2015-01-10',
      seasons: [{ season_number: 1, name: 'Season 1', air_date: '2015-01-10', episode_count: 12, poster_path: null }],
    },
  };
};

test('details: Jikan and TMDB enrichment run concurrently (overlapping, not sequential)', async () => {
  const ANI = 123;
  await resetL1Cache();
  const callTimes = { jikanStart: 0, tmdbStart: 0, jikanEnd: 0 };
  const mock = installApiMocks({
    anilist: anilistHandler({ anilistId: ANI, malId: 456 }),
    jikan: async () => {
      callTimes.jikanStart = Date.now();
      await sleep(120);
      callTimes.jikanEnd = Date.now();
      return jikanAnime({});
    },
    tmdb: async (url) => {
      callTimes.tmdbStart = Date.now();
      await sleep(120);
      return tmdbMatchHandler(url);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.id, ANI);
    assert.equal(body.anilistId, ANI);
    assert.equal(body.malId, 456);

    // Both legs ran, and TMDB started BEFORE Jikan finished => overlap.
    assert.ok(callTimes.jikanStart > 0 && callTimes.tmdbStart > 0, 'both enrichment legs were called');
    assert.ok(
      callTimes.tmdbStart < callTimes.jikanEnd,
      `expected concurrent execution (tmdb start ${callTimes.tmdbStart} < jikan end ${callTimes.jikanEnd})`,
    );
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('details: slow Jikan past the enrichment deadline does not delay core AniList details', async () => {
  const ANI = 201;
  await resetL1Cache();
  let jikanCalled = false;
  const mock = installApiMocks({
    anilist: anilistHandler({ anilistId: ANI, malId: 601 }),
    jikan: async () => {
      jikanCalled = true;
      await sleep(2000); // far beyond the 300ms enrichment deadline
      return jikanAnime({});
    },
    tmdb: tmdbMatchHandler,
  });
  const server = await startTestServer();
  try {
    const t0 = Date.now();
    const res = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);

    // Core details returned right after the deadline (~300ms + AniList leg),
    // NOT after the slow provider (2000ms).
    assert.ok(elapsed < 1500, `expected response before 1500ms, got ${elapsed}ms`);

    const body = await res.json();
    // AniList data fully intact; the timed-out enrichment is simply absent
    // (same schema behavior as a provider failure).
    assert.equal(body.id, ANI);
    assert.equal(body.anilistId, ANI);
    assert.equal(body.title.romaji, 'Test Anime');
    assert.equal(jikanCalled, true, 'Jikan was attempted (not skipped outright)');
    assert.equal(body.enrichment?.jikan ?? null, null);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('details: a late-completing enrichment still fills its component cache for the next refresh', async () => {
  const ANI = 202;
  const DETAILS_KEY = `api:details:anilist:${ANI}`;
  await resetL1Cache();
  let jikanCalls = 0;
  const mock = installApiMocks({
    anilist: anilistHandler({ anilistId: ANI, malId: 602 }),
    jikan: async () => {
      jikanCalls += 1;
      await sleep(700); // completes after the 300ms deadline
      return jikanAnime({ malId: 602 });
    },
    tmdb: tmdbMatchHandler,
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    assert.equal(res.status, 200);
    assert.equal(jikanCalls, 1);

    // Wait out the late Jikan completion (component write).
    await sleep(800);

    // Expire the composite; the refresh must pick up the now-cached Jikan
    // component WITHOUT a new Jikan upstream call.
    expireL1Entry(DETAILS_KEY);
    const res2 = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(jikanCalls, 1, 'no new Jikan request after the late fill');
    assert.ok(body2.enrichment?.jikan, 'refreshed composite includes the late Jikan enrichment');
    assert.equal(body2.enrichment.jikan.malId, 602);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('details: optional provider failures (Jikan + TMDB 500) keep AniList details fully intact', async () => {
  const ANI = 203;
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistHandler({ anilistId: ANI, malId: 603 }),
    jikan: () => ({ status: 500, json: { error: 'boom' } }),
    tmdb: () => ({ status: 500, json: { error: 'boom' } }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, ANI);
    assert.equal(body.anilistId, ANI);
    assert.equal(body.malId, 603);
    assert.equal(body.title.romaji, 'Test Anime');
    assert.equal(body.enrichment?.jikan ?? null, null);
    assert.equal(body.enrichment?.tmdb ?? null, null);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('details: TMDB expanded-title fallback resolves via Jikan titles without re-searching attempted titles', async () => {
  const ANI = 204;
  await resetL1Cache();
  const searchedQueries = [];
  const mock = installApiMocks({
    // AniList provides exactly ONE distinct title; Jikan brings an alternate.
    anilist: anilistHandler({ anilistId: ANI, malId: 604, title: 'Zoku Anime', sparseTitles: true }),
    jikan: () => jikanAnime({ malId: 604, title: 'Zoku Anime', extra: { title_english: 'Sequel Anime EN' } }),
    tmdb: (url) => {
      // TV details (season derivation) - not a search, never recorded.
      if (!String(url).includes('/search/')) {
        return {
          status: 200,
          json: {
            id: 789,
            name: 'Sequel Anime EN',
            first_air_date: '2023-01-10',
            seasons: [{ season_number: 1, name: 'Season 1', air_date: '2023-01-10', episode_count: 12, poster_path: null }],
          },
        };
      }
      const query = new URL(url).searchParams.get('query') ?? '';
      searchedQueries.push(query);
      // The AniList title has NO confident match; the Jikan alternate does.
      if (query === 'Sequel Anime EN') {
        return tmdbSearchResults([tmdbTvCandidate({ id: 789, name: 'Sequel Anime EN' })]);
      }
      return tmdbSearchResults([]);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    // First pass searched only the AniList title; the fallback added exactly
    // the new Jikan title; the attempted title was NOT re-searched.
    assert.deepEqual(searchedQueries, ['Zoku Anime', 'Sequel Anime EN']);

    // Banner enrichment preserved via the fallback.
    assert.equal(body.enrichment?.tmdb?.tmdbId, 789);
    assert.equal(body.images.banner, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
    assert.equal(body.enrichment?.jikan?.malId, 604);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('details: concurrent same-anime requests are coalesced into one upstream load', async () => {
  const ANI = 205;
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistHandler({ anilistId: ANI, malId: 605 }),
    jikan: () => jikanAnime({ malId: 605 }),
    tmdb: tmdbMatchHandler,
  });
  const server = await startTestServer();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${server.baseUrl}/api/details/${ANI}`)),
    );
    for (const res of results) {
      assert.equal(res.status, 200);
      await res.json();
    }
    // One shared load: exactly 1 AniList + 1 Jikan + 1 TMDB search + 1 TMDB
    // details (season derivation), all coalesced across the 8 requests.
    assert.equal(mock.anilistCalls().length, 1);
    assert.equal(mock.jikanCalls().length, 1);
    assert.equal(mock.tmdbCalls().length, 2);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('details: required AniList failure still yields the canonical 502 error behavior', async () => {
  const ANI = 206;
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => ({ status: 500, json: { error: 'boom' } }),
    jikan: () => jikanAnime({}),
    tmdb: tmdbMatchHandler,
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/${ANI}`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');
    // Optional providers were never consulted (AniList failed first).
    assert.equal(mock.jikanCalls().length, 0);
    assert.equal(mock.tmdbCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});
