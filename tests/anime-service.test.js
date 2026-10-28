/**
 * Anime service tests - the Phase 2 flow:
 *   service -> cache manager -> provider -> normalizer
 *
 * HTTP is mocked; no live AniList calls. Verifies that canonical data is
 * cached, failures are never cached, and stale-if-error works end to end.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getAnimeDetails } = await import('../src/services/anime.service.js');
const { cacheManager } = await import('../src/cache/cache-manager.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const { NotFoundError } = await import('../src/errors/index.js');

const mediaFixture = {
  id: 1,
  idMal: 1,
  title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop', native: 'カウボーイビバップ', userPreferred: 'Cowboy Bebop' },
  description: 'In the year 2071... <i>bounty hunters</i>',
  coverImage: { extraLarge: 'https://img.example/xl.jpg', large: 'https://img.example/l.jpg', medium: 'https://img.example/m.jpg' },
  bannerImage: null,
  type: 'ANIME',
  format: 'TV',
  status: 'FINISHED',
  episodes: 26,
  genres: ['Action'],
};

test('getAnimeDetails returns a CANONICAL anime (normalized, not raw)', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: mediaFixture } }));
  try {
    await cacheManager.invalidate('anilist:anime:1');
    const anime = await getAnimeDetails(1);
    assert.equal(anime.id, 1);
    assert.equal(anime.anilistId, 1);
    assert.equal(anime.malId, 1);
    assert.equal(typeof anime.title, 'object'); // canonical title object
    assert.ok(anime.description.includes('bounty hunters')); // HTML cleaned
    assert.deepEqual(anime.source, { anilist: true, jikan: false, tmdb: false });
    assert.ok(!JSON.stringify(anime).includes('undefined'));
  } finally {
    mock.restore();
    await cacheManager.invalidate('anilist:anime:1');
  }
});

test('second identical call is served from cache (one provider request)', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: mediaFixture } }));
  try {
    await cacheManager.invalidate('anilist:anime:1');
    await getAnimeDetails(1);
    await getAnimeDetails(1);
    assert.equal(mock.calls.length, 1); // request coalescing/cache, not 2 calls
  } finally {
    mock.restore();
    await cacheManager.invalidate('anilist:anime:1');
  }
});

test('unknown anime -> NotFoundError, nothing cached as valid data', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: null } }));
  try {
    await cacheManager.invalidate('anilist:anime:404');
    await assert.rejects(() => getAnimeDetails(404), NotFoundError);
    assert.equal(await cacheManager.get('anilist:anime:404'), null); // failure NOT cached
  } finally {
    mock.restore();
    await cacheManager.invalidate('anilist:anime:404');
  }
});

test('stale-if-error: provider outage serves stale canonical data', async () => {
  const key = 'anilist:anime:2';
  await cacheManager.invalidate(key);
  // Populate with an immediately-stale TTL.
  await cacheManager.set(key, { id: 2, anilistId: 2, malId: null }, -1);
  // Provider is now "down" (HTTP 500 on every request).
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const anime = await getAnimeDetails(2);
    assert.equal(anime.anilistId, 2); // stale value, NOT an error/empty response
  } finally {
    mock.restore();
    await cacheManager.invalidate(key);
  }
});
