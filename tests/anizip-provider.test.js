/**
 * AniZip provider tests (real shared HTTP client, mocked fetch).
 *
 * Covered: the EXACT live-verified endpoint URL (anilist_id used DIRECTLY -
 * never a MAL conversion), raw payload passthrough, AniList ID validation
 * without network calls, and typed error mapping (404 -> NotFoundError;
 * 429/500/timeout/network per the shared HTTP client). No live AniZip.
 */

import './helpers/test-env-megaplay.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockFetch, jsonResponse } from './helpers/mock-fetch.js';
import { AnizipProvider } from '../src/providers/anizip/anizip.provider.js';
import { NotFoundError, ProviderError, RateLimitError, TimeoutError, ValidationError } from '../src/errors/index.js';

function makeProvider() {
  return new AnizipProvider();
}

test('getMappingsByAnilistId calls the EXACT live-verified endpoint URL (AniList ID used DIRECTLY)', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({ episodes: {} }));
  try {
    await provider.getMappingsByAnilistId(21);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, 'https://api.ani.zip/mappings?anilist_id=21');
    assert.equal(mock.calls[0].method, 'GET');
    // The AniList ID is NEVER converted to a MAL ID for this request.
    assert.ok(!mock.calls[0].url.includes('mal'));
  } finally {
    mock.restore();
  }
});

test('getMappingsByAnilistId returns the RAW payload untouched', async () => {
  const provider = makeProvider();
  const payload = {
    titles: { en: 'One Piece' },
    episodes: { '1': { episode: '1', episodeNumber: 1 } },
    episodeCount: 1,
    specialCount: 0,
    images: [],
    mappings: { anilist_id: 21, mal_id: 21 },
  };
  const mock = installMockFetch(() => jsonResponse(payload));
  try {
    const result = await provider.getMappingsByAnilistId(21);
    assert.deepEqual(result, payload);
  } finally {
    mock.restore();
  }
});

test('getMappingsByAnilistId validates the AniList ID BEFORE any request', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => { throw new Error('must not be called'); });
  try {
    for (const bad of ['abc', 0, -1, '1.5', '', null, undefined]) {
      await assert.rejects(() => provider.getMappingsByAnilistId(bad), ValidationError);
    }
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('upstream 404 ("Not Found" - no mapping) maps to a typed NotFoundError', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse('Not Found', 404));
  try {
    await assert.rejects(
      () => provider.getMappingsByAnilistId(999999999),
      NotFoundError,
    );
  } finally {
    mock.restore();
  }
});

test('429/500/transport failures stay typed RateLimitError/ProviderError', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({}, 429, { 'retry-after': '0' }));
  try {
    await assert.rejects(() => provider.getMappingsByAnilistId(21), RateLimitError);
  } finally {
    mock.restore();
  }

  const mock2 = installMockFetch(() => jsonResponse({}, 500));
  try {
    await assert.rejects(() => provider.getMappingsByAnilistId(21), ProviderError);
  } finally {
    mock2.restore();
  }

  const mock3 = installMockFetch(() => { throw new TypeError('fetch failed'); });
  try {
    await assert.rejects(() => provider.getMappingsByAnilistId(21), ProviderError);
  } finally {
    mock3.restore();
  }
});

test('timeout maps to a typed TimeoutError (short timeout from the test env)', async () => {
  const provider = makeProvider();
  const mock = installMockFetch((call) => new Promise((_, reject) => {
    // Simulate real fetch: rejects when the AbortController fires.
    call.init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  try {
    await assert.rejects(() => provider.getMappingsByAnilistId(21), TimeoutError);
  } finally {
    mock.restore();
  }
});
