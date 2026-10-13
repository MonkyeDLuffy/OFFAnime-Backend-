/**
 * Phase 7 endpoint tests: GET /api/episodes/:id, GET /api/jikan/anime/:malId,
 * and GET /api/jikan/from-anilist/:id.
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. No live providers required.
 *
 * Covered: valid/invalid IDs, episode METADATA only (NO MegaPlay, no stream
 * URLs), Jikan as the ONLY detailed-episode source (no TMDB, no AniList
 * fallback), missing MAL mapping, Jikan MAL-ID identity preservation, AniList
 * -> MAL resolution through the identity layer, no title-based identity
 * substitution, the ACTUAL MAL ID (never the AniList ID) sent to Jikan, and
 * page validation/passthrough.
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
  anilistMedia,
  jikanAnime,
  jikanEpisodes,
  jikanEpisode,
  anizipNotFound,
} from './helpers/test-server.js';

/** @param {string} query */
function anilistKind(query) {
  if (query.includes('airingSchedules')) return 'schedule';
  if (query.includes('recommendations')) return 'recommendations';
  if (query.includes('relations')) return 'relations';
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  if (query.includes('$idMal')) return 'byMal';
  return 'byId';
}

/** Jikan handler for anime/episodes paths keyed by MAL ID. */
function jikanHandlerFactory() {
  return (url) => {
    if (url.includes('/anime/456/full')) return jikanAnime({ malId: 456 });
    if (url.includes('/anime/456/episodes')) {
      return jikanEpisodes([jikanEpisode({ malId: 456, number: 1 }), jikanEpisode({ malId: 456, number: 2, title: 'Episode 2' })]);
    }
    throw new Error(`unexpected Jikan path: ${url}`);
  };
}

test('GET /api/episodes/:id -> 200 episode METADATA only (no MegaPlay, no stream URLs)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    // AniZip (the default episode source) has no mapping for this anime ->
    // the existing Jikan fallback engages.
    anizip: anizipNotFound,
    jikan: jikanHandlerFactory(),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Identity namespace safety: AniList ID stays the canonical id.
    assert.equal(body.id, 123);
    assert.equal(body.anilistId, 123);
    assert.equal(body.malId, 456);
    // Jikan's pagination info is preferred for episode details: the fixture
    // lists 2 episodes, so items.total (2) wins over the AniList count (12).
    assert.equal(body.totalEpisodes, 2);

    // Episode metadata from Jikan (normalized), no fabricated fields.
    // `episode` comes from Jikan's own mal_id (456) - never the list position.
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);
    assert.equal(body.episodes[0].episode, 456);
    assert.equal(body.episodes[0].malId, 456);
    assert.equal(body.episodes[0].title, 'Episode 1');
    assert.equal(body.episodes[0].filler, false);
    assert.equal(body.episodes[0].recap, false);
    assert.equal(body.source, 'jikan');

    // Phase 7 rule: NO MegaPlay, no stream URLs anywhere in the payload.
    assert.equal(mock.megaplayCalls().length, 0);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('megaplay'), 'no megaplay reference in payload');
    assert.ok(!raw.includes('stream'), 'no stream URLs in payload');

    // The ACTUAL MAL ID (456) was sent to Jikan - never the AniList ID (123).
    assert.ok(mock.jikanCalls().some((u) => u.includes('/anime/456/episodes')));
    assert.ok(!mock.jikanCalls().some((u) => u.includes('/anime/123/episodes')));
    assert.ok(!mock.jikanCalls().some((u) => u.includes('q=')), 'no title/fuzzy Jikan search');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/episodes/:id?page=1 -> requests Jikan page 1 (page param honored)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    anizip: anizipNotFound,
    jikan: jikanHandlerFactory(),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123?page=1`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.pageInfo.page, 1);
    assert.equal(body.source, 'jikan');

    // Exactly the requested Jikan page: page 1 -> the Jikan episodes endpoint
    // (Jikan defaults to page 1; no other page requested).
    const episodeCalls = mock.jikanCalls().filter((u) => u.includes('/episodes'));
    assert.equal(episodeCalls.length, 1);
    assert.ok(episodeCalls[0].includes('/anime/456/episodes'));
    assert.ok(!episodeCalls[0].includes('page=2'));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/episodes/:id -> invalid page -> 400 ValidationError, no provider request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => { throw new Error('must not be called'); },
    jikan: () => { throw new Error('must not be called'); },
  });
  const server = await startTestServer();
  try {
    for (const page of ['0', '-2', 'abc', '1.5']) {
      const res = await fetch(`${server.baseUrl}/api/episodes/123?page=${encodeURIComponent(page)}`);
      assert.equal(res.status, 400, `expected 400 for page=${page}`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(mock.anilistCalls().length, 0);
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/episodes/:id -> invalid ID -> 400 ValidationError, no provider request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => { throw new Error('must not be called'); },
    jikan: () => { throw new Error('must not be called'); },
  });
  const server = await startTestServer();
  try {
    for (const id of ['abc', '0', '-1']) {
      const res = await fetch(`${server.baseUrl}/api/episodes/${encodeURIComponent(id)}`);
      assert.equal(res.status, 400, `expected 400 for id=${id}`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(mock.anilistCalls().length, 0);
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/episodes/:id -> missing MAL mapping -> null episodes (never fake data)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 321, idMal: null }) } };
    },
    jikan: () => { throw new Error('Jikan must NOT be called without a MAL mapping'); },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/321`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.malId, null);
    assert.equal(body.episodes, null);
    assert.equal(body.pageInfo, null);
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/jikan/anime/:malId -> 200 Jikan payload with malId-only identity', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ jikan: jikanHandlerFactory() });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/jikan/anime/456`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // MAL ID stays in the Jikan SECONDARY namespace: never converted into
    // `id`/`anilistId`.
    assert.equal(body.malId, 456);
    assert.ok(!('id' in body), 'no canonical id on Jikan response');
    assert.ok(!('anilistId' in body), 'no anilistId on Jikan response');
    assert.equal(body.title.default, 'Test Anime');
    assert.equal(body.title.english, 'Test Anime EN');
    assert.equal(body.score, 8.5);

    // AniList must not be involved for a direct MAL lookup.
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/jikan/anime/:malId -> invalid MAL ID -> 400 ValidationError, no provider request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ jikan: () => { throw new Error('must not be called'); } });
  const server = await startTestServer();
  try {
    for (const malId of ['abc', '0', '-3', '1.5']) {
      const res = await fetch(`${server.baseUrl}/api/jikan/anime/${encodeURIComponent(malId)}`);
      assert.equal(res.status, 400, `expected 400 for malId=${malId}`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/jikan/from-anilist/:id -> AniList ID -> IdentityResolver -> MAL ID -> Jikan', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    jikan: jikanHandlerFactory(),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/jikan/from-anilist/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.malId, 456);
    assert.ok(!('anilistId' in body));

    // AniList was consulted for the mapping (provider idMal), Jikan fetched.
    assert.equal(mock.anilistCalls().length, 1);
    assert.equal(mock.jikanCalls().length, 1);
    assert.ok(mock.jikanCalls()[0].includes('/anime/456/full'));

    // NO title-based identity substitution: no Jikan search request.
    assert.ok(!mock.jikanCalls().some((u) => u.includes('q=')));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/jikan/from-anilist/:id -> no MAL mapping -> 404 unresolved (no Jikan, no title search)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: null }) } };
    },
    jikan: () => { throw new Error('Jikan must NOT be called when the mapping is unresolved'); },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/jikan/from-anilist/123`);
    assert.equal(res.status, 404);

    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/jikan/from-anilist/:id -> invalid ID -> 400 ValidationError', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => { throw new Error('must not be called'); },
    jikan: () => { throw new Error('must not be called'); },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/jikan/from-anilist/abc`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(mock.anilistCalls().length, 0);
    assert.equal(mock.jikanCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});
