/**
 * AniList provider tests - behavior with MOCKED HTTP responses.
 *
 * No live AniList API calls and no real API keys required. Uses the mock-fetch
 * helper (real Response objects) so the shared HTTP client behaves exactly as
 * in production, including AbortSignal-based timeouts.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { AnilistProvider } = await import('../src/providers/anilist/anilist.provider.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const {
  ProviderError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} = await import('../src/errors/index.js');

const mediaFixture = { id: 1, idMal: 1, title: { romaji: 'Cowboy Bebop' }, format: 'TV' };

test('successful anime lookup -> raw media, POST with query+variables', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: mediaFixture } }));
  try {
    const provider = new AnilistProvider();
    const result = await provider.getAnimeById(1);

    assert.deepEqual(result, mediaFixture); // RAW payload, not normalized
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].method, 'POST');
    assert.equal(mock.calls[0].url, 'https://graphql.anilist.co');
    const body = JSON.parse(mock.calls[0].init.body);
    assert.ok(body.query.includes('Media'));
    assert.equal(body.variables.id, 1);
  } finally {
    mock.restore();
  }
});

test('successful MAL lookup -> uses idMal variable', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: mediaFixture } }));
  try {
    const provider = new AnilistProvider();
    const result = await provider.getAnimeByMalId(999);
    assert.deepEqual(result, mediaFixture);
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.variables.idMal, 999);
    assert.equal(body.variables.id, undefined); // never confused with anilist id
  } finally {
    mock.restore();
  }
});

test('successful search -> raw Page, filters mapped into variables', async () => {
  const pageFixture = { pageInfo: { total: 1, hasNextPage: false }, media: [mediaFixture] };
  const mock = installMockFetch(() => jsonResponse({ data: { Page: pageFixture } }));
  try {
    const provider = new AnilistProvider();
    const result = await provider.searchAnime('cowboy', { page: 2, perPage: 10, genre: 'Action' });
    assert.deepEqual(result, pageFixture);

    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.variables.search, 'cowboy');
    assert.equal(body.variables.page, 2);
    assert.equal(body.variables.perPage, 10);
    assert.equal(body.variables.genre, 'Action');
    assert.deepEqual(body.variables.sort, ['SEARCH_MATCH']);
  } finally {
    mock.restore();
  }
});

test('search without query defaults to POPULARITY_DESC sort', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Page: { media: [] } } }));
  try {
    const provider = new AnilistProvider();
    await provider.searchAnime('', { season: 'SPRING', year: 2024 });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.variables.search, undefined);
    assert.equal(body.variables.season, 'SPRING');
    assert.equal(body.variables.seasonYear, 2024);
    assert.deepEqual(body.variables.sort, ['POPULARITY_DESC']);
  } finally {
    mock.restore();
  }
});

test('anime not found: HTTP 404 -> NotFoundError', async () => {
  const mock = installMockFetch(() =>
    jsonResponse({ errors: [{ message: 'Not Found.', status: 404 }] }, 404),
  );
  try {
    const provider = new AnilistProvider();
    await assert.rejects(() => provider.getAnimeById(99999999), NotFoundError);
  } finally {
    mock.restore();
  }
});

test('anime not found: HTTP 200 with Media: null -> NotFoundError', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: { Media: null } }));
  try {
    const provider = new AnilistProvider();
    await assert.rejects(() => provider.getAnimeById(99999999), NotFoundError);
  } finally {
    mock.restore();
  }
});

test('invalid input -> ValidationError, no HTTP request made', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: {} }));
  try {
    const provider = new AnilistProvider();
    await assert.rejects(() => provider.getAnimeById(0), ValidationError);
    await assert.rejects(() => provider.getAnimeById('abc'), ValidationError);
    await assert.rejects(() => provider.getAnimeById(-5), ValidationError);
    await assert.rejects(() => provider.getAnimeByMalId(null), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('hanging request -> TimeoutError (never hangs indefinitely)', async () => {
  const mock = installMockFetch((call) => new Promise((_, reject) => {
    // Simulate real fetch: rejects when the AbortController fires.
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    const provider = new AnilistProvider({ timeoutMs: 50 });
    await assert.rejects(() => provider.getAnimeById(1), TimeoutError);
  } finally {
    mock.restore();
  }
});

test('rate limited: HTTP 429 -> RateLimitError', async () => {
  const mock = installMockFetch(() => jsonResponse({}, 429, { 'retry-after': '2' }));
  try {
    const provider = new AnilistProvider();
    const err = await provider.getAnimeById(1).then(
      () => { throw new Error('should have thrown'); },
      (e) => e,
    );
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterMs, 2000);
  } finally {
    mock.restore();
  }
});

test('API failure: HTTP 500 -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const provider = new AnilistProvider();
    const err = await provider.getAnimeById(1).then(
      () => { throw new Error('should have thrown'); },
      (e) => e,
    );
    assert.ok(err instanceof ProviderError);
    assert.ok(!(err instanceof NotFoundError));
    assert.equal(err.details.upstreamStatus, 500);
  } finally {
    mock.restore();
  }
});

test('GraphQL errors in HTTP 200 -> ProviderError with error details', async () => {
  const mock = installMockFetch(() =>
    jsonResponse({ errors: [{ message: 'Internal error', status: 500 }] }),
  );
  try {
    const provider = new AnilistProvider();
    const err = await provider.getAnimeById(1).then(
      () => { throw new Error('should have thrown'); },
      (e) => e,
    );
    assert.ok(err instanceof ProviderError);
    assert.ok(err.message.includes('Internal error'));
  } finally {
    mock.restore();
  }
});

test('malformed response: HTTP 200 without data -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ unexpected: 'shape' }));
  try {
    const provider = new AnilistProvider();
    await assert.rejects(() => provider.getAnimeById(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('malformed response: invalid JSON body -> ProviderError', async () => {
  const mock = installMockFetch(() => new Response('not json at all', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const provider = new AnilistProvider();
    await assert.rejects(() => provider.getAnimeById(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('provider is stateless: same instance serves different lookups', async () => {
  const mock = installMockFetch((call, index) =>
    jsonResponse({ data: { Media: { id: index } } }),
  );
  try {
    const provider = new AnilistProvider();
    const [a, b] = await Promise.all([provider.getAnimeById(11), provider.getAnimeById(22)]);
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
  } finally {
    mock.restore();
  }
});
