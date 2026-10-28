/**
 * Jikan provider tests - behavior with MOCKED HTTP responses.
 *
 * No live Jikan API calls and no real API keys required. Uses the mock-fetch
 * helper (real Response objects) so the shared HTTP client behaves exactly as
 * in production, including AbortSignal-based timeouts.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { JikanProvider } = await import('../src/providers/jikan/jikan.provider.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const {
  ProviderError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} = await import('../src/errors/index.js');

const animeFixture = { mal_id: 1, title: 'Cowboy Bebop', title_english: 'Cowboy Bebop', episodes: 26 };
const searchPayload = {
  pagination: { last_visible_page: 1, has_next_page: false, current_page: 1, items: { count: 1, total: 1, per_page: 20 } },
  data: [animeFixture],
};

test('successful /full response -> raw anime object from data wrapper', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    const provider = new JikanProvider();
    const result = await provider.getAnimeByMalId(1);
    assert.deepEqual(result, animeFixture); // RAW payload, not normalized
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].method, 'GET');
    assert.equal(mock.calls[0].url, 'https://api.jikan.moe/v4/anime/1/full');
  } finally {
    mock.restore();
  }
});

test('full: false uses the basic endpoint', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    const provider = new JikanProvider();
    await provider.getAnimeByMalId(1, { full: false });
    assert.equal(mock.calls[0].url, 'https://api.jikan.moe/v4/anime/1');
  } finally {
    mock.restore();
  }
});

test('successful search -> raw payload, q/page/limit mapped into URL', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    const provider = new JikanProvider();
    const result = await provider.searchAnime('cowboy', { page: 2, limit: 10 });
    assert.deepEqual(result, searchPayload);
    assert.equal(mock.calls[0].url, 'https://api.jikan.moe/v4/anime?q=cowboy&page=2&limit=10');
  } finally {
    mock.restore();
  }
});

test('MAL ID validation: valid positive integers accepted (numeric strings ok)', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    const provider = new JikanProvider();
    assert.deepEqual(await provider.getAnimeByMalId(1), animeFixture);
    assert.deepEqual(await provider.getAnimeByMalId('5114'), animeFixture);
  } finally {
    mock.restore();
  }
});

test('MAL ID validation: zero, negative, decimal, NaN, non-numeric, empty -> ValidationError, no HTTP', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: animeFixture }));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(0), ValidationError);
    await assert.rejects(() => provider.getAnimeByMalId(-5), ValidationError);
    await assert.rejects(() => provider.getAnimeByMalId(12.5), ValidationError);
    await assert.rejects(() => provider.getAnimeByMalId(Number('NaN')), ValidationError);
    await assert.rejects(() => provider.getAnimeByMalId('123abc'), ValidationError); // never coerced
    await assert.rejects(() => provider.getAnimeByMalId(''), ValidationError);
    await assert.rejects(() => provider.getAnimeByMalId(null), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('pagination validation: invalid page/limit -> ValidationError', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.searchAnime('x', { page: 0 }), ValidationError);
    await assert.rejects(() => provider.searchAnime('x', { page: -1 }), ValidationError);
    await assert.rejects(() => provider.searchAnime('x', { limit: 0 }), ValidationError);
    await assert.rejects(() => provider.searchAnime('x', { limit: 26 }), ValidationError); // Jikan max 25
    await assert.rejects(() => provider.searchAnime('x', { limit: 'abc' }), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('not found: HTTP 404 -> NotFoundError', async () => {
  const mock = installMockFetch(() =>
    jsonResponse({ error: 'Anime not found' }, 404, { 'content-type': 'application/json' }),
  );
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(99999999), NotFoundError);
  } finally {
    mock.restore();
  }
});

test('rate limited: HTTP 429 -> RateLimitError', async () => {
  const mock = installMockFetch(() => jsonResponse({}, 429, { 'retry-after': '1' }));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(1), RateLimitError);
  } finally {
    mock.restore();
  }
});

test('hanging request -> TimeoutError (never hangs indefinitely)', async () => {
  const mock = installMockFetch((call) => new Promise((_, reject) => {
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    const provider = new JikanProvider({ timeoutMs: 50 });
    await assert.rejects(() => provider.getAnimeByMalId(1), TimeoutError);
  } finally {
    mock.restore();
  }
});

test('API failure: HTTP 500 -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('network failure -> ProviderError', async () => {
  const mock = installMockFetch(() => {
    throw new Error('getaddrinfo ENOTFOUND api.jikan.moe');
  });
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('malformed JSON body -> ProviderError', async () => {
  const mock = installMockFetch(() => new Response('not json at all', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('malformed Jikan payload: 200 without data wrapper -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ unexpected: 'shape' }));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('malformed Jikan payload: data is an array -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ data: [animeFixture] }));
  try {
    const provider = new JikanProvider();
    await assert.rejects(() => provider.getAnimeByMalId(1), ProviderError);
  } finally {
    mock.restore();
  }
});

test('provider is stateless: same instance serves different lookups', async () => {
  const mock = installMockFetch((call) => {
    const id = Number(call.url.match(/\/anime\/(\d+)/)[1]);
    return jsonResponse({ data: { mal_id: id } });
  });
  try {
    const provider = new JikanProvider();
    const [a, b] = await Promise.all([provider.getAnimeByMalId(11), provider.getAnimeByMalId(22)]);
    assert.equal(a.mal_id, 11);
    assert.equal(b.mal_id, 22);
  } finally {
    mock.restore();
  }
});
