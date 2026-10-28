/**
 * TMDB provider tests - behavior with MOCKED HTTP responses.
 *
 * No live TMDB API calls and no real API keys required (a test key is injected
 * via the provider's apiKey option). Uses the mock-fetch helper (real Response
 * objects) so the shared HTTP client behaves exactly as in production.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { TmdbProvider } = await import('../src/providers/tmdb/tmdb.provider.js');
const { installMockFetch, jsonResponse } = await import('./helpers/mock-fetch.js');
const {
  ProviderError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} = await import('../src/errors/index.js');

const searchPayload = { page: 1, results: [{ id: 789, name: 'One Punch Man', original_name: 'ワンパンマン' }] };
const detailsPayload = { id: 789, name: 'One Punch Man', backdrop_path: '/abc.jpg', poster_path: '/def.jpg' };

test('successful search -> raw payload, query + api_key in URL', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    const result = await provider.searchTv('one punch');
    assert.deepEqual(result, searchPayload); // RAW payload, not normalized
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].method, 'GET');
    assert.ok(mock.calls[0].url.startsWith('https://api.themoviedb.org/3/search/tv?'));
    assert.ok(mock.calls[0].url.includes('query=one+punch'));
    assert.ok(mock.calls[0].url.includes('api_key=test-key'));
  } finally {
    mock.restore();
  }
});

test('successful details -> raw payload with central URL construction', async () => {
  const mock = installMockFetch(() => jsonResponse(detailsPayload));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    const result = await provider.getTvDetails(789);
    assert.deepEqual(result, detailsPayload);
    assert.ok(mock.calls[0].url.includes('/tv/789'));
    assert.ok(mock.calls[0].url.includes('api_key=test-key'));
  } finally {
    mock.restore();
  }
});

test('movie search/details use the movie endpoints', async () => {
  const mock = installMockFetch((_call, index) =>
    index === 1 ? jsonResponse(searchPayload) : jsonResponse(detailsPayload),
  );
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await provider.searchMovie('spirited away', { page: 2 });
    assert.ok(mock.calls[0].url.includes('/search/movie?'));
    assert.ok(mock.calls[0].url.includes('page=2'));
    await provider.getMovieDetails(129);
    assert.ok(mock.calls[1].url.includes('/movie/129'));
  } finally {
    mock.restore();
  }
});

test('auth: JWT-shaped key uses Bearer header, no api_key query param (secret never in URL)', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    const provider = new TmdbProvider({ apiKey: 'eyJhbGciOiJIUzI1NiJ9.test.token' });
    await provider.searchTv('one punch');
    assert.ok(mock.calls[0].init.headers.Authorization.startsWith('Bearer ey'));
    assert.equal(mock.calls[0].url.includes('api_key='), false);
  } finally {
    mock.restore();
  }
});

test('missing credentials -> clear ProviderError, no fabricated data, no request', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    const provider = new TmdbProvider({ apiKey: '' });
    assert.equal(provider.isConfigured(), false);
    await assert.rejects(() => provider.searchTv('one punch'), /TMDB API key is not configured/);
    await assert.rejects(() => provider.getTvDetails(789), /TMDB API key is not configured/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('validation: invalid query / page / TMDB ID -> ValidationError, no request', async () => {
  const mock = installMockFetch(() => jsonResponse(searchPayload));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.searchTv(123), ValidationError);
    await assert.rejects(() => provider.searchTv(''), ValidationError);
    await assert.rejects(() => provider.searchTv('   '), ValidationError);
    await assert.rejects(() => provider.searchTv('x', { page: 0 }), ValidationError);
    await assert.rejects(() => provider.getTvDetails(0), ValidationError);
    await assert.rejects(() => provider.getTvDetails('abc'), ValidationError);
    await assert.rejects(() => provider.getMovieDetails(null), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('not found: HTTP 404 on details -> NotFoundError', async () => {
  const mock = installMockFetch(() => jsonResponse({ status_message: 'not found' }, 404));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.getTvDetails(99999999), NotFoundError);
  } finally {
    mock.restore();
  }
});

test('rate limited: HTTP 429 -> RateLimitError', async () => {
  const mock = installMockFetch(() => jsonResponse({}, 429, { 'retry-after': '1' }));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.searchTv('x'), RateLimitError);
  } finally {
    mock.restore();
  }
});

test('hanging request -> TimeoutError (never hangs indefinitely)', async () => {
  const mock = installMockFetch((call) => new Promise((_, reject) => {
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key', timeoutMs: 50 });
    await assert.rejects(() => provider.searchTv('x'), TimeoutError);
  } finally {
    mock.restore();
  }
});

test('API failure: HTTP 500 -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ error: 'boom' }, 500));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.searchTv('x'), ProviderError);
  } finally {
    mock.restore();
  }
});

test('network failure -> ProviderError', async () => {
  const mock = installMockFetch(() => { throw new Error('ENOTFOUND'); });
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.searchTv('x'), ProviderError);
  } finally {
    mock.restore();
  }
});

test('malformed response: HTTP 200 without results array -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ unexpected: 'shape' }));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.searchTv('x'), ProviderError);
  } finally {
    mock.restore();
  }
});

test('missing results: empty results array is VALID (returns raw payload)', async () => {
  const mock = installMockFetch(() => jsonResponse({ page: 1, results: [] }));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    const result = await provider.searchTv('zzz-no-match');
    assert.deepEqual(result, { page: 1, results: [] }); // not a failure
  } finally {
    mock.restore();
  }
});

test('malformed details: HTTP 200 without valid id -> ProviderError', async () => {
  const mock = installMockFetch(() => jsonResponse({ unexpected: true }));
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    await assert.rejects(() => provider.getTvDetails(789), ProviderError);
  } finally {
    mock.restore();
  }
});

test('provider is stateless and request-scoped', async () => {
  const mock = installMockFetch((call) => {
    const id = Number(call.url.match(/\/tv\/(\d+)/)[1]);
    return jsonResponse({ id, name: `TV ${id}` });
  });
  try {
    const provider = new TmdbProvider({ apiKey: 'test-key' });
    const [a, b] = await Promise.all([provider.getTvDetails(11), provider.getTvDetails(22)]);
    assert.equal(a.id, 11);
    assert.equal(b.id, 22);
  } finally {
    mock.restore();
  }
});
