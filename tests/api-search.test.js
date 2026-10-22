/**
 * Phase 7 endpoint tests: GET /api/search and GET /api/top-search.
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. No live providers required.
 *
 * Covered: valid query, pagination, filters (validated enums), invalid query,
 * invalid filter, cached search (no repeat provider call), provider error
 * (never cached as a successful empty result), top-search contract + cache.
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
  anilistPage,
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

test('GET /api/search?q= -> 200 with normalized AniList results', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'search') throw new Error(`expected search, got: ${body.query}`);
      return anilistPage([anilistMedia({ id: 1, idMal: 11, title: 'Cowboy Bebop' })]);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search?q=cowboy`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.results) && body.results.length === 1);
    assert.equal(body.results[0].id, 1);
    assert.equal(body.results[0].anilistId, 1);
    assert.equal(body.results[0].malId, 11);
    // Display title prefers the English title; variants are explicit fields.
    assert.equal(body.results[0].title, 'Cowboy Bebop EN');
    assert.equal(body.results[0].titleEnglish, 'Cowboy Bebop EN');
    assert.equal(body.results[0].titleRomaji, 'Cowboy Bebop');
    assert.equal(body.results[0].titleNative, 'テスト');
    assert.ok(body.pageInfo);

    // The search query reached AniList inside the variables (never a raw URL).
    const call = mock.anilistCalls()[0];
    assert.equal(call.body.variables.search, 'cowboy');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/search -> pagination and filters mapped into AniList variables', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => anilistPage([]) });
  const server = await startTestServer();
  try {
    const res = await fetch(
      `${server.baseUrl}/api/search?q=x&page=2&perPage=10&season=WINTER&year=2023&format=TV&status=FINISHED&genre=Action&sort=SCORE_DESC`,
    );
    assert.equal(res.status, 200);

    const v = mock.anilistCalls()[0].body.variables;
    assert.equal(v.search, 'x');
    assert.equal(v.page, 2);
    assert.equal(v.perPage, 10);
    assert.equal(v.season, 'WINTER');
    assert.equal(v.seasonYear, 2023);
    assert.equal(v.format, 'TV');
    assert.equal(v.status, 'FINISHED');
    assert.equal(v.genre, 'Action');
    assert.deepEqual(v.sort, ['SCORE_DESC']);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/search -> invalid query / filters -> 400 ValidationError, no provider request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => anilistPage([]) });
  const server = await startTestServer();
  try {
    // Oversized query (bounded length).
    const longQ = 'a'.repeat(500);
    for (const url of [
      `${server.baseUrl}/api/search?q=${longQ}`,
      `${server.baseUrl}/api/search?q=x&page=0`,
      `${server.baseUrl}/api/search?q=x&perPage=999`,
      `${server.baseUrl}/api/search?q=x&season=NOTASEASON`,
      `${server.baseUrl}/api/search?q=x&format=NOTAFORMAT`,
      `${server.baseUrl}/api/search?q=x&status=NOTASTATUS`,
      `${server.baseUrl}/api/search?q=x&sort=NOTASORT`,
    ]) {
      const res = await fetch(url);
      assert.equal(res.status, 400, `expected 400 for ${url}`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }

    // Invalid input must never reach the provider.
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/search -> cached: second request makes zero provider calls', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => anilistPage([anilistMedia({ id: 2, idMal: 22 })]) });
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/search?q=hit`);
    assert.equal(first.status, 200);
    const callsAfterFirst = mock.calls.length;

    const second = await fetch(`${server.baseUrl}/api/search?q=hit`);
    assert.equal(second.status, 200);
    assert.equal(mock.calls.length, callsAfterFirst);

    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.deepEqual(secondBody, firstBody);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/search -> provider error -> 502, failure never cached as a successful empty result', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => ({ status: 500, json: { error: 'boom' } }) });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search?q=fail`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');

    // The failure was NOT cached: a follow-up request still reaches the
    // provider (no permanent empty page from an outage).
    const res2 = await fetch(`${server.baseUrl}/api/search?q=fail`);
    assert.equal(res2.status, 502);
    assert.equal(mock.anilistCalls().length, 2);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/search -> successful GENUINELY empty results are valid (200 with [])', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => anilistPage([]) });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search?q=nonexistent-anime-xyz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.results, []);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/top-search -> 200 popularity-ranked normalized suggestions (AniList data)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'search') throw new Error(`expected search, got: ${body.query}`);
      return anilistPage([
        anilistMedia({ id: 5, idMal: 55, title: 'Popular Anime' }),
        anilistMedia({ id: 6, idMal: 66, title: 'Other Anime' }),
      ]);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/top-search`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body) && body.length === 2);
    assert.equal(body[0].id, 5);
    assert.equal(body[0].anilistId, 5);
    assert.equal(body[0].malId, 55);

    // Derived from AniList popularity data (POPULARITY_DESC), no analytics.
    const v = mock.anilistCalls()[0].body.variables;
    assert.deepEqual(v.sort, ['POPULARITY_DESC']);

    // No invented search counts / analytics infrastructure.
    assert.ok(!('count' in body[0]));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/top-search -> cached (inherits anime service cache behavior)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => anilistPage([anilistMedia({ id: 7, idMal: 77 })]) });
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/top-search`);
    assert.equal(first.status, 200);
    const callsAfterFirst = mock.calls.length;

    const second = await fetch(`${server.baseUrl}/api/top-search`);
    assert.equal(second.status, 200);
    assert.equal(mock.calls.length, callsAfterFirst);
    assert.deepEqual(await second.json(), await first.json());
  } finally {
    await server.stop();
    mock.restore();
  }
});
