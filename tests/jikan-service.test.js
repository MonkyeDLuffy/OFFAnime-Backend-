/**
 * Jikan service tests - cache-first flow:
 *   service -> cacheManager.getOrLoad -> provider -> normalizer
 *
 * HTTP is mocked; no live Jikan calls. Verifies that normalized data is
 * cached, failures are never cached, stale data survives provider failure,
 * and concurrent requests coalesce.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getAnimeByMalId, searchAnime } = await import('../src/services/jikan.service.js');
const { cacheManager } = await import('../src/cache/cache-manager.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const { NotFoundError, ValidationError } = await import('../src/errors/index.js');

const animeFixture = { mal_id: 1, title: 'Cowboy Bebop', synopsis: 'In 2071...', score: 8.75 };

test('getAnimeByMalId returns a NORMALIZED Jikan anime (not raw)', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    await cacheManager.invalidate('jikan:anime:1');
    const anime = await getAnimeByMalId(1);
    assert.equal(anime.malId, 1); // normalized field name
    assert.equal(anime.title.default, 'Cowboy Bebop'); // normalized title object
    assert.equal('mal_id' in anime, false); // raw shape never leaks
    assert.equal('id' in anime, false); // never reinterpreted as anilist id
    assert.equal('anilistId' in anime, false);
  } finally {
    mock.restore();
    await cacheManager.invalidate('jikan:anime:1');
  }
});

test('cache hit avoids Jikan request; miss loads Jikan; normalized result is cached', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    await cacheManager.invalidate('jikan:anime:1');
    await getAnimeByMalId(1);
    await getAnimeByMalId(1);
    assert.equal(mock.calls.length, 1); // second call served from cache

    const cached = await cacheManager.get('jikan:anime:1');
    assert.equal(cached.malId, 1); // normalized data cached, not raw
    assert.equal('mal_id' in cached, false);
  } finally {
    mock.restore();
    await cacheManager.invalidate('jikan:anime:1');
  }
});

test('provider failure is NOT cached (404 -> NotFoundError, cache stays empty)', async () => {
  const mock = installMockFetch(() => jsonResponse({ error: 'not found' }, 404));
  try {
    await cacheManager.invalidate('jikan:anime:404');
    await assert.rejects(() => getAnimeByMalId(404), NotFoundError);
    assert.equal(await cacheManager.get('jikan:anime:404'), null);
  } finally {
    mock.restore();
    await cacheManager.invalidate('jikan:anime:404');
  }
});

test('stale cached data survives provider failure (stale-if-error)', async () => {
  const key = 'jikan:anime:2';
  await cacheManager.invalidate(key);
  // Populate with an immediately-stale TTL.
  await cacheManager.set(key, { malId: 2, title: { default: 'Stale' }, source: { jikan: true } }, -1);
  // Provider is now "down" (HTTP 500 on every request).
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const anime = await getAnimeByMalId(2);
    assert.equal(anime.malId, 2); // stale value, NOT an error/empty response
  } finally {
    mock.restore();
    await cacheManager.invalidate(key);
  }
});

test('concurrent identical requests coalesce into one Jikan call', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    await cacheManager.invalidate('jikan:anime:1');
    const [a, b, c] = await Promise.all([getAnimeByMalId(1), getAnimeByMalId(1), getAnimeByMalId(1)]);
    assert.equal(mock.calls.length, 1); // one request, three callers
    assert.equal(a.malId, 1);
    assert.equal(b.malId, 1);
    assert.equal(c.malId, 1);
  } finally {
    mock.restore();
    await cacheManager.invalidate('jikan:anime:1');
  }
});

test('searchAnime returns normalized results with malId-only identity', async () => {
  const searchPayload = {
    pagination: { last_visible_page: 1, has_next_page: false, current_page: 1, items: { count: 1, total: 1, per_page: 20 } },
    data: [{ mal_id: 5114, title: 'Frieren', type: 'TV', episodes: 28, images: { jpg: { image_url: 'https://x/f.jpg' } } }],
  };
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    await cacheManager.invalidate('jikan:search:frieren:{}');
    const page = await searchAnime('frieren');
    assert.equal(page.pageInfo.total, 1);
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0].malId, 5114); // MAL namespace only
    assert.equal('anilistId' in page.results[0], false);
    assert.equal('id' in page.results[0], false);
  } finally {
    mock.restore();
    await cacheManager.invalidate('jikan:search:frieren:{}');
  }
});

test('searchAnime validates input and pagination', async () => {
  await assert.rejects(() => searchAnime(''), ValidationError);
  await assert.rejects(() => searchAnime('   '), ValidationError);
  await assert.rejects(() => searchAnime(123), ValidationError);
  await assert.rejects(() => searchAnime('x', { page: 0 }), ValidationError);
  await assert.rejects(() => searchAnime('x', { limit: 30 }), ValidationError); // Jikan max 25
});
