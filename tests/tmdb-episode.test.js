/**
 * TMDB episode extraction + unified episode mapper tests
 * (tests/tmdb-episode.mapper.js + tests/tmdb-episode.service.js + the
 * GET /api/episodes/:id wiring).
 *
 * All fixtures are mocked; no live API calls. TMDB is CONFIGURED in this file
 * (tests/helpers/test-env-tmdb.js). NO Jikan handler is registered - any
 * Jikan call fails the test loudly, proving Jikan is never used when TMDB
 * provides the episodes.
 *
 * Covered:
 *   - One TMDB season with 3 episodes -> global episodes 1,2,3.
 *   - Two seasons (S1=3, S2=2) -> global S1E1=1 ... S2E2=5.
 *   - Hunter x Hunter-style 62 + 74 + 12 -> totalEpisodes = 148.
 *   - Season 0 / specials are excluded from the normal global sequence
 *     (and Season 0 is never even fetched).
 *   - Duplicate TMDB episode records are removed (stable dedup key:
 *     tmdbSeriesId + seasonNumber + episodeNumber).
 *   - Episodes are sorted correctly even when TMDB returns them out of order.
 *   - One season fails but another season is cached (partial result reported
 *     internally via diagnostics; the partial list is never cached; the
 *     failed season is retried on the next request without refetching the
 *     cached season).
 *   - The final unified episode list is cached (repeated requests make ZERO
 *     additional TMDB calls).
 *   - Concurrent requests are coalesced (5 parallel requests share ONE
 *     season-fetch operation).
 *   - TMDB provider failure uses the stale cached unified list.
 *   - TMDB failure with no cached data propagates the typed provider error
 *     (never fake/empty episode data, nothing cached as episode data).
 *   - No fake IDs or fake episode data are generated (missing/invalid entries
 *     dropped; missing paths -> null image, never fabricated).
 *   - The existing frontend response fields remain compatible (Jikan-era
 *     episode field names preserved; TMDB-specific fields added safely).
 *   - Identity namespace safety: :id stays the AniList ID; the TMDB series ID
 *     comes ONLY from the existing enrichment matching and never becomes the
 *     AniList ID.
 */

// Env setup MUST be the first import (ESM evaluates imports depth-first in
// order, so this runs before config/env.js loads).
import './helpers/test-env-tmdb.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  expireL1Entry,
  anilistMedia,
  tmdbSearchResults,
  tmdbTvCandidate,
  tmdbTvDetails,
  tmdbSeason,
  tmdbSeasonsList,
  anizipNotFound,
} from './helpers/test-server.js';
import { cacheManager } from '../src/cache/cache-manager.js';

const { extractTmdbSeasonEpisodes, mapTmdbSeasonsToGlobalEpisodes } = await import(
  '../src/normalizers/tmdb-episode.mapper.js'
);
const { getTmdbUnifiedEpisodes } = await import('../src/services/tmdb-episode.service.js');

// --- shared test constants ----------------------------------------------------

const ANILIST_ID = 123;
const MAL_ID = 456;
const TMDB_SERIES_ID = 789;

const COMPOSITE_KEY = `episodes:anilist:${ANILIST_ID}:page:1`;
const UNIFIED_KEY = `episodes:tmdb:unified:anilist:${ANILIST_ID}`;
const seasonKey = (n) => `tmdb:season:${TMDB_SERIES_ID}:${n}`;

// --- raw TMDB fixtures (unit level) -------------------------------------------

const rawEpisode = (id, seasonNumber, number, extra = {}) => ({
  id,
  season_number: seasonNumber,
  episode_number: number,
  name: `Ep S${seasonNumber}E${number}`,
  overview: `Overview S${seasonNumber}E${number}`,
  air_date: '2023-01-10',
  runtime: 24,
  still_path: `/still-s${seasonNumber}-e${number}.jpg`,
  vote_average: 7.5,
  vote_count: 10,
  episode_type: 'standard',
  ...extra,
});

const rawSeason = (seasonNumber, episodes) => ({
  id: TMDB_SERIES_ID,
  season_number: seasonNumber,
  name: `Season ${seasonNumber}`,
  episodes,
});

/** Raw seasons with the given episode counts: { 1: 62, 2: 74, ... }. */
const rawSeasons = (counts) =>
  Object.entries(counts).map(([n, count]) =>
    rawSeason(
      Number(n),
      Array.from({ length: count }, (_, i) => rawEpisode(Number(n) * 10000 + i + 1, Number(n), i + 1)),
    ),
  );

/** extract + map helper for raw season counts. */
const mapSeasons = (counts) =>
  mapTmdbSeasonsToGlobalEpisodes(
    rawSeasons(counts).map((raw) =>
      extractTmdbSeasonEpisodes(raw, { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: raw.season_number }),
    ),
    { tmdbSeriesId: TMDB_SERIES_ID },
  );

// --- endpoint mocks ------------------------------------------------------------

/** AniList mock: byId only (canonical metadata + identity resolver). */
function anilistHandler() {
  return (body) => {
    if (body.query.includes('$idMal')) throw new Error(`unexpected byMal query: ${body.query}`);
    const id = Number(body.variables?.id);
    if (id !== ANILIST_ID) throw new Error(`unexpected AniList id requested: ${id}`);
    return { data: { Media: anilistMedia({ id: ANILIST_ID, idMal: MAL_ID }) } };
  };
}

/**
 * TMDB mock routed by path, with mutable failure state:
 *   state.seasonEnabled[n] === false -> season n responds 500
 *   state.failAll                    -> TV details + seasons respond 500
 * Search always succeeds (the existing enrichment matching must resolve).
 */
function tmdbHandlerFactory({ seasons, seasonEpisodes, state = { seasonEnabled: {}, failAll: false } } = {}) {
  return (url) => {
    if (url.includes('/search/tv')) {
      return tmdbSearchResults([tmdbTvCandidate({ id: TMDB_SERIES_ID, name: 'Test Anime' })]);
    }
    const seasonMatch = url.match(/\/tv\/789\/season\/(\d+)(?:\?|$)/);
    if (seasonMatch) {
      const n = Number(seasonMatch[1]);
      if (state.failAll || state.seasonEnabled[n] === false) return { status: 500, json: {} };
      const episodes = seasonEpisodes?.[n];
      if (!episodes) throw new Error(`unexpected TMDB season: ${url}`);
      return tmdbSeason(n, episodes);
    }
    if (url.includes('/tv/789')) {
      if (state.failAll) return { status: 500, json: {} };
      return tmdbTvDetails(seasons);
    }
    throw new Error(`unexpected TMDB path: ${url}`);
  };
}

/** Endpoint-level TMDB episode fixture (reuses the raw fixture shape). */
function endpointEpisodes(counts) {
  const seasonEpisodes = {};
  for (const [n, count] of Object.entries(counts)) {
    seasonEpisodes[Number(n)] = Array.from({ length: count }, (_, i) =>
      rawEpisode(Number(n) * 10000 + i + 1, Number(n), i + 1),
    );
  }
  return seasonEpisodes;
}

/** Count TMDB season calls for one season number. */
const seasonCallCount = (mock, n) => mock.tmdbCalls().filter((u) => urlSeasonNumber(u) === n).length;

/** Extract the season number from a TMDB season call URL (null when not a season call). */
function urlSeasonNumber(url) {
  const match = url.match(/\/tv\/789\/season\/(\d+)(?:\?|$)/);
  return match ? Number(match[1]) : null;
}

// =================================================================================
// UNIT: the dedicated mapper/normalizer (pure functions)
// =================================================================================

test('mapper: one TMDB season with 3 episodes -> global episodes 1,2,3', () => {
  const { episodes, totalEpisodes } = mapSeasons({ 1: 3 });
  assert.equal(totalEpisodes, 3);
  assert.deepEqual(
    episodes.map((e) => e.globalEpisodeNumber),
    [1, 2, 3],
  );
  assert.deepEqual(
    episodes.map((e) => e.episode),
    [1, 2, 3],
  );
  // Both numbering systems preserved: TMDB's original numbering separate.
  assert.deepEqual(
    episodes.map((e) => [e.seasonNumber, e.episodeNumber, e.tmdbEpisodeId]),
    [
      [1, 1, 10001],
      [1, 2, 10002],
      [1, 3, 10003],
    ],
  );
  // Frontend fields come from actual TMDB data; image built from still_path.
  assert.equal(episodes[0].title, 'Ep S1E1');
  assert.equal(episodes[0].overview, 'Overview S1E1');
  assert.equal(episodes[0].aired, '2023-01-10');
  assert.equal(episodes[0].runtime, 24);
  assert.equal(episodes[0].score, 7.5);
  assert.equal(episodes[0].image, 'https://image.tmdb.org/t/p/w500/still-s1-e1.jpg');
  assert.equal(episodes[0].episodeType, 'standard');
  assert.equal(episodes[0].source, 'tmdb');
});

test('mapper: two seasons S1=3 + S2=2 -> global 1..5 (S2E1=4, S2E2=5)', () => {
  const { episodes, totalEpisodes } = mapSeasons({ 1: 3, 2: 2 });
  assert.equal(totalEpisodes, 5);
  const byGlobal = Object.fromEntries(episodes.map((e) => [e.globalEpisodeNumber, e]));
  assert.deepEqual(byGlobal[1], { ...byGlobal[1], seasonNumber: 1, episodeNumber: 1 });
  assert.deepEqual(byGlobal[3], { ...byGlobal[3], seasonNumber: 1, episodeNumber: 3 });
  assert.equal(byGlobal[4].seasonNumber, 2);
  assert.equal(byGlobal[4].episodeNumber, 1);
  assert.equal(byGlobal[4].tmdbEpisodeId, 20001);
  assert.equal(byGlobal[5].seasonNumber, 2);
  assert.equal(byGlobal[5].episodeNumber, 2);
  assert.equal(byGlobal[5].tmdbEpisodeId, 20002);
  // No duplicate global episode numbers.
  assert.equal(new Set(episodes.map((e) => e.globalEpisodeNumber)).size, 5);
});

test('mapper: Hunter x Hunter-style 62 + 74 + 12 -> totalEpisodes = 148', () => {
  const { episodes, totalEpisodes } = mapSeasons({ 1: 62, 2: 74, 3: 12 });
  assert.equal(totalEpisodes, 148);
  // Global numbers are exactly 1..148 - contiguous, never duplicated.
  assert.deepEqual(
    episodes.map((e) => e.globalEpisodeNumber),
    Array.from({ length: 148 }, (_, i) => i + 1),
  );
  // Spot checks from the task example.
  assert.equal(episodes[0].seasonNumber, 1);
  assert.equal(episodes[61].seasonNumber, 1);
  assert.equal(episodes[61].episodeNumber, 62); // global 62 = S1 E62
  assert.equal(episodes[62].seasonNumber, 2);
  assert.equal(episodes[62].episodeNumber, 1); // global 63 = S2 E1
  assert.equal(episodes[135].seasonNumber, 2);
  assert.equal(episodes[135].episodeNumber, 74); // global 136 = S2 E74
  assert.equal(episodes[136].seasonNumber, 3);
  assert.equal(episodes[136].episodeNumber, 1); // global 137 = S3 E1
  assert.equal(episodes[147].seasonNumber, 3);
  assert.equal(episodes[147].episodeNumber, 12); // global 148 = S3 E12
});

test('mapper: Season 0 / specials are excluded (never renumbered into the sequence)', () => {
  // Extraction REJECTS Season 0 outright.
  assert.throws(
    () => extractTmdbSeasonEpisodes(rawSeason(0, [rawEpisode(1, 0, 1)]), { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 0 }),
    (err) => err.name === 'ProviderError',
  );
  // Defensive mapper behavior: invalid/zero seasons are dropped even if handed in.
  const specialsSeason = {
    tmdbSeriesId: TMDB_SERIES_ID,
    seasonNumber: 0,
    episodes: [{ tmdbEpisodeId: 1, tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 0, episodeNumber: 1, name: 'Special' }],
  };
  const season1 = extractTmdbSeasonEpisodes(
    rawSeason(1, [rawEpisode(10001, 1, 1), rawEpisode(10002, 1, 2)]),
    { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 },
  );
  const { episodes, totalEpisodes } = mapTmdbSeasonsToGlobalEpisodes([specialsSeason, season1], {
    tmdbSeriesId: TMDB_SERIES_ID,
  });
  assert.equal(totalEpisodes, 2);
  assert.ok(episodes.every((e) => e.seasonNumber === 1), 'specials never mixed into the normal sequence');
  assert.ok(episodes.every((e) => e.title !== 'Special'));
});

test('mapper: duplicate TMDB episode records are removed (stable dedup key)', () => {
  const raw = rawSeason(1, [
    rawEpisode(10001, 1, 1),
    rawEpisode(10002, 1, 1), // duplicate episode number, different TMDB id
    rawEpisode(10003, 1, 2),
  ]);
  const season = extractTmdbSeasonEpisodes(raw, { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 });
  assert.equal(season.episodes.length, 2);
  // First occurrence kept - never fabricated.
  assert.deepEqual(
    season.episodes.map((e) => [e.episodeNumber, e.tmdbEpisodeId]),
    [
      [1, 10001],
      [2, 10003],
    ],
  );
});

test('mapper: episodes are sorted correctly even when TMDB returns them out of order', () => {
  const raw = rawSeason(1, [rawEpisode(10003, 1, 3), rawEpisode(10001, 1, 1), rawEpisode(10002, 1, 2)]);
  const season = extractTmdbSeasonEpisodes(raw, { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 });
  assert.deepEqual(
    season.episodes.map((e) => e.episodeNumber),
    [1, 2, 3],
  );

  // Seasons handed in out of order are also sorted numerically.
  const season2 = extractTmdbSeasonEpisodes(rawSeason(2, [rawEpisode(20001, 2, 1)]), {
    tmdbSeriesId: TMDB_SERIES_ID,
    seasonNumber: 2,
  });
  const { episodes } = mapTmdbSeasonsToGlobalEpisodes([season2, season], { tmdbSeriesId: TMDB_SERIES_ID });
  assert.deepEqual(
    episodes.map((e) => [e.globalEpisodeNumber, e.seasonNumber, e.episodeNumber]),
    [
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 3],
      [4, 2, 1],
    ],
  );
});

test('mapper: invalid episodes are ignored; no fake IDs or fabricated data', () => {
  const raw = rawSeason(1, [
    rawEpisode(10001, 1, 1, { id: null }), // missing episode ID -> dropped
    { id: 9002, episode_number: 0 }, // invalid episode number -> dropped
    { id: 9003, episode_number: -2 }, // invalid episode number -> dropped
    { id: 9004, episode_number: 'garbage' }, // invalid episode number -> dropped
    rawEpisode(9005, 1, 2, { still_path: null, overview: '', runtime: null, vote_average: null, vote_count: null }),
  ]);
  const season = extractTmdbSeasonEpisodes(raw, { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 });
  assert.equal(season.episodes.length, 1);
  const only = season.episodes[0];
  assert.equal(only.tmdbEpisodeId, 9005); // the ACTUAL TMDB id - never fabricated
  assert.equal(only.episodeNumber, 2);
  // Missing TMDB data stays null - never invented.
  assert.equal(only.image, null); // null still_path -> null URL (never fabricated)
  assert.equal(only.overview, null);
  assert.equal(only.runtime, null);
  assert.equal(only.voteAverage, null); // extracted-record field name (TMDB namespace)
  assert.equal(only.voteCount, null);
});

test('mapper: unusable season payloads throw typed errors (never cached as valid)', () => {
  assert.throws(
    () => extractTmdbSeasonEpisodes(null, { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 }),
    (err) => err.name === 'ProviderError',
  );
  assert.throws(
    () => extractTmdbSeasonEpisodes({ id: 789 }, { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 }),
    (err) => err.name === 'ProviderError',
  );
  assert.throws(
    () => extractTmdbSeasonEpisodes(rawSeason(1, []), { tmdbSeriesId: null, seasonNumber: 1 }),
    (err) => err.name === 'ProviderError',
  );
  assert.throws(
    () => extractTmdbSeasonEpisodes(rawSeason(1, []), { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 'abc' }),
    (err) => err.name === 'ProviderError',
  );
  // Empty-but-valid season is honest (a real TMDB 200 with no episodes).
  const empty = extractTmdbSeasonEpisodes(rawSeason(1, []), { tmdbSeriesId: TMDB_SERIES_ID, seasonNumber: 1 });
  assert.deepEqual(empty.episodes, []);
});

test('mapper: empty seasons input -> honest empty list (totalEpisodes 0)', () => {
  assert.deepEqual(mapTmdbSeasonsToGlobalEpisodes([], { tmdbSeriesId: TMDB_SERIES_ID }), {
    episodes: [],
    totalEpisodes: 0,
  });
  assert.deepEqual(mapTmdbSeasonsToGlobalEpisodes(null, { tmdbSeriesId: TMDB_SERIES_ID }), {
    episodes: [],
    totalEpisodes: 0,
  });
});

// =================================================================================
// ENDPOINT: GET /api/episodes/:id (real Express app, mocked fetch)
// =================================================================================

test('GET /api/episodes/:id -> one TMDB season (3 episodes) -> global 1,2,3 via the TMDB flow', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1]),
      seasonEpisodes: endpointEpisodes({ 1: 3 }),
    }),
    // NO jikan handler: any Jikan call fails loudly (TMDB is the source).
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Identity namespace safety: :id stays the AniList ID; the TMDB series ID
    // never becomes the AniList ID (it lives only in tmdbEpisodeId fields).
    assert.equal(body.id, ANILIST_ID);
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, MAL_ID);
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 3);
    assert.equal(body.pageInfo, null);

    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 3);
    assert.deepEqual(
      body.episodes.map((e) => e.globalEpisodeNumber),
      [1, 2, 3],
    );
    assert.deepEqual(
      body.episodes.map((e) => e.episode),
      [1, 2, 3],
    );
    assert.deepEqual(
      body.episodes.map((e) => [e.seasonNumber, e.episodeNumber, e.tmdbEpisodeId]),
      [
        [1, 1, 10001],
        [1, 2, 10002],
        [1, 3, 10003],
      ],
    );
    assert.equal(body.episodes[0].image, 'https://image.tmdb.org/t/p/w500/still-s1-e1.jpg');

    // Diagnostics: the AniList episode count is a REFERENCE signal only - the
    // real TMDB data is preserved and the mismatch is exposed, never corrupted.
    assert.ok(body.diagnostics && typeof body.diagnostics === 'object');
    assert.equal(body.diagnostics.anilistEpisodeCount, 12);
    assert.equal(body.diagnostics.tmdbEpisodeCount, 3);
    assert.equal(body.diagnostics.countsMatch, false);
    assert.deepEqual(body.diagnostics.failedSeasons, []);

    // The TMDB flow was used: search -> TV details -> the normal season.
    assert.ok(mock.tmdbCalls().some((u) => u.includes('/search/tv')));
    assert.ok(mock.tmdbCalls().some((u) => /\/tv\/789\?/.test(u)));
    assert.ok(mock.tmdbCalls().some((u) => /\/tv\/789\/season\/1(?:\?|$)/.test(u)));
    // Jikan was NEVER called for the TMDB-sourced episodes.
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> two seasons (3 + 2) -> global 1..5, episode field IS the global number', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: endpointEpisodes({ 1: 3, 2: 2 }),
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 5);
    assert.equal(body.pageInfo, null);
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 5);

    // episode === globalEpisodeNumber (what the frontend uses); TMDB's
    // original numbering preserved separately.
    const byGlobal = Object.fromEntries(body.episodes.map((e) => [e.globalEpisodeNumber, e]));
    assert.equal(byGlobal[3].seasonNumber, 1);
    assert.equal(byGlobal[3].episodeNumber, 3);
    assert.equal(byGlobal[3].tmdbEpisodeId, 10003);
    assert.equal(byGlobal[4].seasonNumber, 2);
    assert.equal(byGlobal[4].episodeNumber, 1);
    assert.equal(byGlobal[4].tmdbEpisodeId, 20001);
    assert.equal(byGlobal[5].seasonNumber, 2);
    assert.equal(byGlobal[5].episodeNumber, 2);
    assert.equal(byGlobal[5].tmdbEpisodeId, 20002);
    assert.equal(new Set(body.episodes.map((e) => e.episode)).size, 5);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> Hunter x Hunter-style 62 + 74 + 12 -> totalEpisodes = 148', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2, 3]),
      seasonEpisodes: endpointEpisodes({ 1: 62, 2: 74, 3: 12 }),
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 148);
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 148);

    // Global numbers are exactly 1..148 - contiguous, never duplicated, and
    // mirrored by the public `episode` field.
    assert.deepEqual(
      body.episodes.map((e) => e.globalEpisodeNumber),
      Array.from({ length: 148 }, (_, i) => i + 1),
    );
    assert.deepEqual(
      body.episodes.map((e) => e.episode),
      Array.from({ length: 148 }, (_, i) => i + 1),
    );

    // Spot checks from the task example.
    assert.deepEqual([body.episodes[61].seasonNumber, body.episodes[61].episodeNumber], [1, 62]);
    assert.deepEqual([body.episodes[62].seasonNumber, body.episodes[62].episodeNumber], [2, 1]);
    assert.deepEqual([body.episodes[135].seasonNumber, body.episodes[135].episodeNumber], [2, 74]);
    assert.deepEqual([body.episodes[136].seasonNumber, body.episodes[136].episodeNumber], [3, 1]);
    assert.deepEqual([body.episodes[147].seasonNumber, body.episodes[147].episodeNumber], [3, 12]);

    // Every normal season was fetched once, with bounded (sequential-equivalent
    // count) requests: 1 search + 1 details + 3 seasons.
    assert.equal(mock.tmdbCalls().length, 5);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> Season 0 specials are excluded (Season 0 never fetched)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: [{ season_number: 0, name: 'Specials', episode_count: 2 }, ...tmdbSeasonsList([1])],
      seasonEpisodes: {
        ...endpointEpisodes({ 1: 3 }),
        // If the flow wrongly fetched Season 0, these specials would leak in.
        0: [rawEpisode(8001, 0, 1, { name: 'Special' }), rawEpisode(8002, 0, 2, { name: 'Special' })],
      },
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 3); // only Season 1's episodes
    assert.ok(body.episodes.every((e) => e.seasonNumber === 1));
    assert.ok(!JSON.stringify(body.episodes).includes('Special'));

    // Season 0 / specials were NEVER fetched.
    assert.equal(mock.tmdbCalls().some((u) => /\/tv\/789\/season\/0(?:\?|$)/.test(u)), false);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> duplicate TMDB episode records are removed', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1]),
      seasonEpisodes: {
        1: [rawEpisode(10001, 1, 1), rawEpisode(10002, 1, 1), rawEpisode(10003, 1, 2)],
      },
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 2);
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);
    // First occurrence kept - never fabricated.
    assert.equal(body.episodes[0].tmdbEpisodeId, 10001);
    assert.equal(body.episodes[0].episodeNumber, 1);
    assert.equal(body.episodes[1].tmdbEpisodeId, 10003);
    assert.equal(body.episodes[1].episodeNumber, 2);
    assert.deepEqual(
      body.episodes.map((e) => e.globalEpisodeNumber),
      [1, 2],
    );
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> episodes sorted correctly even when TMDB returns them out of order', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: {
        1: [rawEpisode(10003, 1, 3), rawEpisode(10001, 1, 1), rawEpisode(10002, 1, 2)],
        2: [rawEpisode(20002, 2, 2), rawEpisode(20001, 2, 1)],
      },
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 5);
    assert.deepEqual(
      body.episodes.map((e) => [e.globalEpisodeNumber, e.seasonNumber, e.episodeNumber]),
      [
        [1, 1, 1],
        [2, 1, 2],
        [3, 1, 3],
        [4, 2, 1],
        [5, 2, 2],
      ],
    );
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> one season fails but another season is cached (no fabricated episodes)', async () => {
  await resetL1Cache();
  const state = { seasonEnabled: { 1: true, 2: false }, failAll: false };
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: endpointEpisodes({ 1: 3, 2: 2 }),
      state,
    }),
  });
  const server = await startTestServer();
  try {
    // Request 1: Season 2 fails; Season 1 succeeds -> PARTIAL result reported
    // internally (diagnostics), never fabricated, never cached.
    const res1 = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res1.status, 200);

    const body1 = await res1.json();
    assert.equal(body1.source, 'tmdb');
    assert.equal(body1.totalEpisodes, 3); // only the surviving season
    assert.ok(Array.isArray(body1.episodes) && body1.episodes.length === 3);
    assert.ok(body1.episodes.every((e) => e.seasonNumber === 1));
    assert.deepEqual(
      body1.diagnostics.failedSeasons.map((f) => f.seasonNumber),
      [2],
    );

    // The partial unified list is NEVER cached (the failed season is retried).
    assert.equal(await cacheManager.get(UNIFIED_KEY), null);
    // But Season 1's extracted episodes ARE cached independently.
    const cachedSeason1 = await cacheManager.get(seasonKey(1));
    assert.ok(cachedSeason1, 'the successful season was NOT cached');
    assert.ok(Array.isArray(cachedSeason1.episodes) && cachedSeason1.episodes.length === 3);

    // Request 2: Season 2 recovers. Season 1 comes from its per-season cache
    // (no refetch), Season 2 is fetched -> the full unified list.
    state.seasonEnabled[2] = true;
    const res2 = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res2.status, 200);

    const body2 = await res2.json();
    assert.equal(body2.source, 'tmdb');
    assert.equal(body2.totalEpisodes, 5);
    assert.deepEqual(body2.diagnostics.failedSeasons, []);

    // Season 1 was served from its per-season cache (fetched exactly once).
    assert.equal(seasonCallCount(mock, 1), 1);
    // Season 2: one FAILED attempt in request 1 + one successful retry in
    // request 2 - the retry is real, never a loop.
    assert.equal(seasonCallCount(mock, 2), 2);
    // The full unified list is now cached.
    const cachedUnified = await cacheManager.get(UNIFIED_KEY);
    assert.ok(cachedUnified);
    assert.equal(cachedUnified.totalEpisodes, 5);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> the final unified episode list is cached (zero refetches)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: endpointEpisodes({ 1: 3, 2: 2 }),
    }),
  });
  const server = await startTestServer();
  try {
    const res1 = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res1.status, 200);
    assert.equal((await res1.json()).totalEpisodes, 5);

    // The unified episode list was cached (normalized data, TMDB namespace).
    const cachedUnified = await cacheManager.get(UNIFIED_KEY);
    assert.ok(cachedUnified, 'unified episode list was NOT cached');
    assert.equal(cachedUnified.resolved, true);
    assert.equal(cachedUnified.tmdbSeriesId, TMDB_SERIES_ID);
    assert.equal(cachedUnified.totalEpisodes, 5);
    assert.ok(Array.isArray(cachedUnified.episodes) && cachedUnified.episodes.length === 5);

    // A repeated request makes ZERO additional TMDB calls.
    const tmdbCallsAfterFirst = mock.tmdbCalls().length;
    const res2 = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res2.status, 200);
    assert.equal((await res2.json()).totalEpisodes, 5);
    assert.equal(mock.tmdbCalls().length, tmdbCallsAfterFirst);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> 5 concurrent requests are coalesced (one season-fetch operation)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: endpointEpisodes({ 1: 3, 2: 2 }),
    }),
  });
  const server = await startTestServer();
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)),
    );
    for (const res of responses) {
      assert.equal(res.status, 200);
      assert.equal((await res.json()).totalEpisodes, 5);
    }

    // A single request costs 1 search + 1 details + 2 seasons = 4 TMDB calls.
    // Coalescing means 5 concurrent users trigger exactly that - no more.
    assert.equal(mock.tmdbCalls().length, 4);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> TMDB provider failure uses the stale cached unified list', async () => {
  await resetL1Cache();
  const state = { seasonEnabled: { 1: true, 2: true }, failAll: false };
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: endpointEpisodes({ 1: 3, 2: 2 }),
      state,
    }),
  });
  const server = await startTestServer();
  try {
    // Prime: a successful unified episode list is cached.
    const first = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).totalEpisodes, 5);

    // Age BOTH the composite and the unified list out (stale entries are
    // retained for stale-if-error).
    await expireL1Entry(COMPOSITE_KEY);
    await expireL1Entry(UNIFIED_KEY);

    // The TMDB request now fails entirely.
    state.failAll = true;
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // STALE cached unified data - never an error, never fabricated data.
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 5);
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 5);
    assert.equal(body.episodes[0].tmdbEpisodeId, 10001);
    assert.equal(body.episodes[0].title, 'Ep S1E1');

    // The failure was NOT cached as episode data: the unified entry still
    // holds the original successful list, untouched by the provider failure.
    const entry = cacheManager.l1._map.get(UNIFIED_KEY);
    assert.ok(entry);
    assert.equal(entry.value.resolved, true);
    assert.equal(entry.value.totalEpisodes, 5);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> TMDB failure with no cached data -> typed error (no fake empty success)', async () => {
  await resetL1Cache();
  const state = { seasonEnabled: { 1: true, 2: true }, failAll: true };
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1, 2]),
      seasonEpisodes: endpointEpisodes({ 1: 3, 2: 2 }),
      state,
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    // The typed provider error propagates - a provider outage is never hidden
    // behind fake/empty episode data.
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');

    // The failure was NOT cached as episode data.
    assert.equal(await cacheManager.get(COMPOSITE_KEY), null);
    assert.equal(await cacheManager.get(UNIFIED_KEY), null);
    assert.equal(await cacheManager.get(seasonKey(1)), null);
    assert.equal(await cacheManager.get(seasonKey(2)), null);

    // Only the search + TV details were attempted; no fake seasons.
    assert.ok(mock.tmdbCalls().some((u) => u.includes('/search/tv')));
    assert.ok(mock.tmdbCalls().some((u) => /\/tv\/789\?/.test(u)));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> no fake IDs or fake episode data (malformed entries dropped)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1]),
      seasonEpisodes: {
        1: [
          { episode_number: 1 }, // missing episode ID -> dropped (never fabricated)
          { id: 9002, episode_number: 0 }, // invalid episode number -> dropped
          { id: 9003, episode_number: 'garbage' }, // invalid episode number -> dropped
          rawEpisode(9005, 1, 2, { still_path: null }), // valid, image stays null
        ],
      },
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.source, 'tmdb');
    assert.equal(body.totalEpisodes, 1);
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 1);
    // The ONLY TMDB episode ID is the ACTUAL one from TMDB - never fabricated.
    assert.equal(body.episodes[0].tmdbEpisodeId, 9005);
    assert.equal(body.episodes[0].episodeNumber, 2);
    assert.equal(body.episodes[0].globalEpisodeNumber, 1);
    // A missing still_path becomes a null image URL - never a fabricated URL.
    assert.equal(body.episodes[0].image, null);
    assert.ok(body.episodes.every((e) => e.tmdbEpisodeId !== null && e.tmdbEpisodeId !== undefined));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('GET /api/episodes/:id -> existing frontend response fields remain compatible', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for these fixtures
    // -> the endpoint exercises the existing TMDB fallback path.
    anizip: anizipNotFound,
    anilist: anilistHandler(),
    tmdb: tmdbHandlerFactory({
      seasons: tmdbSeasonsList([1]),
      seasonEpisodes: endpointEpisodes({ 1: 3 }),
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Composite contract fields (Jikan-era names preserved).
    for (const field of ['id', 'anilistId', 'malId', 'totalEpisodes', 'pageInfo', 'episodes', 'source']) {
      assert.ok(field in body, `missing composite field: ${field}`);
    }
    assert.equal(body.source, 'tmdb');

    // Per-episode contract fields (Jikan-era names preserved) + the safe
    // TMDB-specific additions.
    const expectedEpisodeFields = [
      'episode',
      'globalEpisodeNumber',
      'seasonNumber',
      'episodeNumber',
      'tmdbEpisodeId',
      'malId',
      'title',
      'titleJapanese',
      'overview',
      'aired',
      'runtime',
      'score',
      'image',
      'filler',
      'recap',
      'episodeType',
      'source',
    ];
    for (const episode of body.episodes) {
      for (const field of expectedEpisodeFields) {
        assert.ok(field in episode, `missing episode field: ${field}`);
      }
    }
    // Fields TMDB cannot provide stay null (never invented).
    assert.equal(body.episodes[0].malId, null);
    assert.equal(body.episodes[0].titleJapanese, null);
    assert.equal(body.episodes[0].filler, null);
    assert.equal(body.episodes[0].recap, null);
    // The TMDB ID never became the AniList ID.
    assert.equal(body.id, ANILIST_ID);
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.episodes[0].tmdbEpisodeId, 10001);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

// =================================================================================
// SERVICE-level: TMDB stays optional enrichment
// =================================================================================

test('tmdb-episode service: TMDB not configured -> null (no request, no cache write)', async () => {
  await resetL1Cache();
  const result = await getTmdbUnifiedEpisodes(
    { anilistId: ANILIST_ID, title: { userPreferred: 'Test Anime' }, format: 'TV', seasonYear: 2023 },
    { provider: { isConfigured: () => false }, cache: cacheManager },
  );
  assert.equal(result, null);
  // No cache interplay happened at all.
  assert.equal(await cacheManager.get(UNIFIED_KEY), null);
  await resetL1Cache();
});

test('tmdb-episode service: no confident TMDB match -> null (caller falls back to Jikan)', async () => {
  await resetL1Cache();
  const fakeProvider = {
    isConfigured: () => true,
    searchTv: async () => ({ results: [] }),
  };
  const result = await getTmdbUnifiedEpisodes(
    {
      anilistId: 555,
      title: { userPreferred: 'Unmatched Anime' },
      format: 'TV',
      seasonYear: 2020,
    },
    { provider: fakeProvider, cache: cacheManager },
  );
  assert.equal(result, null);
  // The unresolved outcome was never cached as unified episode data.
  assert.equal(await cacheManager.get(`episodes:tmdb:unified:anilist:555`), null);
  await resetL1Cache();
});
