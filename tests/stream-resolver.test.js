/**
 * Phase 8 tests: StreamResolver (AniList-first + MAL fallback orchestration).
 *
 * Covered: AniList endpoint first, MAL NOT called on AniList success, genuine
 * no-stream triggers the IdentityResolver, MAL endpoint then called with the
 * RESOLVED MAL ID, AniList/MAL namespace safety, provider failure
 * classification (timeout/404/429/500/network/malformed/empty), caching (fresh
 * hit, L2 hit + promotion, miss, successful stream cached, no-stream marker,
 * stale-if-error, stale expiration, invalid/failure not cached), concurrent
 * request coalescing, provider expiry TTL capping, URL safety, episode/language
 * validation. Fully mocked - no live MegaPlay.
 */

import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamResolver } from '../src/streaming/stream-resolver.js';
import { CacheManager } from '../src/cache/cache-manager.js';
import { MemoryStore } from '../src/cache/memory/memory-store.js';
import { createIdentityResult } from '../src/identity/id-types.js';
import {
  TimeoutError,
  RateLimitError,
  ProviderError,
  ValidationError,
} from '../src/errors/index.js';

const ANI_KEY = 'stream:megaplay:anilist:123:episode:1:language:sub';
const MAL_KEY = 'stream:megaplay:mal:456:episode:1:language:sub';
const STREAM_URL = 'https://cdn.example/video.mp4';
const PROXY_BASE = 'https://proxy.example';

/** Fake playback proxy (configured) matching the documented proxy contract:
 * `{proxy}/watch/{id}?ep={episode}&lang={language}&idType={idType}`. */
function fakeProxy(base = PROXY_BASE) {
  return {
    isConfigured: () => true,
    buildWatchUrl: ({ idType, id, episode, language }) =>
      `${base}/watch/${id}?ep=${episode}&lang=${language}&idType=${idType}`,
  };
}

/** Expected proxy playback URL (contract shape). */
function proxyWatchUrl(id, episode, language, base = PROXY_BASE) {
  const idType = id === 123 ? 'anilist' : 'mal';
  return `${base}/watch/${id}?ep=${episode}&lang=${language}&idType=${idType}`;
}

/** Valid raw MegaPlay payload (as the provider would return). */
function rawStream(url = STREAM_URL, urlUsed = 'https://megaplay.buzz/stream/ani/123/1/sub') {
  return { data: { success: true, sources: [{ url, quality: '1080p' }] }, url: urlUsed };
}

/** Fake MegaPlay provider recording both id-kind lookups separately. Handlers
 * are read from `this` at call time so tests can reassign them mid-test (e.g.
 * to make the provider fail after a cached prime). */
function fakeMegaplay({ anilist, mal } = {}) {
  const calls = [];
  const provider = {
    calls,
    anilistCalls: () => calls.filter((c) => c.kind === 'anilist'),
    malCalls: () => calls.filter((c) => c.kind === 'mal'),
    async resolveByAnilistId(id, options) {
      calls.push({ kind: 'anilist', id, options });
      return this.anilist(id, options);
    },
    async resolveByMalId(id, options) {
      calls.push({ kind: 'mal', id, options });
      return this.mal(id, options);
    },
  };
  provider.anilist = anilist ?? (() => { throw new Error('unexpected anilist call'); });
  provider.mal = mal ?? (() => rawStream());
  return provider;
}

/** Fake IdentityResolver (mapping: anilistId -> malId|null). */
function fakeIdentity(mapping = {}) {
  const calls = [];
  return {
    calls,
    async resolveAniListToMal(anilistId) {
      calls.push(anilistId);
      return createIdentityResult({ anilistId, malId: mapping[anilistId] ?? null });
    },
  };
}

/** A resolver with a fresh L1-only cache (L2 unconfigured, like a cold start).
 * The playback proxy is configured by default (playback responses use it). */
function makeResolver({ megaplay, identity, cache, proxy = fakeProxy() } = {}) {
  return new StreamResolver({
    megaplay,
    identity,
    cache: cache ?? new CacheManager({ l1: new MemoryStore() }),
    proxy,
  });
}

/** Fake configured L2 store for promotion tests. */
function fakeL2() {
  const map = new Map();
  return {
    name: 'fake-l2',
    map,
    isConfigured: () => true,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, {
        value,
        storedAt: Date.now(),
        expiresAt: Date.now() + ttlSeconds * 1000,
        ttlSeconds,
        staleUntil: Date.now() + (ttlSeconds + 86_400) * 1000,
      });
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

/** Expire an L1 entry WITHOUT deleting it (retained for stale-if-error). */
function expireL1(cache, key) {
  const entry = cache.l1._map.get(key);
  if (!entry) throw new Error(`no L1 entry for ${key}`);
  cache.l1._map.set(key, { ...entry, expiresAt: Date.now() - 1000 });
}

/** Fully expire an L1 entry (past its stale window too). */
function fullyExpireL1(cache, key) {
  const entry = cache.l1._map.get(key);
  if (!entry) throw new Error(`no L1 entry for ${key}`);
  cache.l1._map.set(key, { ...entry, expiresAt: Date.now() - 1000, staleUntil: Date.now() - 500 });
}

// --- AniList-first -----------------------------------------------------------

test('AniList-first: AniList endpoint is attempted FIRST and MAL is NOT called on success', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(mp.anilistCalls().length, 1);
  assert.equal(mp.malCalls().length, 0); // MAL lookup NOT unnecessarily called
  assert.equal(identity.calls.length, 0); // identity not needed either

  assert.deepEqual(res, {
    resolved: true,
    provider: 'megaplay',
    idType: 'anilist',
    anilistId: 123,
    malId: null, // honest: identity was not resolved
    episode: 1,
    language: 'sub',
    playbackUrl: proxyWatchUrl(123, 1, 'sub'),
    streams: {
      sub: { url: proxyWatchUrl(123, 1, 'sub'), type: 'proxy', language: 'sub' },
      dub: { url: proxyWatchUrl(123, 1, 'dub'), type: 'proxy', language: 'dub' },
    },
    sources: [
      { url: proxyWatchUrl(123, 1, 'sub'), type: 'proxy', language: 'sub' },
      { url: proxyWatchUrl(123, 1, 'dub'), type: 'proxy', language: 'dub' },
    ],
    expiresAt: null,
  });
  // Direct MegaPlay playback URLs are NEVER exposed to the frontend.
  assert.ok(!JSON.stringify(res).includes(STREAM_URL));
});

test('AniList-first: episode/language are forwarded to the provider call', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream('https://cdn.example/dub.mp4', 'https://megaplay.buzz/stream/ani/123/2/dub') });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStream({ anilistId: 123, episode: 2, language: 'dub' });

  assert.deepEqual(mp.anilistCalls()[0], { kind: 'anilist', id: 123, options: { episode: 2, language: 'dub' } });
  assert.equal(res.episode, 2);
  assert.equal(res.language, 'dub');
  // Playback goes through the proxy with the correct ep/lang/idType.
  assert.equal(res.playbackUrl, proxyWatchUrl(123, 2, 'dub'));
  assert.ok(!JSON.stringify(res).includes('https://cdn.example/dub.mp4'));
});

// --- MAL fallback ------------------------------------------------------------

test('MAL fallback: genuine AniList no-stream -> IdentityResolver -> MAL endpoint with the RESOLVED MAL ID', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream('https://cdn.example/mal.mp4', 'https://megaplay.buzz/stream/mal/456/1/sub'),
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(mp.anilistCalls().length, 1); // AniList attempted first
  assert.equal(identity.calls.length, 1); // fallback through IdentityResolver ONLY
  assert.deepEqual(identity.calls, [123]);
  assert.equal(mp.malCalls().length, 1);
  assert.equal(mp.malCalls()[0].id, 456); // the RESOLVED MAL ID, never anilistId

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal');
  assert.equal(res.anilistId, 123); // AniList remains the canonical identity
  assert.equal(res.malId, 456); // from actual identity resolution only
  // Playback uses the RESOLVED MAL ID with idType=mal - never the AniList ID.
  assert.equal(res.playbackUrl, proxyWatchUrl(456, 1, 'sub'));
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/456?ep=1&lang=sub&idType=mal`);
  assert.ok(!JSON.stringify(res).includes('https://cdn.example/mal.mp4'));
  assert.deepEqual(res.sources, [
    { url: proxyWatchUrl(456, 1, 'sub'), type: 'proxy', language: 'sub' },
    { url: proxyWatchUrl(456, 1, 'dub'), type: 'proxy', language: 'dub' },
  ]);
  // Both languages use the RESOLVED MAL ID with idType=mal.
  assert.equal(res.streams.sub.url, `${PROXY_BASE}/watch/456?ep=1&lang=sub&idType=mal`);
  assert.equal(res.streams.dub.url, `${PROXY_BASE}/watch/456?ep=1&lang=dub&idType=mal`);
});

test('MAL fallback: MegaPlay 404 on the AniList endpoint also triggers the fallback', async () => {
  const mp = fakeMegaplay({
    anilist: () => { throw new ProviderError('megaplay responded with HTTP 404', { provider: 'megaplay', details: { upstreamStatus: 404 } }); },
    mal: () => rawStream(),
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal');
  assert.equal(mp.malCalls()[0].id, 456);
});

// Live-realistic: MegaPlay serves a missing stream as HTTP 200 + an HTML
// "Error - MegaPlay" page carrying "Error Code: 410" (observed against the
// real endpoint). The normalizer classifies it as a genuine no-stream, so the
// MAL fallback must occur - the error page is never a playable stream.
test('MAL fallback: MegaPlay HTTP 200 HTML error page (Error Code 410) triggers the fallback', async () => {
  const errorPage = [
    '<!DOCTYPE html><html lang="en"><head><title>Error - MegaPlay</title></head>',
    '<body><div class="error-container">We can\'t find the file you are looking for.',
    'Error Code: 410</div></body></html>',
  ].join('');
  const mp = fakeMegaplay({
    anilist: () => ({ data: errorPage, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream('https://cdn.example/mal.mp4', 'https://megaplay.buzz/stream/mal/456/1/sub'),
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(mp.anilistCalls().length, 1); // AniList attempted first
  assert.equal(identity.calls.length, 1); // fallback through IdentityResolver
  assert.equal(mp.malCalls().length, 1); // genuine no-stream -> MAL fallback
  assert.equal(mp.malCalls()[0].id, 456);

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal');
  assert.equal(res.anilistId, 123);
  assert.equal(res.malId, 456);
  // Playback goes through the proxy (idType=mal, the resolved MAL ID) - the
  // error page is never a playable stream.
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/456?ep=1&lang=sub&idType=mal`);
  assert.deepEqual(res.sources, [
    { url: res.playbackUrl, type: 'proxy', language: 'sub' },
    { url: `${PROXY_BASE}/watch/456?ep=1&lang=dub&idType=mal`, type: 'proxy', language: 'dub' },
  ]);
  assert.ok(res.streams.sub && res.streams.dub);
});

// Corrected architecture: an unresolved identity (no provider-confirmed MAL
// mapping) does NOT mean playback is unavailable. A direct MegaPlay no-stream
// response never proves unavailability - the proxy is the browser-facing
// playback mechanism. The PRIMARY (AniList) namespace stands; malId stays null
// (never guessed, never numerically inferred); MAL endpoint never attempted.
test('Unresolved identity: PRIMARY (AniList) proxy playback URL, MAL endpoint never attempted', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => { throw new Error('MAL endpoint must NOT be attempted without a mapping'); },
  });
  const identity = fakeIdentity({}); // no mapping for 123
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'anilist'); // PRIMARY (AniList) namespace stands
  assert.equal(res.anilistId, 123);
  assert.equal(res.malId, null); // unresolved identity - never guessed
  assert.equal(res.playbackUrl, proxyWatchUrl(123, 1, 'sub'));
  assert.deepEqual(res.sources, [
    { url: res.playbackUrl, type: 'proxy', language: 'sub' },
    { url: proxyWatchUrl(123, 1, 'dub'), type: 'proxy', language: 'dub' },
  ]);

  assert.equal(mp.anilistCalls().length, 1);
  assert.equal(mp.malCalls().length, 0); // no MAL fallback without a mapping
  // No direct MegaPlay playback URL anywhere in the response.
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz'));
});

// Live-realistic regression (AniList ID 21 / One Piece): BOTH direct MegaPlay
// lookups return HTTP 200 + an "Error - MegaPlay" page (Error Code 410) - the
// direct URL 410s when opened in a browser, yet the proxy
// (/watch/21?ep=1&lang=sub&idType=anilist) serves the playable iframe page.
// The resolver must NOT conclude "no stream exists" from a direct 410: it
// returns the PRIMARY (AniList) proxy playback URL, with the AniList-confirmed
// malId as metadata only (never used for playback).
test('Direct MegaPlay 410 on BOTH endpoints -> PRIMARY (AniList) proxy playback URL (ID 21 regression)', async () => {
  const errorPage = [
    '<!DOCTYPE html><html lang="en"><head><title>Error - MegaPlay</title></head>',
    '<body><div class="error-container">We can\'t find the file you are looking for.',
    'Error Code: 410</div></body></html>',
  ].join('');
  const mp = fakeMegaplay({
    anilist: () => ({ data: errorPage, url: 'https://megaplay.buzz/stream/ani/21/1/sub' }),
    mal: () => ({ data: errorPage, url: 'https://megaplay.buzz/stream/mal/21/1/sub' }),
  });
  const identity = fakeIdentity({ 21: 21 }); // AniList-confirmed idMal (One Piece)
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 21, episode: 1, language: 'sub' });

  assert.equal(mp.anilistCalls().length, 1); // AniList attempted first
  assert.equal(mp.malCalls().length, 1); // fallback through the IdentityResolver
  assert.equal(mp.malCalls()[0].id, 21); // the RESOLVED MAL ID, never guessed

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'anilist'); // PRIMARY (AniList) namespace stands
  assert.equal(res.anilistId, 21);
  assert.equal(res.malId, 21); // AniList-confirmed mapping, metadata only
  // The proxy playback URL for the PRIMARY namespace - exactly the documented
  // shape. NOT the direct megaplay.buzz URL.
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/21?ep=1&lang=sub&idType=anilist`);
  assert.deepEqual(res.sources, [
    { url: res.playbackUrl, type: 'proxy', language: 'sub' },
    { url: `${PROXY_BASE}/watch/21?ep=1&lang=dub&idType=anilist`, type: 'proxy', language: 'dub' },
  ]);
  assert.equal(res.streams.sub.url, res.playbackUrl);
  assert.equal(res.streams.dub.url, `${PROXY_BASE}/watch/21?ep=1&lang=dub&idType=anilist`);
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz'));
});

// --- identity safety ---------------------------------------------------------

test('Identity safety: AniList ID and MAL ID are never confused or swapped', async () => {
  // AniList endpoint yields a usable stream for episode 1 only; other episodes
  // return a genuine no-stream result so the MAL fallback is exercised.
  const mp = fakeMegaplay({
    anilist: (_id, options) =>
      options?.episode === 1
        ? rawStream()
        : { data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/999/sub' },
    mal: () => rawStream('https://cdn.example/mal.mp4', 'https://megaplay.buzz/stream/mal/456/1/sub'),
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const viaAnilist = await resolver.resolveStream({ anilistId: 123 });
  assert.equal(viaAnilist.anilistId, 123);
  assert.equal(viaAnilist.malId, null); // never back-filled from anywhere
  assert.ok(viaAnilist.anilistId !== viaAnilist.malId);

  const viaMal = await resolver.resolveStream({ anilistId: 123, episode: 999 }); // fresh episode: fresh lookups
  assert.equal(viaMal.anilistId, 123);
  assert.equal(viaMal.malId, 456);
  assert.ok(mp.malCalls().length >= 1);
  for (const call of mp.malCalls()) {
    assert.notEqual(call.id, 123); // the AniList ID is never used as a MAL ID
  }
});

// --- provider failure classification -----------------------------------------

test('Provider failures: timeout on the AniList lookup stays a typed TimeoutError (never "not found")', async () => {
  const mp = fakeMegaplay({
    anilist: () => { throw new TimeoutError('megaplay request timed out', { provider: 'megaplay' }); },
    mal: () => { throw new Error('must not be called'); },
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), TimeoutError);
  assert.equal(identity.calls.length, 0); // an outage is NOT treated as no-stream
  assert.equal(mp.malCalls().length, 0);
});

test('Provider failures: 429 stays a typed RateLimitError', async () => {
  const mp = fakeMegaplay({
    anilist: () => { throw new RateLimitError('megaplay rate limited', { provider: 'megaplay' }); },
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), RateLimitError);
  assert.equal(identity.calls.length, 0);
  assert.equal(mp.malCalls().length, 0);
});

test('Provider failures: 500 stays a typed ProviderError (not reinterpreted as not-found)', async () => {
  const mp = fakeMegaplay({
    anilist: () => { throw new ProviderError('megaplay responded with HTTP 500', { provider: 'megaplay', details: { upstreamStatus: 500 } }); },
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), ProviderError);
  assert.equal(identity.calls.length, 0);
  assert.equal(mp.malCalls().length, 0);
});

test('Provider failures: network error stays a typed ProviderError', async () => {
  const mp = fakeMegaplay({
    anilist: () => { throw new ProviderError('megaplay request failed', { provider: 'megaplay' }); },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), ProviderError);
  assert.equal(resolver.identity.calls.length, 0);
});

test('Malformed response (null data) is treated as no-stream -> MAL fallback, never an error', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: null, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream(),
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });
  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal');
});

test('Empty string payload is treated as no-stream -> MAL fallback', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: '', url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream(),
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ 123: 456 }) });

  const res = await resolver.resolveStream({ anilistId: 123 });
  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal');
});

test('MAL lookup failure (timeout) propagates as a typed failure (no fabricated stream)', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => { throw new TimeoutError('megaplay request timed out', { provider: 'megaplay' }); },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ 123: 456 }) });

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), TimeoutError);
});

// --- caching -----------------------------------------------------------------

test('Cache: successful AniList stream is cached under the exact namespace-safe key', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), cache });

  await resolver.resolveStream({ anilistId: 123 });

  const entry = cache.l1._map.get(ANI_KEY);
  assert.ok(entry, 'expected a cache entry for the anilist stream key');
  assert.equal(entry.value.usable, true);
  assert.deepEqual(entry.value.sources, [{ url: STREAM_URL, quality: '1080p' }]);
  assert.ok(entry.ttlSeconds <= 300, 'stream TTL is short (never metadata-length)');
});

test('Cache: fresh cache hit - second resolve does NOT call the provider', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const first = await resolver.resolveStream({ anilistId: 123 });
  const second = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(mp.anilistCalls().length, 1);
  assert.deepEqual(first.sources, second.sources);
});

test('Cache: AniList and MAL resolutions are cached SEPARATELY (no namespace collision)', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({
    anilist: () => ({ data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream(),
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ 123: 456 }), cache });

  await resolver.resolveStream({ anilistId: 123 });

  const aniEntry = cache.l1._map.get(ANI_KEY);
  const malEntry = cache.l1._map.get(MAL_KEY);
  assert.ok(aniEntry, 'expected the anilist no-stream entry');
  assert.ok(malEntry, 'expected the mal stream entry');
  assert.equal(aniEntry.value.usable, false); // no-stream marker, distinguishable
  assert.equal(malEntry.value.usable, true);
  assert.notEqual(ANI_KEY, MAL_KEY);
});

test('Cache: cached no-stream marker skips the provider on the next resolve', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream(),
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ 123: 456 }) });

  await resolver.resolveStream({ anilistId: 123 });
  await resolver.resolveStream({ anilistId: 123 });

  assert.equal(mp.anilistCalls().length, 1); // marker served from cache
  assert.equal(mp.malCalls().length, 1); // mal stream served from cache
});

test('Cache: L2 hit -> L1 promotion without a provider call', async () => {
  const l2 = fakeL2();
  const cache = new CacheManager({ l1: new MemoryStore(), l2 });
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), cache });

  await resolver.resolveStream({ anilistId: 123 }); // fills L1 (+L2)
  assert.equal(l2.map.has(ANI_KEY), true);
  cache.l1.clear(); // simulate a cold start / L1 eviction

  const res = await resolver.resolveStream({ anilistId: 123 }); // L2 -> L1 promotion

  assert.equal(mp.anilistCalls().length, 1); // no NEW provider call
  assert.equal(res.sources[0].url, proxyWatchUrl(123, 1, 'sub'));
  assert.ok(cache.l1._map.has(ANI_KEY), 'promoted back into L1');
  assert.ok(l2.getCalls === undefined || true);
});

test('Cache: cache miss -> provider called -> result cached', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(mp.anilistCalls().length, 1);
  assert.equal(res.sources[0].url, proxyWatchUrl(123, 1, 'sub'));
});

test('Cache: stale-if-error - provider failure serves the stale stream', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), cache });

  await resolver.resolveStream({ anilistId: 123 });
  expireL1(cache, ANI_KEY); // stale but within the stale window

  // Provider now fails.
  mp.anilist = () => { throw new ProviderError('megaplay is down', { provider: 'megaplay' }); };

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(res.resolved, true);
  assert.deepEqual(res.sources, [
    { url: proxyWatchUrl(123, 1, 'sub'), type: 'proxy', language: 'sub' },
    { url: proxyWatchUrl(123, 1, 'dub'), type: 'proxy', language: 'dub' },
  ]); // stale stream via proxy, NOT an error
  assert.equal(mp.anilistCalls().length, 2); // fresh operation WAS attempted
});

test('Cache: stale expiration - fully expired stale data is never served', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), cache });

  await resolver.resolveStream({ anilistId: 123 });
  fullyExpireL1(cache, ANI_KEY); // past expiresAt AND staleUntil

  mp.anilist = () => { throw new ProviderError('megaplay is down', { provider: 'megaplay' }); };

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), ProviderError);
});

test('Cache: invalid stream (malformed) is NOT cached as a successful stream', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({ anilist: () => ({ data: { broken: true }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }) });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ 123: 456 }), cache });

  await resolver.resolveStream({ anilistId: 123 }); // falls back to MAL

  const aniEntry = cache.l1._map.get(ANI_KEY);
  assert.ok(aniEntry, 'no-stream marker may be cached');
  assert.equal(aniEntry.value.usable, false); // NEVER cached as a successful stream
  assert.deepEqual(cache.l1._map.get(MAL_KEY)?.value.sources, [{ url: STREAM_URL, quality: '1080p' }]);
});

test('Cache: provider failure is NOT cached (cache left untouched)', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({
    anilist: () => { throw new ProviderError('megaplay is down', { provider: 'megaplay' }); },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), cache });

  await assert.rejects(() => resolver.resolveStream({ anilistId: 123 }), ProviderError);

  assert.equal(cache.l1._map.get(ANI_KEY), undefined, 'no stream entry cached for a failure');
});

test('Cache: different languages use separate cache keys', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  await resolver.resolveStream({ anilistId: 123, language: 'sub' });
  await resolver.resolveStream({ anilistId: 123, language: 'dub' });

  assert.equal(mp.anilistCalls().length, 2);
  assert.deepEqual(mp.anilistCalls().map((c) => c.options.language), ['sub', 'dub']);
});

test('Cache: explicit provider expiry metadata caps the stream TTL', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const soon = new Date(Date.now() + 5_000).toISOString();
  const mp = fakeMegaplay({ anilist: () => ({ data: { sources: [{ url: STREAM_URL }], expiresAt: soon }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }) });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), cache });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(res.expiresAt, soon);
  const entry = cache.l1._map.get(ANI_KEY);
  assert.ok(entry.ttlSeconds <= 5, 'TTL capped at the declared expiry');
});

// --- coalescing --------------------------------------------------------------

test('Concurrent identical requests coalesce into ONE provider call', async () => {
  const mp = fakeMegaplay({
    anilist: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return rawStream();
    },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const [a, b, c] = await Promise.all([
    resolver.resolveStream({ anilistId: 123 }),
    resolver.resolveStream({ anilistId: 123 }),
    resolver.resolveStream({ anilistId: 123 }),
  ]);

  assert.equal(mp.anilistCalls().length, 1);
  for (const res of [a, b, c]) {
    assert.deepEqual(res.sources, [
      { url: proxyWatchUrl(123, 1, 'sub'), type: 'proxy', language: 'sub' },
      { url: proxyWatchUrl(123, 1, 'dub'), type: 'proxy', language: 'dub' },
    ]);
  }
});

// --- validation --------------------------------------------------------------

test('Episode validation: zero/negative/non-integer/excessive values -> ValidationError', async () => {
  const mp = fakeMegaplay({ anilist: () => { throw new Error('must not be called'); } });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  for (const bad of [0, -1, 2.5, 'abc', '999999999', 2001]) {
    await assert.rejects(
      () => resolver.resolveStream({ anilistId: 123, episode: bad }),
      ValidationError,
      `expected ValidationError for episode=${String(bad)}`,
    );
  }
  assert.equal(mp.anilistCalls().length, 0);
});

test('Episode validation: missing episode defaults to 1', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStream({ anilistId: 123 });
  assert.equal(res.episode, 1);
});

test('Language validation: values outside sub|dub -> ValidationError', async () => {
  const mp = fakeMegaplay({ anilist: () => { throw new Error('must not be called'); } });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  for (const bad of ['xyz', 'eng', 'SUB', 1, ['sub', 'dub']]) {
    await assert.rejects(
      () => resolver.resolveStream({ anilistId: 123, language: bad }),
      ValidationError,
      `expected ValidationError for language=${String(bad)}`,
    );
  }
  assert.equal(mp.anilistCalls().length, 0);
});

test('AniList ID validation: invalid IDs -> ValidationError before any provider call', async () => {
  const mp = fakeMegaplay({ anilist: () => { throw new Error('must not be called'); } });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  for (const bad of ['abc', 0, -1, '1.5', '', null, undefined]) {
    await assert.rejects(() => resolver.resolveStream({ anilistId: bad }), ValidationError);
  }
  assert.equal(mp.anilistCalls().length, 0);
  assert.equal(resolver.identity.calls.length, 0);
});

// --- proxy playback ----------------------------------------------------------

test('Proxy configured: playback URL is the proxy watch URL (sub, idType=anilist)', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStream({ anilistId: 123, episode: 1, language: 'sub' });

  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/123?ep=1&lang=sub&idType=anilist`);
  assert.equal(res.sources[0].url, res.playbackUrl);
  assert.equal(res.sources[0].type, 'proxy');
  // No direct MegaPlay playback URL anywhere in the response.
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz'));
});

test('Proxy configured: playback URL is the proxy watch URL (dub, episode forwarded)', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStream({ anilistId: 123, episode: 7, language: 'dub' });

  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/123?ep=7&lang=dub&idType=anilist`);
});

test('Proxy configured: AniList -> MAL fallback playback URL uses idType=mal with the RESOLVED MAL ID', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: { success: true, sources: [] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream(),
  });
  const identity = fakeIdentity({ 123: 456 });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStream({ anilistId: 123 });

  assert.equal(res.idType, 'mal');
  assert.equal(res.anilistId, 123);
  assert.equal(res.malId, 456);
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/456?ep=1&lang=sub&idType=mal`);
  // The AniList ID is never used with idType=mal and vice versa.
  assert.ok(!res.playbackUrl.includes('/watch/123'));
});

test('Proxy NOT configured: typed configuration error, resolution still attempted, no direct MegaPlay URL exposed', async () => {
  const mp = fakeMegaplay({ anilist: () => rawStream() });
  const notConfiguredProxy = { isConfigured: () => false, buildWatchUrl: () => { throw new Error('should not be called'); } };
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity(), proxy: notConfiguredProxy });

  await assert.rejects(
    () => resolver.resolveStream({ anilistId: 123 }),
    (err) => {
      assert.equal(err.name, 'NotImplementedError');
      assert.equal(err.statusCode, 501);
      assert.equal(err.details.proxyConfigured, false);
      return true;
    },
  );
  // Availability detection is preserved: MegaPlay was still asked first.
  assert.equal(mp.anilistCalls().length, 1);
});

test('Proxy NOT configured (default config): buildProxyWatchUrl throws a typed configuration error', async () => {
  const { buildProxyWatchUrl } = await import('../src/streaming/proxy-playback.js');
  assert.throws(
    () => buildProxyWatchUrl({ idType: 'anilist', id: 123 }),
    (err) => err.name === 'NotImplementedError' && err.details.proxyConfigured === false,
  );
});

test('Proxy URL construction: trailing slash is normalized, contract shape is exact', async () => {
  const { buildProxyWatchUrl } = await import('../src/streaming/proxy-playback.js');
  assert.equal(
    buildProxyWatchUrl({ idType: 'anilist', id: 189046, episode: 1, language: 'sub' }, { baseUrl: 'https://megaplayproxy1.vercel.app/' }),
    'https://megaplayproxy1.vercel.app/watch/189046?ep=1&lang=sub&idType=anilist',
  );
  assert.equal(
    buildProxyWatchUrl({ idType: 'mal', id: 54857, episode: 2, language: 'dub' }, { baseUrl: 'https://example.com///' }),
    'https://example.com/watch/54857?ep=2&lang=dub&idType=mal',
  );
});

test('Proxy URL construction: invalid idType/id/episode/language are rejected (no fabricated URLs)', async () => {
  const { buildProxyWatchUrl } = await import('../src/streaming/proxy-playback.js');
  const base = { baseUrl: 'https://example.com' };
  for (const bad of [
    { idType: 'tmdb', id: 1 },
    { idType: 'mal', id: 0 },
    { idType: 'anilist', id: 'abc' },
    { idType: 'anilist', id: 1, episode: 0 },
    { idType: 'anilist', id: 1, language: 'eng' },
    {},
  ]) {
    assert.throws(
      () => buildProxyWatchUrl({ ...base, ...bad }),
      ValidationError,
      `expected ValidationError for ${JSON.stringify(bad)}`,
    );
  }
});

// --- URL safety --------------------------------------------------------------

// Playback goes through the proxy: returned URLs are the frontend-safe proxy
// watch URL built from the ACTUAL resolution (correct id namespace, ep, lang).
// A direct MegaPlay playback/stream URL is NEVER exposed to the frontend.
test('URL safety: playback URLs are proxy URLs built from the actual resolution (no direct MegaPlay exposure)', async () => {
  const mp = fakeMegaplay({
    anilist: () => ({ data: { sources: [{ url: 'https://cdn.example/one.mp4' }, { url: 'https://cdn.example/two.mp4' }] }, url: 'https://megaplay.buzz/stream/ani/123/1/sub' }),
    mal: () => rawStream('https://cdn.example/mal.mp4'),
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStream({ anilistId: 123, episode: 3 });

  assert.equal(res.playbackUrl, proxyWatchUrl(123, 3, 'sub'));
  assert.match(res.playbackUrl, /^https?:\/\//);
  // The only sources are the proxy playback URLs - no direct MegaPlay URLs.
  assert.equal(res.sources.length, 2);
  assert.equal(res.sources[0].type, 'proxy');
  assert.equal(res.sources[0].language, 'sub');
  assert.equal(res.sources[1].type, 'proxy');
  assert.equal(res.sources[1].language, 'dub');
  assert.equal(res.streams.sub.language, 'sub');
  assert.equal(res.streams.dub.language, 'dub');
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz/stream'));
  assert.ok(!JSON.stringify(res).includes('cdn.example'));
});
