/**
 * Phase 7 endpoint tests: GET /api/details/:id and GET /api/smart/details/:id.
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. No live providers required (TMDB is unconfigured
 * here, so its enrichment resolves as a VALID unresolved result).
 *
 * Covered: valid AniList ID, invalid ID, AniList success, Jikan enrichment,
 * missing MAL mapping (no Jikan request), TMDB unresolved, provider failure +
 * stale fallback, identity namespace safety, smart-details cache reuse with no
 * duplicate provider calls.
 */

// Env setup MUST be the first import (ESM evaluates imports depth-first in
// order, so this runs before config/env.js loads). TMDB is intentionally left
// UNCONFIGURED here so its enrichment resolves as a valid unresolved result.
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  expireL1Entry,
  anilistMedia,
  jikanAnime,
} from './helpers/test-server.js';

const DETAILS_KEY = 'api:details:anilist:123';

/** @param {string} query */
function anilistKind(query) {
  if (query.includes('airingSchedules')) return 'schedule';
  if (query.includes('recommendations')) return 'recommendations';
  if (query.includes('relations')) return 'relations';
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  if (query.includes('$idMal')) return 'byMal';
  return 'byId';
}

/** AniList handler serving a full anime by ID (with optional idMal override). */
function anilistAnimeHandler({ idMal = 456, relations = [], recommendations = [] } = {}) {
  return (body) => {
    const kind = anilistKind(body.query);
    if (kind === 'byId') {
      // Respect the requested ID: unknown IDs are Media null (AniList 404 path).
      if (body.variables.id !== 123) {
        return { data: { Media: null } };
      }
      return { data: { Media: anilistMedia({ id: 123, idMal }) } };
    }
    if (kind === 'relations') {
      if (body.variables.id !== 123) {
        return { data: { Media: null } };
      }
      return { data: { Media: { relations: { nodes: relations } } } };
    }
    if (kind === 'recommendations') {
      if (body.variables.id !== 123) {
        return { data: { Media: null } };
      }
      return { data: { Media: { recommendations: { nodes: recommendations } } } };
    }
    throw new Error(`expected byId, relations, or recommendations, got: ${kind}`);
  };
}

test('GET /api/details/:id -> 200 canonical AniList response (identity namespace safety)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: anilistAnimeHandler({}) });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Canonical identity: id === anilistId; MAL ID stays in its own namespace.
    assert.equal(body.id, 123);
    assert.equal(body.anilistId, 123);
    assert.equal(body.malId, 456);

    // AniList is authoritative for these fields.
    assert.deepEqual(body.title, { romaji: 'Test Anime', english: 'Test Anime EN', native: 'テスト', userPreferred: 'Test Anime' });
    assert.equal(body.format, 'TV');
    assert.equal(body.status, 'FINISHED');
    assert.equal(body.episodes, 12);
    assert.equal(body.season, 'WINTER');
    assert.equal(body.seasonYear, 2023);
    assert.deepEqual(body.genres, ['Action', 'Adventure']);
    assert.equal(body.averageScore, 85);

    // Namespaced enrichment structure exists (TMDB unconfigured -> unresolved,
    // which attaches NO visuals; jikan enrichment merged below).
    assert.ok('enrichment' in body);
    assert.ok(body.source.anilist === true);

    // Banner: AniList provided none -> null (a poster is never faked as banner).
    assert.equal(body.images.banner, null);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> Jikan enrichment merged; AniList identity untouched', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistAnimeHandler({}),
    jikan: (url) => {
      if (!url.includes('/anime/456/full')) throw new Error(`unexpected Jikan path: ${url}`);
      return jikanAnime({ malId: 456, title: 'Test Anime' });
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Jikan secondary data lives in enrichment (scores never merged across scales).
    assert.ok(body.enrichment && body.enrichment.jikan);
    assert.equal(body.enrichment.jikan.malId, 456);
    assert.equal(body.enrichment.jikan.score, 8.5);

    // Identity stays AniList's.
    assert.equal(body.id, 123);
    assert.equal(body.anilistId, 123);
    assert.equal(body.malId, 456);

    // Exactly three AniList requests (byId + relations + recommendations) and one Jikan request (no duplicates).
    assert.equal(mock.anilistCalls().length, 3);
    assert.equal(mock.jikanCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> missing MAL mapping: malId null, no Jikan request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistAnimeHandler({ idMal: null }),
    jikan: () => {
      throw new Error('Jikan must NOT be called when no MAL mapping exists');
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // malId is null ONLY because the AniList mapping genuinely does not exist.
    assert.equal(body.malId, null);
    assert.equal(body.anilistId, 123);
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> TMDB unconfigured: valid unresolved, AniList data intact', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistAnimeHandler({}),
    tmdb: () => {
      throw new Error('TMDB must NOT be requested when unconfigured');
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Canonical data fully intact despite TMDB being unavailable.
    assert.equal(body.id, 123);
    assert.equal(body.title.romaji, 'Test Anime');
    assert.equal(body.images.banner, null);
    assert.equal(mock.tmdbCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> invalid ID -> 400 ValidationError, no provider request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => { throw new Error('must not be called'); } });
  const server = await startTestServer();
  try {
    for (const id of ['abc', '0', '-5', '1.5']) {
      const res = await fetch(`${server.baseUrl}/api/details/${encodeURIComponent(id)}`);
      assert.equal(res.status, 400, `expected 400 for id=${id}`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> unknown anime -> 404 NOT_FOUND', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: anilistAnimeHandler({}) });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/999999`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> provider failure -> 502; failure never cached as valid data', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => ({ status: 500, json: { error: 'boom' } }) });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');

    // Failure was not cached: the next request reaches the provider again.
    const res2 = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res2.status, 502);
    assert.equal(mock.anilistCalls().length, 2);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/details/:id -> provider failure with stale cache -> stale fallback served', async () => {
  await resetL1Cache();
  const server = await startTestServer();
  let failing = false;
  const mock = installApiMocks({
    anilist: (body) => {
      if (failing) return { status: 500, json: { error: 'boom' } };
      return anilistAnimeHandler({})(body);
    },
    jikan: (url) => (failing ? { status: 500, json: { error: 'boom' } } : jikanAnime({})),
  });
  try {
    const good = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(good.status, 200);
    const goodBody = await good.json();

    expireL1Entry(DETAILS_KEY);
    failing = true;

    const res = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), goodBody);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/smart/details/:id -> same canonical payload; cache shared with /details (zero duplicate calls)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistAnimeHandler({}),
    jikan: () => jikanAnime({}),
  });
  const server = await startTestServer();
  try {
    // A cold smart/details request makes exactly three AniList + one Jikan call (byId + relations + recommendations).
    const smart = await fetch(`${server.baseUrl}/api/smart/details/123`);
    assert.equal(smart.status, 200);
    assert.equal(mock.anilistCalls().length, 3);
    assert.equal(mock.jikanCalls().length, 1);

    // A follow-up details request is served entirely from the shared cache.
    const details = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(details.status, 200);
    assert.equal(mock.anilistCalls().length, 3);
    assert.equal(mock.jikanCalls().length, 1);

    assert.deepEqual(await details.json(), await smart.json());
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/smart/details/:id -> no duplicate AniList fetches within one request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistAnimeHandler({}),
    jikan: () => jikanAnime({}),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/smart/details/123`);
    assert.equal(res.status, 200);
    // Exactly THREE AniList requests (byId + relations + recommendations, component cache reused by the composite).
    assert.equal(mock.anilistCalls().length, 3);
    assert.equal(mock.jikanCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});
