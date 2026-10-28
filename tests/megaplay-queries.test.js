/**
 * Phase 8 tests: MegaPlay query/url construction.
 *
 * Covered: the EXACT documented endpoint paths for both id kinds, validation
 * of id/episode/language path segments (no host replacement, no path tricks,
 * no fabricated URLs), documented defaults.
 */

import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAniListStreamUrl,
  buildMalStreamUrl,
  normalizeEpisode,
  normalizeLanguage,
} from '../src/providers/megaplay/megaplay.queries.js';

test('buildAniListStreamUrl produces the EXACT documented AniList path', () => {
  assert.equal(buildAniListStreamUrl(123, 1, 'sub'), '/stream/ani/123/1/sub');
  assert.equal(buildAniListStreamUrl(99999, 12, 'dub'), '/stream/ani/99999/12/dub');
});

test('buildMalStreamUrl produces the EXACT documented MAL path', () => {
  assert.equal(buildMalStreamUrl(456, 1, 'sub'), '/stream/mal/456/1/sub');
  assert.equal(buildMalStreamUrl(777, 25, 'dub'), '/stream/mal/777/25/dub');
});

test('documented defaults: episode 1, language sub', () => {
  assert.equal(buildAniListStreamUrl(123), '/stream/ani/123/1/sub');
  assert.equal(buildMalStreamUrl(456), '/stream/mal/456/1/sub');
  assert.equal(normalizeEpisode(undefined), 1);
  assert.equal(normalizeEpisode(null), 1);
  assert.equal(normalizeLanguage(undefined), 'sub');
  assert.equal(normalizeLanguage(''), 'sub');
});

test('paths never contain the host (host comes only from config)', () => {
  const path = buildAniListStreamUrl(123, 1, 'sub');
  assert.ok(path.startsWith('/stream/ani/'));
  assert.ok(!path.includes('megaplay'));
  assert.ok(!path.includes('http'));
});

test('invalid IDs are rejected (no path tricks, no fabricated IDs)', () => {
  for (const bad of ['abc', 0, -1, '1.5', '', null, undefined, '../..', '123/../456']) {
    assert.throws(() => buildAniListStreamUrl(bad), Error, `expected throw for ${String(bad)}`);
    assert.throws(() => buildMalStreamUrl(bad), Error, `expected throw for ${String(bad)}`);
  }
});

test('invalid episode values are rejected (zero/negative/non-integer/excessive)', () => {
  for (const bad of [0, -1, 2.5, 'abc', '999999999']) {
    assert.throws(() => buildAniListStreamUrl(123, bad), Error, `expected throw for episode=${String(bad)}`);
  }
  assert.throws(() => buildAniListStreamUrl(123, 2001), /maximum/); // just past the bound
  assert.equal(buildAniListStreamUrl(123, 2000), '/stream/ani/123/2000/sub'); // at the bound
});

test('invalid language values are rejected (documented sub|dub only)', () => {
  for (const bad of ['xyz', 'SUB', 'eng', 'jp', 1]) {
    assert.throws(() => buildAniListStreamUrl(123, 1, bad), Error, `expected throw for language=${String(bad)}`);
  }
  // null falls back to the documented default rather than throwing.
  assert.equal(buildAniListStreamUrl(123, 1, null), '/stream/ani/123/1/sub');
});

test('normalizeEpisode validation errors carry the received value', () => {
  try {
    normalizeEpisode(-3);
    assert.fail('expected ValidationError');
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.details.received, -3);
  }
});

test('normalizeLanguage validation errors carry the received value', () => {
  try {
    normalizeLanguage('french');
    assert.fail('expected ValidationError');
  } catch (err) {
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.details.received, 'french');
  }
});
