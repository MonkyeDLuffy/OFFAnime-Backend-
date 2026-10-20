/**
 * TMDB media-asset tests (logos, backdrops, trailers/videos):
 *   normalizers -> service (cache-first, parallel legs, graceful degradation)
 *   + /api/tmdb/:id response composition.
 *
 * HTTP is mocked; no live TMDB calls. Verifies selection rules (PNG logos,
 * official YouTube trailers), never-fabricated URLs, per-tmdbId caching,
 * partial-failure TTL policy, and that media assets never fail a response.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { TmdbProvider } = await import('../src/providers/tmdb/tmdb.provider.js');
const { cacheManager } = await import('../src/cache/cache-manager.js');
const {
  getTmdbMediaAssets,
  getTmdbMediaResponse,
  composeTmdbMediaResponse,
} = await import('../src/services/tmdb.service.js');
const {
  normalizeTmdbImageAssets,
  normalizeTmdbVideoAssets,
} = await import('../src/normalizers/tmdb.normalizer.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const { ValidationError } = await import('../src/errors/index.js');

const deps = () => ({ provider: new TmdbProvider({ apiKey: 'test-key' }), cache: cacheManager });

const imagesPayload = (overrides = {}) => ({
  id: 789,
  backdrops: [
    { file_path: '/bd-a.jpg', width: 3840, height: 2160, iso_639_1: null, vote_average: 4, vote_count: 10 },
    { file_path: '/bd-b.jpg', width: 1920, height: 1080, iso_639_1: 'en', vote_average: 6, vote_count: 10 },
  ],
  logos: [
    { file_path: '/logo-ja.png', iso_639_1: 'ja', vote_average: 9 },
    { file_path: '/logo-en.png', iso_639_1: 'en', vote_average: 5 },
  ],
  posters: [],
  ...overrides,
});

const videosPayload = (results) => ({
  id: 789,
  results: results ?? [
    { name: 'Teaser', key: 'teaser1', site: 'YouTube', type: 'Teaser', official: true, published_at: '2023-02-01T00:00:00.000Z' },
    { name: 'Trailer', key: 'trailer1', site: 'YouTube', type: 'Trailer', official: true, published_at: '2023-01-01T00:00:00.000Z' },
    { name: 'Clip', key: 'clip1', site: 'YouTube', type: 'Clip', official: false },
    { name: 'Vimeo Trailer', key: 'vimeo1', site: 'Vimeo', type: 'Trailer', official: true },
  ],
});

// --- normalizers ---------------------------------------------------------------

test('normalizeTmdbImageAssets -> transparent PNG logo preferred (over higher-voted svg), en > ja language', async () => {
  const { logo, backdrops } = normalizeTmdbImageAssets({
    id: 789,
    logos: [
      { file_path: '/logo.svg', iso_639_1: 'en', vote_average: 9 },
      { file_path: '/logo-ja.png', iso_639_1: 'ja', vote_average: 8 },
      { file_path: '/logo-en.png', iso_639_1: 'en', vote_average: 2 },
    ],
    backdrops: [],
  });
  assert.equal(logo.path, '/logo-en.png'); // PNG pool preferred; en beats ja within it
  assert.equal(logo.extension, 'png');
  assert.equal(logo.url, 'https://image.tmdb.org/t/p/w500/logo-en.png');
  assert.equal(logo.urlOriginal, 'https://image.tmdb.org/t/p/original/logo-en.png');
  assert.deepEqual(backdrops, []);
});

test('normalizeTmdbImageAssets -> backdrops ranked by vote then width, with dimensions and hero-size URLs', async () => {
  const { backdrops } = normalizeTmdbImageAssets(imagesPayload());
  assert.deepEqual(backdrops.map((b) => b.path), ['/bd-b.jpg', '/bd-a.jpg']); // vote 6 > 4
  assert.deepEqual(
    backdrops.map((b) => [b.url, b.urlOriginal, b.width, b.height, b.language]),
    [
      ['https://image.tmdb.org/t/p/w1280/bd-b.jpg', 'https://image.tmdb.org/t/p/original/bd-b.jpg', 1920, 1080, 'en'],
      ['https://image.tmdb.org/t/p/w1280/bd-a.jpg', 'https://image.tmdb.org/t/p/original/bd-a.jpg', 3840, 2160, null],
    ],
  );
});

test('normalizeTmdbImageAssets -> missing/empty metadata degrades to null logo + [] backdrops', async () => {
  const { logo, backdrops } = normalizeTmdbImageAssets({ id: 789, logos: [], backdrops: [] });
  assert.equal(logo, null);
  assert.deepEqual(backdrops, []);
  const bad = normalizeTmdbImageAssets(null);
  assert.equal(bad.logo, null);
  assert.deepEqual(bad.backdrops, []);
});

test('normalizeTmdbBackdrops -> capped at 6 entries', async () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({ file_path: `/bd-${i}.jpg`, width: 1000 + i, height: 500, vote_average: 5 }));
  const { backdrops } = normalizeTmdbImageAssets({ id: 789, backdrops: entries, logos: [] });
  assert.equal(backdrops.length, 6);
});

test('normalizeTmdbVideoAssets -> official Trailer preferred; clips/non-YouTube excluded; YouTube URLs built', async () => {
  const { trailer, videos } = normalizeTmdbVideoAssets(videosPayload());
  assert.equal(trailer.key, 'trailer1');
  assert.equal(trailer.url, 'https://www.youtube.com/watch?v=trailer1');
  assert.equal(trailer.embedUrl, 'https://www.youtube.com/embed/trailer1');
  assert.equal(trailer.official, true);
  // Only YouTube trailers/teasers survive, best first.
  assert.deepEqual(videos.map((v) => v.key), ['trailer1', 'teaser1']);
});

test('normalizeTmdbVideoAssets -> newer official Trailer wins over older Teaser; non-official Trailer ranked below', async () => {
  const { trailer } = normalizeTmdbVideoAssets({ id: 789, results: [
    { name: 'Old Trailer', key: 'old', site: 'YouTube', type: 'Trailer', official: false, published_at: '2024-06-01T00:00:00.000Z' },
    { name: 'Teaser', key: 'teaser', site: 'YouTube', type: 'Teaser', official: true, published_at: '2024-01-01T00:00:00.000Z' },
    { name: 'Trailer', key: 'new', site: 'YouTube', type: 'Trailer', official: true, published_at: '2023-01-01T00:00:00.000Z' },
  ] });
  assert.equal(trailer.key, 'new');
});

test('normalizeTmdbVideoAssets -> non-YouTube trailers are excluded entirely (no invented URLs)', async () => {
  const { trailer, videos } = normalizeTmdbVideoAssets({ id: 789, results: [
    { name: 'Vimeo Trailer', key: 'vimeo1', site: 'Vimeo', type: 'Trailer', official: true },
  ] });
  assert.equal(trailer, null); // not selected as the trailer
  assert.deepEqual(videos, []); // YouTube-only candidate list
});

test('normalizeTmdbVideoAssets -> no videos -> null trailer + [] (never fabricated)', async () => {
  const { trailer, videos } = normalizeTmdbVideoAssets({ id: 789, results: [] });
  assert.equal(trailer, null);
  assert.deepEqual(videos, []);
  const bad = normalizeTmdbVideoAssets(null);
  assert.equal(bad.trailer, null);
  assert.deepEqual(bad.videos, []);
});

// --- service -------------------------------------------------------------------

const MEDIA_KEY = 'tmdb:media:tv:789';

test('getTmdbMediaAssets -> resolved images+videos, cached per tmdbId/mediaType (no duplicate fetches)', async () => {
  await cacheManager.invalidate(MEDIA_KEY);
  const mock = installMockFetch((call) => {
    const url = String(call.url);
    if (url.includes('/tv/789/images')) return jsonResponse(imagesPayload());
    if (url.includes('/tv/789/videos')) return jsonResponse(videosPayload());
    throw new Error(`unexpected TMDB path: ${url}`);
  });
  try {
    const media = await getTmdbMediaAssets(789, 'tv', deps());
    assert.equal(media.complete, true);
    assert.equal(media.reason, null);
    assert.equal(media.logo.path, '/logo-en.png'); // PNG pool; language (en) outranks vote
    assert.equal(media.trailer.key, 'trailer1');
    assert.equal(media.backdrops.length, 2);

    await getTmdbMediaAssets(789, 'tv', deps());
    assert.equal(mock.calls.length, 2); // images + videos once each; second call served from cache

    const cached = await cacheManager.get(MEDIA_KEY);
    assert.equal(cached.complete, true); // normalized result cached, not raw
    assert.equal('logos' in cached, false);
  } finally {
    mock.restore();
    await cacheManager.invalidate(MEDIA_KEY);
  }
});

test('getTmdbMediaAssets -> movie media type uses movie endpoints and separate cache namespace', async () => {
  await cacheManager.invalidate('tmdb:media:movie:789');
  const mock = installMockFetch((call) => {
    const url = String(call.url);
    if (url.includes('/movie/789/images')) return jsonResponse({ id: 789, backdrops: [], logos: [] });
    if (url.includes('/movie/789/videos')) return jsonResponse({ id: 789, results: [] });
    throw new Error(`unexpected TMDB path: ${url}`);
  });
  try {
    const media = await getTmdbMediaAssets(789, 'movie', deps());
    assert.equal(media.complete, true);
    assert.equal(media.mediaType, 'movie');
    assert.ok(mock.calls.every((c) => String(c.url).includes('/movie/789/')));
  } finally {
    mock.restore();
    await cacheManager.invalidate('tmdb:media:movie:789');
  }
});

test('getTmdbMediaAssets -> images leg fails, videos leg succeeds -> partial result with conservative TTL', async () => {
  await cacheManager.invalidate(MEDIA_KEY);
  const mock = installMockFetch((call) => {
    const url = String(call.url);
    if (url.includes('/tv/789/images')) return jsonResponse({ error: 'boom' }, 500);
    if (url.includes('/tv/789/videos')) return jsonResponse(videosPayload());
    throw new Error(`unexpected TMDB path: ${url}`);
  });
  try {
    const media = await getTmdbMediaAssets(789, 'tv', deps());
    assert.equal(media.complete, false);
    assert.equal(media.reason, 'images_unavailable');
    assert.equal(media.logo, null);
    assert.deepEqual(media.backdrops, []);
    assert.equal(media.trailer.key, 'trailer1'); // successful leg intact

    // Degraded results are cached with a conservative (short) TTL - not DAY.
    const entry = cacheManager.l1._map.get(MEDIA_KEY);
    const ttlSeconds = Math.round((entry.expiresAt - Date.now()) / 1000);
    assert.ok(ttlSeconds > 0 && ttlSeconds <= 300, `expected short TTL, got ${ttlSeconds}s`);
  } finally {
    mock.restore();
    await cacheManager.invalidate(MEDIA_KEY);
  }
});

test('getTmdbMediaAssets -> BOTH legs failing degrades to a valid empty result (never fails the caller)', async () => {
  await cacheManager.invalidate(MEDIA_KEY);
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const media = await getTmdbMediaAssets(789, 'tv', deps());
    assert.equal(media.complete, false);
    assert.equal(media.reason, 'images_and_videos_unavailable');
    assert.equal(media.logo, null);
    assert.deepEqual(media.backdrops, []);
    assert.equal(media.trailer, null);
    assert.deepEqual(media.videos, []);
  } finally {
    mock.restore();
    await cacheManager.invalidate(MEDIA_KEY);
  }
});

test('getTmdbMediaAssets -> upstream payload for a DIFFERENT tmdb entry is rejected (id cross-check)', async () => {
  await cacheManager.invalidate(MEDIA_KEY);
  const mock = installMockFetch((call) => {
    const url = String(call.url);
    if (url.includes('/tv/789/images')) return jsonResponse(imagesPayload({ id: 999 })); // wrong entry
    if (url.includes('/tv/789/videos')) return jsonResponse(videosPayload());
    throw new Error(`unexpected TMDB path: ${url}`);
  });
  try {
    const media = await getTmdbMediaAssets(789, 'tv', deps());
    assert.equal(media.complete, false);
    assert.equal(media.reason, 'images_unavailable');
    assert.equal(media.trailer.key, 'trailer1'); // matching leg accepted
  } finally {
    mock.restore();
    await cacheManager.invalidate(MEDIA_KEY);
  }
});

test('getTmdbMediaAssets -> invalid tmdbId -> ValidationError before any request', async () => {
  const mock = installMockFetch(() => { throw new Error('must not be called'); });
  try {
    await assert.rejects(() => getTmdbMediaAssets('abc', 'tv', deps()), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// --- response composition -------------------------------------------------------

const resolvedVisual = {
  resolved: true,
  tmdbId: 789,
  mediaType: 'tv',
  images: { backdrop: 'https://image.tmdb.org/t/p/original/backdrop.jpg', banner: 'https://image.tmdb.org/t/p/original/backdrop.jpg' },
  poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
  reason: null,
};

const unresolvedVisual = {
  resolved: false,
  tmdbId: null,
  mediaType: null,
  images: null,
  poster: null,
  reason: 'no_confident_match',
};

test('composeTmdbMediaResponse -> resolved visual + assets = additive fields, existing contract intact', () => {
  const payload = composeTmdbMediaResponse(resolvedVisual, {
    complete: true,
    tmdbId: 789,
    mediaType: 'tv',
    logo: { path: '/logo.png', url: 'https://image.tmdb.org/t/p/w500/logo.png', urlOriginal: 'https://image.tmdb.org/t/p/original/logo.png', language: 'en', extension: 'png', voteAverage: 5 },
    backdrops: [{ path: '/bd.jpg', url: 'https://image.tmdb.org/t/p/w1280/bd.jpg', urlOriginal: 'https://image.tmdb.org/t/p/original/bd.jpg', width: 3840, height: 2160, language: null, voteAverage: 5 }],
    trailer: { key: 'k1', site: 'YouTube', type: 'Trailer', official: true, url: 'https://www.youtube.com/watch?v=k1', embedUrl: 'https://www.youtube.com/embed/k1', name: 'T', publishedAt: null },
    videos: [{ key: 'k1' }, { key: 'k2' }],
    reason: null,
  });
  // Existing fields untouched.
  assert.equal(payload.resolved, true);
  assert.equal(payload.tmdbId, 789);
  assert.equal(payload.images.backdrop, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
  assert.equal(payload.poster, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  // Additive fields.
  assert.equal(payload.logo.path, '/logo.png');
  assert.equal(payload.backdrops.length, 1);
  assert.equal(payload.trailer.key, 'k1');
  assert.equal(payload.videos.length, 2);
});

test('composeTmdbMediaResponse -> resolved visual + empty backdrops falls back to the enrichment backdrop', () => {
  const payload = composeTmdbMediaResponse(resolvedVisual, {
    complete: true, tmdbId: 789, mediaType: 'tv', logo: null, backdrops: [], trailer: null, videos: [], reason: null,
  });
  assert.deepEqual(payload.backdrops, [{
    path: null,
    url: 'https://image.tmdb.org/t/p/original/backdrop.jpg',
    urlOriginal: 'https://image.tmdb.org/t/p/original/backdrop.jpg',
    width: null,
    height: null,
    language: null,
    voteAverage: null,
  }]);
  assert.equal(payload.trailer, null);
  assert.deepEqual(payload.videos, []);
});

test('composeTmdbMediaResponse -> unresolved visual mirrors the null convention (no fabricated assets)', () => {
  const payload = composeTmdbMediaResponse(unresolvedVisual, null);
  assert.equal(payload.logo, null);
  assert.equal(payload.backdrops, null);
  assert.equal(payload.trailer, null);
  assert.equal(payload.videos, null);
  assert.equal(payload.images, null);
  assert.equal(payload.reason, 'no_confident_match');
});

test('getTmdbMediaResponse -> resolved visual fetches assets; unresolved visual makes NO requests', async () => {
  await cacheManager.invalidate(MEDIA_KEY);
  const mock = installMockFetch((call) => {
    const url = String(call.url);
    if (url.includes('/tv/789/images')) return jsonResponse(imagesPayload());
    if (url.includes('/tv/789/videos')) return jsonResponse(videosPayload());
    throw new Error(`unexpected TMDB path: ${url}`);
  });
  try {
    const payload = await getTmdbMediaResponse(resolvedVisual, deps());
    assert.equal(payload.resolved, true);
    assert.ok(payload.trailer);
    assert.equal(mock.calls.length, 2);

    const unresolvedPayload = await getTmdbMediaResponse(unresolvedVisual, deps());
    assert.equal(unresolvedPayload.trailer, null);
    assert.equal(unresolvedPayload.backdrops, null);
    assert.equal(mock.calls.length, 2); // unchanged
  } finally {
    mock.restore();
    await cacheManager.invalidate(MEDIA_KEY);
  }
});

test('getTmdbMediaResponse -> invalid visual input -> ValidationError', async () => {
  await assert.rejects(() => getTmdbMediaResponse(null, deps()), ValidationError);
  await assert.rejects(() => getTmdbMediaResponse('nope', deps()), ValidationError);
});
