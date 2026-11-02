/**
 * Phase: dual-server streaming tests - StreamResolver MAL-PRIMARY resolution
 * (GET /api/stream/resolve/mal/:id) plus AniList-primary parity of the new
 * named entry point.
 *
 * Covered: MAL endpoint attempted FIRST via resolveByMalId, AniList NOT called
 * on MAL success, genuine no-stream triggers resolveMalToAniList (the
 * CORRECT direction), AniList endpoint then called with the RESOLVED AniList
 * ID, namespace safety in both directions (never an ID swap / numeric
 * equality assumption), both providers no-stream -> PRIMARY (MAL) proxy URL
 * stands, unresolved mapping / identity NotFoundError handled gracefully,
 * typed provider failures (timeout/429/500/network), validation, cache key
 * namespace isolation, AniList-primary method parity. Fully mocked - no live
 * MegaPlay/AniList.
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
  NotFoundError,
} from '../src/errors/index.js';

const ANILIST_ID = 123;
const MAL_ID = 456;
const ANI_KEY = `stream:megaplay:anilist:${ANILIST_ID}:episode:1:language:sub`;
const MAL_KEY = `stream:megaplay:mal:${MAL_ID}:episode:1:language:sub`;
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

/** Valid raw MegaPlay payload (as the provider would return). */
function rawStream(url = STREAM_URL, urlUsed = `https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`) {
  return { data: { success: true, sources: [{ url, quality: '1080p' }] }, url: urlUsed };
}

/** Raw genuine no-stream payload (distinguishable from a failure). */
function rawNoStream(urlUsed = `https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`) {
  return { data: { success: true, sources: [] }, url: urlUsed };
}

/** Fake MegaPlay provider recording both id-kind lookups separately. Handlers
 * are read from `this` at call time so tests can reassign them mid-test. */
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

/**
 * Fake IdentityResolver with BOTH directions AND separately recorded calls
 * (a namespace swap or wrong direction would show up in the call records).
 * @param {{ anilistToMal?: Record<number, number|null>, malToAnilist?: Record<number, number> }} [mapping]
 */
function fakeIdentity({ anilistToMal = {}, malToAnilist = {} } = {}) {
  const aniToMalCalls = [];
  const malToAniCalls = [];
  return {
    anilistToMalCalls: () => aniToMalCalls,
    malToAnilistCalls: () => malToAniCalls,
    calls: aniToMalCalls, // alias (anilist-direction focus), for parity asserts
    async resolveAniListToMal(anilistId) {
      aniToMalCalls.push(anilistId);
      return createIdentityResult({ anilistId, malId: anilistToMal[anilistId] ?? null });
    },
    async resolveMalToAniList(malId) {
      malToAniCalls.push(malId);
      return createIdentityResult({ anilistId: malToAnilist[malId] ?? null, malId });
    },
  };
}

/** A resolver with a fresh L1-only cache (L2 unconfigured, like a cold start). */
function makeResolver({ megaplay, identity, cache, proxy = fakeProxy() } = {}) {
  return new StreamResolver({
    megaplay,
    identity,
    cache: cache ?? new CacheManager({ l1: new MemoryStore() }),
    proxy,
  });
}

// --- MAL-primary -------------------------------------------------------------

test('MAL-first: the MAL endpoint is attempted FIRST (resolveByMalId) and the AniList endpoint is NOT called on success', async () => {
  const mp = fakeMegaplay({ mal: () => rawStream(`https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`, STREAM_URL) });
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(mp.malCalls().length, 1);
  assert.equal(mp.malCalls()[0].id, MAL_ID); // the MAL ID was used - never anilistId
  assert.equal(mp.anilistCalls().length, 0); // no AniList lookup, no identity needed
  assert.equal(identity.malToAnilistCalls().length, 0);
  assert.equal(identity.anilistToMalCalls().length, 0);

  assert.deepEqual(res, {
    resolved: true,
    provider: 'megaplay',
    idType: 'mal',
    anilistId: null, // honest: identity was not needed - never guessed
    malId: MAL_ID, // mirrors the requested MAL ID
    episode: 1,
    language: 'sub',
    playbackUrl: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`,
    streams: {
      sub: { url: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`, type: 'proxy', language: 'sub' },
      dub: { url: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=dub&idType=mal`, type: 'proxy', language: 'dub' },
    },
    sources: [
      { url: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`, type: 'proxy', language: 'sub' },
      { url: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=dub&idType=mal`, type: 'proxy', language: 'dub' },
    ],
    expiresAt: null,
  });
  // Direct MegaPlay playback URLs are NEVER exposed to the frontend.
  assert.ok(!JSON.stringify(res).includes(STREAM_URL));
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz'));
});

test('MAL-first: episode/language are forwarded to the provider call', async () => {
  const mp = fakeMegaplay({ mal: () => rawStream('https://cdn.example/dub.mp4', `https://megaplay.buzz/stream/mal/${MAL_ID}/2/dub`) });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID, episode: 2, language: 'dub' });

  assert.deepEqual(mp.malCalls()[0], { kind: 'mal', id: MAL_ID, options: { episode: 2, language: 'dub' } });
  assert.equal(res.episode, 2);
  assert.equal(res.language, 'dub');
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${MAL_ID}?ep=2&lang=dub&idType=mal`);
  assert.ok(!JSON.stringify(res).includes('https://cdn.example/dub.mp4'));
});

// --- MAL -> AniList fallback -------------------------------------------------

// Live-realistic baseline: MegaPlay serves a missing stream as HTTP 200 + an
// HTML "Error - MegaPlay" page carrying "Error Code: 410" - a genuine no-stream
// result, the ALIASED no-stream trigger for the cross-namespace fallback.
const MEGAPLAY_ERROR_PAGE =
  '<!DOCTYPE html><html lang="en"><head><title>Error - MegaPlay</title></head>' +
  '<body><div class="error-container">We can\'t find the file you are looking for.' +
  'Error Code: 410</div></body></html>';

test('MAL->AniList fallback: genuine MAL no-stream -> IdentityResolver (resolveMalToAniList) -> AniList endpoint with the RESOLVED ANILIST ID', async () => {
  const mp = fakeMegaplay({
    mal: () => ({ data: { success: true, sources: [] }, url: `https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub` }),
    anilist: () => rawStream(`https://fallback-cdn.example/anilist.mp4`, `https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub`),
  });
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(mp.malCalls().length, 1); // MAL attempted first
  assert.equal(mp.malCalls()[0].id, MAL_ID);
  assert.equal(identity.malToAnilistCalls().length, 1); // the CORRECT direction
  assert.deepEqual(identity.malToAnilistCalls(), [MAL_ID]);
  assert.equal(identity.anilistToMalCalls().length, 0); // never the wrong direction
  assert.equal(mp.anilistCalls().length, 1);
  assert.equal(mp.anilistCalls()[0].id, ANILIST_ID); // the RESOLVED AniList ID - never malId

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'anilist'); // the winning namespace
  assert.equal(res.malId, MAL_ID); // the requested MAL ID stays the mal metadata
  assert.equal(res.anilistId, ANILIST_ID); // from actual identity resolution only
  // Playback uses the RESOLVED ANILIST ID with idType=anilist - never malId.
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=1&lang=sub&idType=anilist`);
  assert.ok(!JSON.stringify(res).includes('celerybuffer.com'));
  assert.deepEqual(res.sources, [
    { url: `${PROXY_BASE}/watch/${ANILIST_ID}?ep=1&lang=sub&idType=anilist`, type: 'proxy', language: 'sub' },
    { url: `${PROXY_BASE}/watch/${ANILIST_ID}?ep=1&lang=dub&idType=anilist`, type: 'proxy', language: 'dub' },
  ]);
});

test('MAL->AniList fallback: MegaPlay HTTP 200 HTML error page (Error Code 410) on the MAL endpoint also triggers the fallback', async () => {
  const mp = fakeMegaplay({
    mal: () => ({ data: MEGAPLAY_ERROR_PAGE, url: `https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub` }),
    anilist: () => rawStream(`https://fallback-cdn.example/anilist.mp4`, `https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub`),
  });
  // Distinct ids across the mapping prove numeric equality is never assumed.
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID, episode: 1, language: 'sub' });

  assert.equal(mp.malCalls().length, 1);
  assert.equal(mp.malCalls()[0].id, MAL_ID);
  assert.equal(identity.malToAnilistCalls().length, 1);
  assert.equal(mp.anilistCalls()[0].id, ANILIST_ID);
  assert.equal(res.idType, 'anilist');
  assert.equal(res.anilistId, ANILIST_ID);
  assert.equal(res.malId, MAL_ID);
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=1&lang=sub&idType=anilist`);
});

test('MAL->AniList fallback: MegaPlay upstreamStatus 404 on the MAL endpoint also triggers the fallback', async () => {
  const mp = fakeMegaplay({
    mal: () => { throw new ProviderError('megaplay responded with HTTP 404', { provider: 'megaplay', details: { upstreamStatus: 404 } }); },
    anilist: () => rawStream(`https://fallback-cdn.example/anilist.mp4`, `https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub`),
  });
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'anilist');
  assert.equal(mp.anilistCalls()[0].id, ANILIST_ID);
});

test('Both providers no-stream: PRIMARY (MAL) proxy playback URL stands (identity mapping rides along as metadata only)', async () => {
  const mp = fakeMegaplay({
    mal: () => ({ data: MEGAPLAY_ERROR_PAGE, url: `https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub` }),
    anilist: () => ({ data: MEGAPLAY_ERROR_PAGE, url: `https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub` }),
  });
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(mp.malCalls().length, 1); // primary attempted first
  assert.equal(identity.malToAnilistCalls().length, 1); // then the mapping
  assert.equal(mp.anilistCalls().length, 1); // then the fallback
  assert.equal(mp.anilistCalls()[0].id, ANILIST_ID); // with the RESOLVED id

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal'); // PRIMARY (MAL) namespace stands
  assert.equal(res.malId, MAL_ID); // mirrors the requested MAL ID
  assert.equal(res.anilistId, ANILIST_ID); // AniList-confirmed mapping, metadata only
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`);
  assert.deepEqual(res.sources, [
    { url: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`, type: 'proxy', language: 'sub' },
    { url: `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=dub&idType=mal`, type: 'proxy', language: 'dub' },
  ]);
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz'));
});

test('Unresolved identity: PRIMARY (MAL) proxy playback URL, AniList endpoint never attempted', async () => {
  const mp = fakeMegaplay({
    mal: () => rawNoStream(),
    anilist: () => { throw new Error('AniList endpoint must NOT be attempted without a mapping'); },
  });
  const identity = fakeIdentity({ malToAnilist: {} }); // no mapping for MAL_ID
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal'); // PRIMARY (MAL) namespace stands
  assert.equal(res.malId, MAL_ID);
  assert.equal(res.anilistId, null); // unresolved identity - never guessed
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`);

  assert.equal(mp.malCalls().length, 1);
  assert.equal(mp.anilistCalls().length, 0); // no AniList fallback without a mapping
  assert.equal(identity.malToAnilistCalls().length, 1); // identity WAS consulted
});

// Live-realistic regression (MAL ID 21 / One Piece style numeric equality):
// anilistIds and malIds can be the SAME NUMBER without being the same concept.
// Both direct MegaPlay lookups return the Error-410 page; the resolver must
// return the PRIMARY (mal) proxy playback URL and never confuse namespaces.
test('Numeric equality trap: MAL 21 with an AniList 21 mapping still resolves strictly in its own namespace (ID 21 regression)', async () => {
  const mp = fakeMegaplay({
    mal: () => ({ data: MEGAPLAY_ERROR_PAGE, url: 'https://megaplay.buzz/stream/mal/21/1/sub' }),
    anilist: () => ({ data: MEGAPLAY_ERROR_PAGE, url: 'https://megaplay.buzz/stream/ani/21/1/sub' }),
  });
  const identity = fakeIdentity({ malToAnilist: { 21: 21 } }); // AniList-confirmed
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: 21 });

  assert.equal(mp.malCalls()[0].id, 21); // the requested MAL ID
  assert.equal(mp.anilistCalls()[0].id, 21); // the RESOLVED AniList ID (mapping, not equality)
  assert.equal(res.idType, 'mal'); // PRIMARY (mal) namespace stands
  assert.equal(res.malId, 21);
  assert.equal(res.anilistId, 21); // provider-confirmed mapping, metadata only
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/21?ep=1&lang=sub&idType=mal`);
  assert.ok(!JSON.stringify(res).includes('megaplay.buzz'));
});

// --- identity failure semantics ----------------------------------------------

test('Identity NotFoundError (no AniList Media for the MAL ID) is a MISSING MAPPING: graceful, AniList endpoint never attempted, no 404', async () => {
  const mp = fakeMegaplay({
    mal: () => rawNoStream(),
    anilist: () => { throw new Error('AniList endpoint must NOT be attempted without a mapping'); },
  });
  const identity = {
    anilistToMalCalls: () => [],
    malToAnilistCalls: () => [MAL_ID],
    calls: [],
    async resolveAniListToMal() { throw new Error('unexpected anilist direction'); },
    async resolveMalToAniList() { throw new NotFoundError('AniList media not found', { provider: 'anilist' }); },
  };
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(res.resolved, true); // NOT a request-level not-found
  assert.equal(res.idType, 'mal'); // PRIMARY (MAL) namespace stands
  assert.equal(res.malId, MAL_ID);
  assert.equal(res.anilistId, null);
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`);
  assert.equal(mp.anilistCalls().length, 0); // fallback skipped, not attempted
});

test('Identity infrastructure failure (timeout) propagates as a typed TimeoutError (never treated as unresolved, fallback never attempted)', async () => {
  const mp = fakeMegaplay({
    mal: () => rawNoStream(),
    anilist: () => { throw new Error('must not be called'); },
  });
  const identity = {
    anilistToMalCalls: () => [],
    malToAnilistCalls: () => [MAL_ID],
    calls: [],
    async resolveAniListToMal() { throw new Error('unexpected anilist direction'); },
    async resolveMalToAniList() { throw new TimeoutError('anilist request timed out', { provider: 'anilist' }); },
  };
  const resolver = makeResolver({ megaplay: mp, identity });

  await assert.rejects(() => resolver.resolveStreamByMalId({ malId: MAL_ID }), TimeoutError);
  assert.equal(mp.anilistCalls().length, 0);
});

// --- provider failure classification -----------------------------------------

test('Provider failures: timeout on the MAL lookup stays a typed TimeoutError (identity never consulted)', async () => {
  const mp = fakeMegaplay({
    mal: () => { throw new TimeoutError('megaplay request timed out', { provider: 'megaplay' }); },
  });
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  await assert.rejects(() => resolver.resolveStreamByMalId({ malId: MAL_ID }), TimeoutError);
  assert.equal(identity.malToAnilistCalls().length, 0); // an outage is NOT no-stream
  assert.equal(mp.anilistCalls().length, 0);
});

test('Provider failures: 429 on the MAL lookup stays a typed RateLimitError', async () => {
  const mp = fakeMegaplay({
    mal: () => { throw new RateLimitError('megaplay rate limited', { provider: 'megaplay' }); },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  await assert.rejects(() => resolver.resolveStreamByMalId({ malId: MAL_ID }), RateLimitError);
  assert.equal(mp.anilistCalls().length, 0);
});

test('Provider failures: upstream 500 on the MAL lookup stays a typed ProviderError (not reinterpreted as no-stream)', async () => {
  const mp = fakeMegaplay({
    mal: () => { throw new ProviderError('megaplay responded with HTTP 500', { provider: 'megaplay', details: { upstreamStatus: 500 } }); },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } }) });

  await assert.rejects(() => resolver.resolveStreamByMalId({ malId: MAL_ID }), ProviderError);
  assert.equal(mp.anilistCalls().length, 0);
});

test('Provider failures: AniList fallback timeout propagates as a typed TimeoutError (no fabricated stream)', async () => {
  const mp = fakeMegaplay({
    mal: () => rawNoStream(),
    anilist: () => { throw new TimeoutError('megaplay request timed out', { provider: 'megaplay' }); },
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } }) });

  await assert.rejects(() => resolver.resolveStreamByMalId({ malId: MAL_ID }), TimeoutError);
});

// --- namespace safety --------------------------------------------------------

test('Namespace safety: MAL IDs are never passed to the AniList endpoint and AniList IDs never to the MAL endpoint', async () => {
  const mp = fakeMegaplay({
    mal: (_id, options) =>
      options?.episode === 1
        ? rawStream(undefined, `https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`)
        : rawNoStream(`https://megaplay.buzz/stream/mal/${MAL_ID}/999/sub`),
    anilist: () => rawStream(`https://fallback-cdn.example/anilist.mp4`, `https://megaplay.buzz/stream/ani/${ANILIST_ID}/9/sub`),
  });
  const identity = fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const direct = await resolver.resolveStreamByMalId({ malId: MAL_ID }); // ep 1: MAL stream wins
  assert.equal(direct.idType, 'mal');
  assert.equal(direct.anilistId, null);

  const fallback = await resolver.resolveStreamByMalId({ malId: MAL_ID, episode: 999 }); // fresh episode: fresh lookups
  assert.equal(fallback.idType, 'anilist');
  assert.equal(fallback.malId, MAL_ID);

  assert.ok(mp.malCalls().length >= 1);
  for (const call of mp.malCalls()) {
    assert.notEqual(call.id, ANILIST_ID); // the AniList ID is never passed to MAL
  }
  for (const call of mp.anilistCalls()) {
    assert.notEqual(call.id, MAL_ID); // the MAL ID is never passed to AniList
  }
  // Identity direction: only resolveMalToAniList was ever used on this flow.
  assert.deepEqual(identity.anilistToMalCalls(), []);
  assert.ok(identity.malToAnilistCalls().every((called) => called === MAL_ID));
});

// --- caching -----------------------------------------------------------------

test('Cache: MAL-primary fallback resolutions are cached under SEPARATE namespace keys (no collision)', async () => {
  const cache = new CacheManager({ l1: new MemoryStore() });
  const mp = fakeMegaplay({
    mal: () => rawNoStream(),
    anilist: () => rawStream(`https://fallback-cdn.example/anilist.mp4`, `https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub`),
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity({ malToAnilist: { [MAL_ID]: ANILIST_ID } }), cache });

  await resolver.resolveStreamByMalId({ malId: MAL_ID });

  const malEntry = cache.l1._map.get(MAL_KEY);
  const aniEntry = cache.l1._map.get(ANI_KEY);
  assert.ok(malEntry, 'expected the mal no-stream marker under the MAL key');
  assert.ok(aniEntry, 'expected the anilist stream under the AniList key');
  assert.equal(malEntry.value.usable, false); // no-stream marker, distinguishable
  assert.equal(aniEntry.value.usable, true);
  assert.notEqual(MAL_KEY, ANI_KEY);
});

test('Cache: second MAL-primary resolve is served from the cache (no duplicate provider requests)', async () => {
  const mp = fakeMegaplay({
    mal: () => rawStream(`https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`, STREAM_URL),
  });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const first = await resolver.resolveStreamByMalId({ malId: MAL_ID });
  const second = await resolver.resolveStreamByMalId({ malId: MAL_ID });

  assert.equal(mp.malCalls().length, 1); // second resolve served from cache
  assert.deepEqual(first.sources, second.sources);
});

// --- validation --------------------------------------------------------------

test('MAL ID validation: invalid IDs -> ValidationError before any provider call', async () => {
  const mp = fakeMegaplay({ mal: () => { throw new Error('must not be called'); } });
  const identity = fakeIdentity();
  const resolver = makeResolver({ megaplay: mp, identity });

  for (const bad of ['abc', 0, -1, '1.5', '', null, undefined]) {
    await assert.rejects(
      () => resolver.resolveStreamByMalId({ malId: bad }),
      ValidationError,
      `expected ValidationError for malId=${String(bad)}`,
    );
  }
  assert.equal(mp.malCalls().length, 0);
  assert.equal(mp.anilistCalls().length, 0);
  assert.equal(identity.malToAnilistCalls().length, 0);
});

test('Episode/language validation on the MAL flow: invalid values -> ValidationError before any provider call', async () => {
  const mp = fakeMegaplay({ mal: () => { throw new Error('must not be called'); } });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  for (const bad of [0, -1, 2.5, 'abc', '999999999']) {
    await assert.rejects(
      () => resolver.resolveStreamByMalId({ malId: MAL_ID, episode: bad }),
      ValidationError,
      `expected ValidationError for episode=${String(bad)}`,
    );
  }
  for (const bad of ['xyz', 'eng', 'SUB', ['sub', 'dub']]) {
    await assert.rejects(
      () => resolver.resolveStreamByMalId({ malId: MAL_ID, language: bad }),
      ValidationError,
      `expected ValidationError for language=${String(bad)}`,
    );
  }
  assert.equal(mp.malCalls().length, 0);
});

test('Missing episode defaults to 1 and missing language to sub on the MAL flow', async () => {
  const mp = fakeMegaplay({ mal: () => rawStream(`https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`, STREAM_URL) });
  const resolver = makeResolver({ megaplay: mp, identity: fakeIdentity() });

  const res = await resolver.resolveStreamByMalId({ malId: MAL_ID });
  assert.equal(res.episode, 1);
  assert.equal(res.language, 'sub');
});

// --- AniList-primary parity of the named method ------------------------------

test('resolveStreamByAniListId parity: AniList endpoint first, success -> idType=anilist (same behavior as resolveStream)', async () => {
  const mp = fakeMegaplay({
    anilist: () => rawStream('https://fallback-cdn.example/anilist.mp4', `https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub`),
  });
  const identity = fakeIdentity({ anilistToMal: { [ANILIST_ID]: MAL_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByAniListId({ anilistId: ANILIST_ID });

  assert.equal(mp.anilistCalls().length, 1);
  assert.equal(mp.anilistCalls()[0].id, ANILIST_ID);
  assert.equal(mp.malCalls().length, 0); // no MAL lookup on AniList success
  assert.equal(identity.anilistToMalCalls().length, 0);
  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'anilist');
  assert.equal(res.anilistId, ANILIST_ID);
  assert.equal(res.malId, null);
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=1&lang=sub&idType=anilist`);
  assert.ok(!JSON.stringify(res).includes('celerybuffer.com'));
});

test('resolveStreamByAniListId parity: no-stream -> resolveAniListToMal -> MAL endpoint with the RESOLVED MAL ID', async () => {
  const mp = fakeMegaplay({
    anilist: () => rawNoStream(`https://megaplay.buzz/stream/ani/${ANILIST_ID}/1/sub`),
    mal: () => rawStream(`https://megaplay.buzz/stream/mal/${MAL_ID}/1/sub`, STREAM_URL),
  });
  const identity = fakeIdentity({ anilistToMal: { [ANILIST_ID]: MAL_ID } });
  const resolver = makeResolver({ megaplay: mp, identity });

  const res = await resolver.resolveStreamByAniListId({ anilistId: ANILIST_ID });

  assert.deepEqual(identity.anilistToMalCalls(), [ANILIST_ID]); // the CORRECT direction
  assert.equal(identity.malToAnilistCalls().length, 0); // never the reverse direction
  assert.equal(mp.malCalls().length, 1);
  assert.equal(mp.malCalls()[0].id, MAL_ID); // the RESOLVED MAL ID - never anilistId

  assert.equal(res.resolved, true);
  assert.equal(res.idType, 'mal');
  assert.equal(res.anilistId, ANILIST_ID); // the requested AniList ID stays the canonical metadata
  assert.equal(res.malId, MAL_ID); // from actual identity resolution only
  assert.equal(res.playbackUrl, `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`);
});
