/**
 * Phase 8 tests: MegaPlay response normalizer (tolerant parser).
 *
 * Covered: recognizable JSON source shapes, empty sources, explicit no-stream
 * signals, plain-URL text, HTML player-page embed (requested URL only),
 * malformed/empty payloads, dedupe, quality/type preservation, episode/expiry
 * pass-through, source-without-URL exclusion. URLs are never fabricated.
 */

import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMegaplayStreamResponse,
  isUsableStreamResult,
} from '../src/normalizers/megaplay-normalizer.js';

const MEGAPLAY_URL = 'https://megaplay.buzz/stream/ani/123/1/sub';

test('JSON with a sources array -> usable, URLs normalized, metadata preserved', () => {
  const result = normalizeMegaplayStreamResponse({
    data: {
      success: true,
      sources: [
        { url: 'https://cdn.example/video-1080.mp4', quality: '1080p' },
        { file: 'https://cdn.example/video-720.mp4', label: '720p', type: 'mp4' },
      ],
    },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, true);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources[0], { url: 'https://cdn.example/video-1080.mp4', quality: '1080p' });
  assert.deepEqual(result.sources[1], { url: 'https://cdn.example/video-720.mp4', quality: '720p', type: 'mp4' });
  assert.ok(isUsableStreamResult(result));
});

test('JSON with a single source object/string under recognized keys -> usable', () => {
  const objectForm = normalizeMegaplayStreamResponse({
    data: { source: { url: 'https://cdn.example/stream.m3u8' } },
    url: MEGAPLAY_URL,
  });
  assert.equal(objectForm.usable, true);
  assert.deepEqual(objectForm.sources, [{ url: 'https://cdn.example/stream.m3u8' }]);

  const stringForm = normalizeMegaplayStreamResponse({
    data: { sources: 'https://cdn.example/stream.m3u8' },
    url: MEGAPLAY_URL,
  });
  assert.equal(stringForm.usable, true);
  assert.deepEqual(stringForm.sources, [{ url: 'https://cdn.example/stream.m3u8' }]);

  const topLevel = normalizeMegaplayStreamResponse({
    data: { url: 'https://cdn.example/stream.m3u8' },
    url: MEGAPLAY_URL,
  });
  assert.equal(topLevel.usable, true);
  assert.deepEqual(topLevel.sources, [{ url: 'https://cdn.example/stream.m3u8' }]);
});

test('duplicate URLs are not duplicated unnecessarily', () => {
  const result = normalizeMegaplayStreamResponse({
    data: {
      sources: [
        { url: 'https://cdn.example/v.mp4', quality: '1080p' },
        { url: 'https://cdn.example/v.mp4', quality: '720p' },
      ],
    },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, true);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://cdn.example/v.mp4');
});

test('sources without a valid URL are excluded (never fabricated)', () => {
  const result = normalizeMegaplayStreamResponse({
    data: {
      sources: [
        { quality: '1080p' },
        { url: 'not-a-url' },
        { url: 'ftp://cdn.example/v.mp4' },
        { url: 'https://cdn.example/v.mp4' },
      ],
    },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, true);
  assert.deepEqual(result.sources, [{ url: 'https://cdn.example/v.mp4' }]);
});

test('empty sources array is NOT a usable stream (genuine no-stream)', () => {
  const result = normalizeMegaplayStreamResponse({
    data: { success: true, sources: [] },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'no_stream');
  assert.deepEqual(result.sources, []);
  assert.ok(!isUsableStreamResult(result));
});

test('explicit success:false is a genuine no-stream result', () => {
  const result = normalizeMegaplayStreamResponse({
    data: { success: false, message: 'episode not found' },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'no_stream');
});

test('explicit error string is a genuine no-stream result', () => {
  const result = normalizeMegaplayStreamResponse({
    data: { error: 'No sources available for this episode' },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'no_stream');
});

test('plain-text body that IS an absolute URL -> usable (URL from MegaPlay)', () => {
  const result = normalizeMegaplayStreamResponse({
    data: 'https://cdn.example/redirected/stream.m3u8\n',
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, true);
  assert.deepEqual(result.sources, [{ url: 'https://cdn.example/redirected/stream.m3u8' }]);
});

test('HTML player page -> embed source at the EXACT documented endpoint URL', () => {
  const result = normalizeMegaplayStreamResponse({
    data: '<!DOCTYPE html><html><body><div id="player"></div></body></html>',
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, true);
  assert.deepEqual(result.sources, [{ url: MEGAPLAY_URL, type: 'embed' }]);
  assert.ok(isUsableStreamResult(result));
});

test('HTML page WITHOUT a known requested URL is NOT usable (never fabricate)', () => {
  const result = normalizeMegaplayStreamResponse({
    data: '<html><body>player</body></html>',
  });
  assert.equal(result.usable, false);
  assert.deepEqual(result.sources, []);
});

// Live-realistic: MegaPlay serves missing streams as HTTP 200 + an HTML
// "Error - MegaPlay" page carrying "Error Code: 410" (observed against the
// real endpoint). It is a genuine no-stream - never a playable embed source.
test('MegaPlay HTML error page (HTTP 200 + Error Code 410) is a genuine no-stream', () => {
  const errorPage = [
    '<!DOCTYPE html><html lang="en"><head><title>Error - MegaPlay</title></head>',
    '<body><div class="error-container">We can\'t find the file you are looking for.',
    'It maybe got deleted by the owner or was removed due a copyright violation.',
    'Error Code: 410</div></body></html>',
  ].join('');
  const result = normalizeMegaplayStreamResponse({ data: errorPage, url: 'https://megaplay.buzz/stream/ani/101922/1/sub' });
  assert.equal(result.usable, false);
  assert.deepEqual(result.sources, []);
  assert.equal(result.reason, 'not_found');
  assert.ok(!isUsableStreamResult(result));
});

test('HTML page with requested URL but NO player markup is NOT usable (never treat error/junk HTML as playable)', () => {
  const result = normalizeMegaplayStreamResponse({
    data: '<html><body><h1>Welcome</h1><p>Some page without a player.</p></body></html>',
    url: 'https://megaplay.buzz/stream/ani/1/1/sub',
  });
  assert.equal(result.usable, false);
  assert.deepEqual(result.sources, []);
});

test('malformed/empty payloads are rejected (never cached as successful streams)', () => {
  for (const data of [null, undefined, '', '   ', '<not-json{', 42, true]) {
    const result = normalizeMegaplayStreamResponse({ data, url: MEGAPLAY_URL });
    assert.equal(result.usable, false, `expected unusable for ${String(data)}`);
    assert.ok(!isUsableStreamResult(result));
  }
});

test('episode and expiry metadata are passed through when present', () => {
  const result = normalizeMegaplayStreamResponse({
    data: {
      sources: [{ url: 'https://cdn.example/v.mp4' }],
      episode: 7,
      expiresAt: '2026-09-17T12:00:00.000Z',
    },
    url: MEGAPLAY_URL,
  });
  assert.equal(result.usable, true);
  assert.equal(result.episode, 7);
  assert.equal(result.expiresAt, '2026-09-17T12:00:00.000Z');
});

test('no-stream results carry null episode/expiry (no invented fields)', () => {
  const result = normalizeMegaplayStreamResponse({ data: { sources: [] }, url: MEGAPLAY_URL });
  assert.equal(result.episode, null);
  assert.equal(result.expiresAt, null);
});
