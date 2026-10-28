/**
 * Phase 8 tests: MegaPlay provider (real shared HTTP client, mocked fetch).
 *
 * Covered: the EXACT documented endpoint URLs (host from config), raw payload
 * return shape ({ data, url }), typed error mapping (timeout/network/404/429/
 * 500), malformed response handling, validation without network calls. No live
 * MegaPlay required.
 */

// Env setup MUST be the first import: short request timeout for fast timeout
// tests, applied before config/env.js loads.
import './helpers/test-env-megaplay.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockFetch, jsonResponse } from './helpers/mock-fetch.js';
import { MegaplayProvider } from '../src/providers/megaplay/megaplay.provider.js';
import { ProviderError, RateLimitError, TimeoutError, ValidationError } from '../src/errors/index.js';

/** A fresh provider instance per test (stateless, request-scoped anyway). */
function makeProvider() {
  return new MegaplayProvider();
}

test('resolveByAnilistId calls the EXACT documented AniList endpoint URL', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({ success: true, sources: [{ url: 'https://cdn.example/v.mp4' }] }));
  try {
    const result = await provider.resolveByAnilistId(123, { episode: 1, language: 'sub' });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, 'https://megaplay.buzz/stream/ani/123/1/sub');
    assert.equal(mock.calls[0].method, 'GET');
    // Raw payload + the exact URL used.
    assert.deepEqual(result.data, { success: true, sources: [{ url: 'https://cdn.example/v.mp4' }] });
    assert.equal(result.url, 'https://megaplay.buzz/stream/ani/123/1/sub');
  } finally {
    mock.restore();
  }
});

test('resolveByMalId calls the EXACT documented MAL endpoint URL', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({ success: true, sources: [] }));
  try {
    const result = await provider.resolveByMalId(456, { episode: 2, language: 'dub' });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, 'https://megaplay.buzz/stream/mal/456/2/dub');
    assert.deepEqual(result.data, { success: true, sources: [] });
    assert.equal(result.url, 'https://megaplay.buzz/stream/mal/456/2/dub');
  } finally {
    mock.restore();
  }
});

test('resolveByAnilistId applies documented defaults (episode 1, sub)', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({ sources: [] }));
  try {
    await provider.resolveByAnilistId(123);
    assert.equal(mock.calls[0].url, 'https://megaplay.buzz/stream/ani/123/1/sub');
  } finally {
    mock.restore();
  }
});

test('validation errors are thrown WITHOUT any network call', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => { throw new Error('must not be called'); });
  try {
    await assert.rejects(() => provider.resolveByAnilistId('abc'), ValidationError);
    await assert.rejects(() => provider.resolveByAnilistId(0), ValidationError);
    await assert.rejects(() => provider.resolveByMalId(-1), ValidationError);
    await assert.rejects(() => provider.resolveByAnilistId(123, { episode: 0 }), ValidationError);
    await assert.rejects(() => provider.resolveByAnilistId(123, { language: 'xyz' }), ValidationError);
    await assert.rejects(() => provider.resolveByMalId(456, { episode: 999999 }), ValidationError);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('HTTP 404 -> ProviderError tagged with upstreamStatus 404 (genuine not-found)', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({ error: 'Not Found' }, 404));
  try {
    await assert.rejects(
      () => provider.resolveByAnilistId(123),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.details.upstreamStatus, 404);
        assert.equal(err.provider, 'megaplay');
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test('HTTP 429 -> RateLimitError', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({}, 429));
  try {
    await assert.rejects(() => provider.resolveByAnilistId(123), RateLimitError);
  } finally {
    mock.restore();
  }
});

test('HTTP 500 -> ProviderError (infrastructure failure, NOT not-found)', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => jsonResponse({ error: 'server error' }, 500));
  try {
    await assert.rejects(
      () => provider.resolveByMalId(456),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.details.upstreamStatus, 500);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test('network failure -> ProviderError', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => { throw new Error('ECONNREFUSED'); });
  try {
    await assert.rejects(() => provider.resolveByAnilistId(123), ProviderError);
  } finally {
    mock.restore();
  }
});

test('timeout -> TimeoutError (shared timeout honored)', async () => {
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
    await assert.rejects(() => provider.resolveByAnilistId(123), TimeoutError);
  } finally {
    mock.restore();
  }
});

test('malformed JSON body -> raw null data returned without throwing', async () => {
  const provider = makeProvider();
  const mock = installMockFetch(() => ({
    status: 200,
    body: '<not-json{',
    contentType: 'application/json',
  }));
  try {
    const result = await provider.resolveByAnilistId(123);
    assert.equal(result.data, null); // normalizer decides usable-vs-not
    assert.equal(result.url, 'https://megaplay.buzz/stream/ani/123/1/sub');
  } finally {
    mock.restore();
  }
});
