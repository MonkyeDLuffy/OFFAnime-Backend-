/**
 * GET /api/home trailer tests (AniList-native trailers).
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. Verifies the per-card `trailer` contract sourced
 * from AniList's own `trailer { id site }` field, requested in the SAME
 * GraphQL request as the section data (zero extra API calls, zero TMDB):
 *
 *   - every card of every collection carries `trailer` (object or null),
 *   - a YouTube trailer yields the canonical watch URL,
 *   - a Dailymotion trailer yields its known URL format,
 *   - an unknown site keeps its real id/site with `url: null` (never guessed),
 *   - missing/invalid/malformed trailers safely become `trailer: null`,
 *   - sequel/season entries use their OWN AniList IDs (no season mapping),
 *   - one unusable trailer never breaks the other anime,
 *   - the second home request is served entirely from cache (zero calls),
 *   - TMDB is never contacted for home trailers.
 */

// Env setup MUST be the first import (ESM evaluates imports depth-first in
// order, so this runs before config/env.js loads). Default test env: TMDB
// deliberately UNCONFIGURED - home trailers must not depend on it.
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

/**
 * Assert the trailer contract on a card: `trailer` is either null or the
 * normalized AniList-native shape. Returns the trailer for further assertions.
 * @param {object} card
 * @returns {object|null}
 */
function assertTrailerShape(card) {
  assert.ok('trailer' in card, `trailer field present on "${card.title}"`);
  if (card.trailer === null) return null;
  const t = card.trailer;
  for (const field of ['id', 'site', 'key', 'url']) {
    assert.ok(field in t, `trailer.${field} present`);
  }
  assert.equal(t.key, t.id, 'key mirrors the AniList trailer id');
  assert.equal(typeof t.id, 'string');
  assert.ok(!/\s/.test(t.id), 'trailer id never contains whitespace');
  if (t.url !== null) {
    assert.ok(t.url.startsWith('https://'), `trailer url is https: ${t.url}`);
  }
  return t;
}

/** AniList search handler distinguishing sections by sort variable. */
function sectionHandler() {
  return (body) => {
    const sort = body.variables.sort?.[0] ?? '';
    /** AniList media entry with a native trailer entry. */
    const media = (id, title, trailer, format = 'TV') =>
      anilistMedia({ id, idMal: id + 5000, title, format, trailer });
    switch (sort) {
      case 'TRENDING_DESC':
        return anilistPage([
          // Canonical YouTube trailer.
          media(301, 'Trailer Anime', { id: 'dQw4w9WgXcQ', site: 'youtube' }),
          // Dailymotion: known URL format, id/site preserved.
          media(302, 'Dailymotion Anime', { id: 'x8kft42', site: 'dailymotion' }),
          // Unknown site: id/site preserved, NO url (never guessed).
          media(303, 'Obscure Site Anime', { id: 'vid_123', site: 'vimeo' }),
          // No trailer at all (AniList returns null).
          media(304, 'Trailerless Anime', null),
        ]);
      case 'POPULARITY_DESC':
        return anilistPage([
          // Sequel entry with its OWN trailer on its OWN AniList ID.
          media(401, 'Franchise', { id: 'franchiseOp1', site: 'youtube' }),
          // Separate AniList sequel entry - different id, different trailer,
          // no season mapping involved.
          media(402, 'Franchise 2nd Season', { id: 'sequelOp2', site: 'youtube' }),
          // Malformed entries: whitespace id / missing site / missing id.
          media(403, 'Broken Id Anime', { id: 'not a real id', site: 'youtube' }),
          media(404, 'Siteless Anime', { id: 'abc123' }),
          media(405, 'Idless Anime', { site: 'youtube' }),
        ]);
      // Same sort serves the seasonal section too - repeats trending IDs
      // (cross-collection dedupe of AniList IDs, same trailers).
      case 'SCORE_DESC':
        return anilistPage([
          media(301, 'Trailer Anime', { id: 'dQw4w9WgXcQ', site: 'youtube' }),
          media(304, 'Trailerless Anime', null),
        ]);
      default:
        throw new Error(`unexpected sort: ${sort}`);
    }
  };
}

test('GET /api/home -> every card carries a normalized AniList-native trailer', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: sectionHandler() });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/home`);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Every card of every collection (incl. top10) carries the trailer field.
    for (const [section, cards] of Object.entries(body)) {
      assert.ok(Array.isArray(cards), `${section} is a collection`);
      for (const card of cards) assertTrailerShape(card);
    }

    // YouTube: canonical watch URL built from the actual id.
    const yt = body.trending.find((c) => c.anilistId === 301).trailer;
    assert.deepEqual(yt, {
      id: 'dQw4w9WgXcQ',
      site: 'youtube',
      key: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    // Dailymotion: known format, original id/site preserved.
    assert.deepEqual(body.trending.find((c) => c.anilistId === 302).trailer, {
      id: 'x8kft42',
      site: 'dailymotion',
      key: 'x8kft42',
      url: 'https://www.dailymotion.com/video/x8kft42',
    });

    // Unknown site: id/site preserved, URL NOT fabricated.
    assert.deepEqual(body.trending.find((c) => c.anilistId === 303).trailer, {
      id: 'vid_123',
      site: 'vimeo',
      key: 'vid_123',
      url: null,
    });

    // No trailer -> null. Malformed entries (whitespace id, missing site,
    // missing id) -> null, never fabricated, never a crash.
    assert.equal(body.trending.find((c) => c.anilistId === 304).trailer, null);
    assert.equal(body.popular.find((c) => c.anilistId === 403).trailer, null);
    assert.equal(body.popular.find((c) => c.anilistId === 404).trailer, null);
    assert.equal(body.popular.find((c) => c.anilistId === 405).trailer, null);

    // Sequel/season entries resolve via their OWN AniList IDs - each entry
    // keeps its own trailer, no season mapping, no shared-entity logic.
    assert.equal(body.popular.find((c) => c.anilistId === 401).trailer.key, 'franchiseOp1');
    assert.equal(body.popular.find((c) => c.anilistId === 402).trailer.key, 'sequelOp2');

    // Cross-collection consistency: same AniList ID -> same trailer.
    assert.deepEqual(body.topRated.find((c) => c.anilistId === 301).trailer, yt);
    assert.equal(body.top10.find((c) => c.anilistId === 304).trailer, null);

    // All existing card fields remain intact (identity + titles + poster).
    const card = body.trending.find((c) => c.anilistId === 301);
    assert.equal(card.id, card.anilistId);
    assert.equal(typeof card.malId, 'number');
    assert.equal(card.titleEnglish, 'Trailer Anime EN');
    assert.equal(card.titleRomaji, 'Trailer Anime');
    assert.equal(card.titleNative, 'テスト');
    assert.ok(card.images.poster === null || typeof card.images.poster === 'string');

    // Zero TMDB calls: trailers come from the SAME AniList request.
    assert.equal(mock.tmdbCalls().length, 0);

    // Zero EXTRA AniList calls: exactly one search per section (4 sections;
    // seasonal shares the popular sort but has its own season cache key).
    // Top 10 and trailers add none.
    assert.equal(mock.anilistCalls().length, 4);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/home -> an unusable trailer never breaks the feed or other trailers', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      const sort = body.variables.sort?.[0] ?? '';
      if (sort === 'TRENDING_DESC') {
        return anilistPage([
          // Every malformed shape a client could see - all safely null.
          anilistMedia({ id: 501, title: 'Null Trailer', trailer: null }),
          anilistMedia({ id: 502, title: 'Empty Id', trailer: { id: '', site: 'youtube' } }),
          anilistMedia({ id: 503, title: 'Empty Site', trailer: { id: 'abc', site: '' } }),
          anilistMedia({ id: 504, title: 'Null Fields', trailer: { id: null, site: null } }),
          anilistMedia({ id: 505, title: 'Garbage Trailer', trailer: 'not-an-object' }),
        ]);
      }
      if (sort === 'SCORE_DESC') return anilistPage([]);
      return anilistPage([]);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/home`);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Every malformed trailer safely became null; the feed and its other
    // fields (titles etc.) are intact.
    for (const card of body.trending) {
      assert.equal(card.trailer, null, `${card.title} -> null trailer`);
      assert.ok('titleEnglish' in card && 'titleRomaji' in card && 'titleNative' in card);
    }
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/home -> second request served from cache (zero provider calls)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: sectionHandler() });
  const server = await startTestServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/home`);
    assert.equal(first.status, 200);
    const callsAfterFirst = mock.calls.length;
    assert.ok(callsAfterFirst > 0);

    const second = await fetch(`${server.baseUrl}/api/home`);
    assert.equal(second.status, 200);
    assert.equal(mock.calls.length, callsAfterFirst, 'zero additional provider calls');

    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.deepEqual(secondBody, firstBody);
    assert.equal(secondBody.popular.find((c) => c.anilistId === 402).trailer.key, 'sequelOp2');
  } finally {
    await server.stop();
    mock.restore();
  }
});
