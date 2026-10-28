/**
 * Jikan FALLBACK tests for GET /api/episodes/:id (the isolated episode
 * resolver/service): TMDB is the PRIMARY detailed-episode provider and Jikan
 * is the FALLBACK used only when TMDB cannot provide episodes at all (not
 * configured / no confident match). No AniList episode fallback exists.
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. TMDB IS configured here (test-env-tmdb.js), so the
 * Jikan fallback path is exercised by giving TMDB a search with no confident
 * match; any unexpected TMDB request (season/details fetch) fails these
 * assertions loudly. No live providers required.
 *
 * Covered:
 *   - TMDB has no confident match -> Jikan fallback serves episodes (source
 *     'jikan'); only TMDB SEARCH calls were made (no season/details fetch).
 *   - TMDB no confident match + Jikan 504 -> typed PROVIDER_ERROR propagated
 *     after ONE bounded retry (no fake/empty episode data hides the outage).
 *   - No MAL mapping -> honest unavailable response with ZERO Jikan AND ZERO
 *     TMDB calls (the AniList ID is never sent to Jikan).
 *   - The ACTUAL MAL ID (never the AniList ID) is sent to Jikan; id/anilistId
 *     /malId namespaces preserved.
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
  anilistMedia,
  jikanEpisodes,
  jikanEpisode,
  tmdbSearchResults,
  anizipNotFound,
} from './helpers/test-server.js';
import { cacheManager } from '../src/cache/cache-manager.js';

/** @param {string} query */
function anilistKind(query) {
  if (query.includes('airingSchedule')) return 'schedule';
  if (query.includes('recommendations')) return 'recommendations';
  if (query.includes('relations')) return 'relations';
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  if (query.includes('$idMal')) return 'byMal';
  return 'byId';
}

/** AniList mock serving per-ID Media for the byId query (identity source only). */
function anilistHandlerFactory(mapping) {
  return (body) => {
    const kind = anilistKind(body.query);
    if (kind !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
    const id = Number(body.variables?.id);
    if (!(id in mapping)) throw new Error(`unexpected AniList id requested: ${id}`);
    return { data: { Media: anilistMedia({ id, idMal: mapping[id] }) } };
  };
}

/** Count only Jikan EPISODE calls (excludes /full anime lookups). */
function episodeCallCount(mock) {
  return mock.jikanCalls().filter((u) => u.includes('/episodes')).length;
}

test('TMDB no confident match -> Jikan fallback serves episodes (source jikan)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for this anime ->
    // the existing TMDB -> Jikan fallback chain engages.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) {
        return jikanEpisodes([jikanEpisode({ malId: 456, number: 1 }), jikanEpisode({ malId: 456, number: 2, title: 'Episode 2' })]);
      }
      throw new Error(`unexpected Jikan path: ${url}`);
    },
    // No confident TMDB match exists -> the valid unresolved outcome; the
    // caller falls back to Jikan. No TMDB season/details fetch happens.
    tmdb: () => tmdbSearchResults([]),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Canonical identity preserved; Jikan is the detailed fallback source.
    assert.equal(body.id, 123);
    assert.equal(body.anilistId, 123);
    assert.equal(body.malId, 456);
    assert.equal(body.source, 'jikan');
    assert.ok(Array.isArray(body.episodes) && body.episodes.length === 2);
    // `episode` comes from Jikan's mal_id - never a fabricated/position number.
    assert.equal(body.episodes[0].episode, 456);
    assert.equal(body.episodes[0].malId, 456);
    assert.equal(body.episodes[0].source, 'jikan');

    // The ACTUAL MAL ID (never the AniList ID) was sent to Jikan.
    assert.ok(mock.jikanCalls().some((u) => u.includes('/anime/456/episodes')));
    assert.ok(!mock.jikanCalls().some((u) => u.includes('/anime/123/episodes')));

    // Only TMDB SEARCH calls were made (the matching attempt) - no TMDB
    // season/details fetch for the Jikan-served episodes.
    assert.ok(mock.tmdbCalls().length > 0);
    assert.ok(mock.tmdbCalls().every((u) => u.includes('/search/tv')));

    // Successful result IS cached (composite + Jikan page).
    assert.ok(await cacheManager.get('episodes:anilist:123:page:1'));
    assert.ok(await cacheManager.get('episodes:jikan:456:page:1'));
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('TMDB no confident match + Jikan 504 -> typed PROVIDER_ERROR after one bounded retry (no fake data)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    // AniZip (the default episode source) has no mapping for this anime ->
    // the existing TMDB -> Jikan fallback chain engages.
    anizip: anizipNotFound,
    anilist: anilistHandlerFactory({ 123: 456 }),
    jikan: (url) => {
      if (url.includes('/anime/456/full')) return { data: { mal_id: 456, title: 'Test Anime' } };
      if (url.includes('/anime/456/episodes')) return { status: 504, json: {} };
      throw new Error(`unexpected Jikan path: ${url}`);
    },
    // No confident TMDB match -> the Jikan fallback path is exercised.
    tmdb: () => tmdbSearchResults([]),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/123`);
    // A provider outage is never hidden behind fake/empty episode data: the
    // typed Jikan error propagates after ONE bounded retry.
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');

    // One bounded retry (2 attempts), never a loop; only TMDB SEARCH calls
    // were made (the matching attempt) - no TMDB season/details fetch.
    assert.equal(episodeCallCount(mock), 2);
    assert.ok(mock.tmdbCalls().length > 0);
    assert.ok(mock.tmdbCalls().every((u) => u.includes('/search/tv')));

    // The failure was NOT cached as episode data.
    assert.equal(await cacheManager.get('episodes:anilist:123:page:1'), null);
    assert.equal(await cacheManager.get('episodes:jikan:456:page:1'), null);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});

test('AniList ID with no MAL mapping -> honest unavailable response, ZERO Jikan + ZERO TMDB calls', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: anilistHandlerFactory({ 321: null }),
    jikan: () => {
      throw new Error('Jikan must NOT be called without a MAL mapping (never the AniList ID)');
    },
    tmdb: () => {
      throw new Error('TMDB must NEVER be called for episode details');
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/episodes/321`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Honest unavailable representation - never fake data, never fabricated.
    assert.equal(body.id, 321);
    assert.equal(body.anilistId, 321);
    assert.equal(body.malId, null);
    assert.equal(body.pageInfo, null);
    assert.equal(body.episodes, null);

    // ZERO Jikan AND ZERO TMDB calls.
    assert.equal(mock.jikanCalls().length, 0);
    assert.equal(mock.tmdbCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
});
