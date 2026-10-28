/**
 * AniZip DEFAULT-provider endpoint tests for GET /api/episodes/:id.
 *
 * The AniZip provider is requested DIRECTLY with the public route's AniList
 * ID (never a MAL conversion). The response contract stays backward
 * compatible: id, anilistId, malId, totalEpisodes, pageInfo, episodes (+ the
 * new per-episode thumbnail/image fields); `episode` keeps the REAL AniZip
 * episode number (gaps preserved, never renumbered) so it stays compatible
 * with GET /api/stream/resolve/:id?ep=N.
 *
 * Covered (real Express app, mocked fetch, no live providers): real-shaped
 * mappings normalization, numeric sorting + gaps, thumbnails, null for
 * missing optional fields, malformed data never cached as success, invalid
 * AniList IDs -> 400, cache hits, concurrent coalescing, stale-if-error,
 * typed error with no cache, episode-7 streaming compatibility, and existing
 * frontend field compatibility.
 */

// Env setup MUST be the first import (ESM evaluates imports depth-first in
// order, so this runs before config/env.js loads).
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  expireL1Entry,
  anilistMedia,
  anizipMappings,
  anizipEpisode,
  anizipNotFound,
} from './helpers/test-server.js';
import { cacheManager } from '../src/cache/cache-manager.js';

const ANILIST_ID = 123;
const MAL_ID = 456;
const ANIZIP_KEY = `anizip:episodes:v2:anilist:${ANILIST_ID}`;
const COMPOSITE_KEY = `episodes:anilist:${ANILIST_ID}:page:1`;

/** @param {string} query */
function anilistKind(query) {
  if (query.includes('airingSchedule')) return 'schedule';
  if (query.includes('recommendations')) return 'recommendations';
  if (query.includes('relations')) return 'relations';
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  if (query.includes('$idMal')) return 'byMal';
  return 'byId';
}

/** AniList mock serving the canonical Media for the byId query (identity only). */
function anilistHandler(mapping = { [ANILIST_ID]: MAL_ID }) {
  return (body) => {
    if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
    const id = Number(body.variables?.id);
    if (!(id in mapping)) throw new Error(`unexpected AniList id requested: ${id}`);
    return { data: { Media: anilistMedia({ id, idMal: mapping[id] }) } };
  };
}

/** Full details pipeline mock: Jikan /anime/{malId}/full (canonical details). */
function jikanFullHandler() {
  return (url) => {
    if (url.includes(`/anime/${MAL_ID}/full`)) return { data: { mal_id: MAL_ID, title: 'Test Anime' } };
    throw new Error(`unexpected Jikan path: ${url}`);
  };
}

/** Mappings fixture shaped exactly like the live api.ani.zip response. */
function liveShapedMappings() {
  return anizipMappings({
    anilistId: ANILIST_ID,
    malId: MAL_ID,
    specialCount: 2,
    episodes: {
      '1': anizipEpisode({
        episode: 1,
        title: 'Enter: Naruto Uzumaki!',
        titleJa: '参上! うずまきナルト',
        image: 'https://artworks.thetvdb.com/banners/episodes/78857/296975.jpg',
        overview: 'Welcome to the Village Hidden in the Leaves...',
        airDate: '2002-10-03',
        runtime: 25,
        rating: '6.00',
      }),
      '2': anizipEpisode({
        episode: 2,
        title: 'My Name is Konohamaru!',
        image: 'https://artworks.thetvdb.com/banners/episodes/78857/296976.jpg',
        airDate: '2002-10-10',
      }),
      S1: anizipEpisode({ episode: 1, title: 'Special 1' }),
      S2: anizipEpisode({ episode: 2, title: 'Special 2' }),
    },
  });
}

/** Standard mock set: AniZip serves the live-shaped mappings. */
function anizipPrimaryMocks({ mappings = liveShapedMappings() } = {}) {
  return {
    anilist: anilistHandler(),
    jikan: jikanFullHandler(),
    anizip: () => ({ status: 200, json: mappings }),
  };
}

async function withServer(mocks, run) {
  await resetL1Cache();
  const mock = installApiMocks(mocks);
  const server = await startTestServer();
  try {
    await run(server, mock);
  } finally {
    await server.stop();
    mock.restore();
    await resetL1Cache();
  }
}

test('AniZip is the DEFAULT source: a real-shaped mappings response normalizes correctly', async () => {
  await withServer(anizipPrimaryMocks(), async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.source, 'anizip');
    assert.equal(body.id, ANILIST_ID);
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, MAL_ID);
    assert.equal(body.totalEpisodes, 2); // specials excluded from the count
    assert.equal(body.pageInfo, null); // AniZip episode data is not paginated

    // The provider was asked DIRECTLY with the AniList ID (never a MAL id).
    assert.deepEqual(mock.anizipCalls(), [`https://api.ani.zip/mappings?anilist_id=${ANILIST_ID}`]);
    // No MegaPlay anywhere: AniZip is episode METADATA, not streaming.
    assert.equal(mock.megaplayCalls().length, 0);
  });
});

test('episode numbers remain correct and sorted numerically; gaps preserved (never renumbered)', async () => {
  const mappings = anizipMappings({
    anilistId: ANILIST_ID,
    malId: MAL_ID,
    episodes: {
      '7': anizipEpisode({ episode: 7, title: 'Episode 7' }),
      '1': anizipEpisode({ episode: 1, title: 'Episode 1' }),
      '2': anizipEpisode({ episode: 2, title: 'Episode 2' }),
    },
  });
  await withServer(anizipPrimaryMocks({ mappings }), async (server) => {
    const body = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
    assert.deepEqual(
      body.episodes.map((e) => e.episode),
      [1, 2, 7],
    );
    assert.equal(body.totalEpisodes, 3); // real count; the 3..6 gap is preserved
    assert.ok(!body.episodes.some((e) => e.episode === 3)); // never renumbered
  });
});

test('thumbnail URLs are preserved exactly as returned by AniZip', async () => {
  await withServer(anizipPrimaryMocks(), async (server) => {
    const body = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
    assert.equal(body.episodes[0].image, 'https://artworks.thetvdb.com/banners/episodes/78857/296975.jpg');
    assert.equal(body.episodes[1].image, 'https://artworks.thetvdb.com/banners/episodes/78857/296976.jpg');
  });
});

test('missing optional fields become null (never fabricated)', async () => {
  const mappings = anizipMappings({
    anilistId: ANILIST_ID,
    malId: MAL_ID,
    episodes: {
      '1': anizipEpisode({ episode: 1, titleJa: null, image: null, overview: null, airDate: null, runtime: null, rating: null }),
    },
  });
  await withServer(anizipPrimaryMocks({ mappings }), async (server) => {
    const body = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
    const ep = body.episodes[0];
    for (const field of ['titleJapanese', 'image', 'overview', 'aired', 'airDateUtc', 'runtime', 'score', 'filler', 'recap']) {
      assert.equal(ep[field], null, `expected ${field} to be null`);
    }
    assert.equal(ep.episode, 1); // the number itself is still real
  });
});

test('a VALID AniZip response with no normal episodes is "cannot provide" -> Jikan fallback (never cached as AniZip data)', async () => {
  await withServer(
    {
      ...anizipPrimaryMocks({ mappings: anizipMappings({ anilistId: ANILIST_ID, malId: MAL_ID, episodes: {} }) }),
      jikan: (url) => {
        if (url.includes(`/anime/${MAL_ID}/full`)) return { data: { mal_id: MAL_ID, title: 'Test Anime' } };
        if (url.includes(`/anime/${MAL_ID}/episodes`)) {
          return { status: 200, json: { pagination: { current_page: 1, has_next_page: false, items: { count: 1, total: 1, per_page: 100 } }, data: [{ mal_id: 1, title: 'Episode 1' }] } };
        }
        throw new Error(`unexpected Jikan path: ${url}`);
      },
    },
    async (server, mock) => {
      const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();

      // AniZip cannot provide (valid payload, zero normal episodes): the
      // existing Jikan fallback served the response honestly.
      assert.equal(body.source, 'jikan');
      assert.ok(Array.isArray(body.episodes) && body.episodes.length === 1);

      // The empty AniZip result was NOT cached as a successful response.
      assert.equal(await cacheManager.get(ANIZIP_KEY), null);
      assert.equal(mock.anizipCalls().length, 1);
    },
  );
});

test('a MALFORMED AniZip payload (no episodes container) is a typed error - never cached as data', async () => {
  await withServer(
    {
      ...anizipPrimaryMocks({ mappings: { titles: { en: 'Broken' } } }), // no episodes container
      jikan: () => { throw new Error('Jikan fallback must NOT mask a malformed provider response'); },
    },
    async (server, mock) => {
      const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
      // A malformed response is a typed provider failure (never a fake empty
      // success, never cached as valid episode data).
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.code, 'PROVIDER_ERROR');

      assert.equal(await cacheManager.get(ANIZIP_KEY), null);
      assert.equal(await cacheManager.get(COMPOSITE_KEY), null);
      assert.equal(mock.anizipCalls().length, 1);
    },
  );
});

test('invalid AniList IDs are rejected (400) before any provider call', async () => {
  await withServer(
    { anizip: () => { throw new Error('must not be called'); }, anilist: () => { throw new Error('must not be called'); } },
    async (server, mock) => {
      for (const id of ['abc', '0', '-1', '1.5']) {
        const res = await fetch(`${server.baseUrl}/api/episodes/${encodeURIComponent(id)}`);
        assert.equal(res.status, 400, `expected 400 for id=${id}`);
        assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
      }
      assert.equal(mock.anizipCalls().length, 0);
      assert.equal(mock.anilistCalls().length, 0);
    },
  );
});

test('cache hit avoids another AniZip provider call (cached data returned quickly)', async () => {
  await withServer(anizipPrimaryMocks(), async (server, mock) => {
    const first = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
    const second = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();

    assert.equal(mock.anizipCalls().length, 1); // second request served from cache
    assert.deepEqual(second.episodes, first.episodes);
    assert.equal(second.source, 'anizip');

    // Cached under the AniZip-specific key including the AniList ID.
    const cached = await cacheManager.get(ANIZIP_KEY);
    assert.ok(cached);
    assert.equal(cached.totalEpisodes, 2);
    assert.equal(cached.episodes[0].episode, 1);
  });
});

test('concurrent requests for the same anime are coalesced into ONE provider request', async () => {
  await withServer(anizipPrimaryMocks(), async (server, mock) => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)),
    );
    for (const res of responses) {
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.source, 'anizip');
      assert.equal(body.episodes.length, 2);
    }
    assert.equal(mock.anizipCalls().length, 1); // shared in-flight request
    assert.equal(mock.anilistCalls().length, 2); // canonical + identity (coalesced upstream caches)
  });
});

test('AniZip failure serves STALE cached episode data (stale-if-error)', async () => {
  let anizipFail = false;
  await withServer(
    {
      anilist: anilistHandler(),
      jikan: jikanFullHandler(),
      anizip: () => (anizipFail ? { status: 500, json: { error: 'boom' } } : { status: 200, json: liveShapedMappings() }),
    },
    async (server) => {
      // Prime the caches with a successful AniZip response.
      const first = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
      assert.equal(first.source, 'anizip');

      // Age out BOTH the composite and the AniZip entry (stale retained for
      // stale-if-error).
      await expireL1Entry(COMPOSITE_KEY);
      await expireL1Entry(ANIZIP_KEY);

      // AniZip now fails (500) - the stale cached episode data must still be
      // served (never an error, never fake data, never the Jikan fallback).
      anizipFail = true;
      const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.source, 'anizip');
      assert.deepEqual(body.episodes, first.episodes);

      // The failure was NOT cached: the L1 AniZip entry still holds the
      // original successful normalized data.
      const entry = cacheManager.l1._map.get(ANIZIP_KEY);
      assert.ok(entry);
      assert.equal(entry.value.episodes.length, 2);
      assert.equal(entry.value.episodes[0].episode, 1);
    },
  );
});

test('AniZip failure with NO cache returns the typed provider error (no fake empty list)', async () => {
  let anizipFail = true;
  await withServer(
    {
      anilist: anilistHandler(),
      jikan: (url) => {
        if (url.includes(`/anime/${MAL_ID}/full`)) return { data: { mal_id: MAL_ID, title: 'Test Anime' } };
        throw new Error('Jikan episodes must NOT be reached when AniZip fails (never fake data)');
      },
      anizip: () => (anizipFail ? { status: 500, json: { error: 'boom' } } : { status: 200, json: liveShapedMappings() }),
    },
    async (server, mock) => {
      const res = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.code, 'PROVIDER_ERROR');

      // The failure was NOT cached as episode data.
      assert.equal(await cacheManager.get(ANIZIP_KEY), null);
      assert.equal(await cacheManager.get(COMPOSITE_KEY), null);
      assert.equal(mock.anizipCalls().length, 1);

      // Recovery on a subsequent successful response.
      anizipFail = false;
      const ok = await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`);
      assert.equal(ok.status, 200);
      const okBody = await ok.json();
      assert.equal(okBody.source, 'anizip');
      assert.ok(await cacheManager.get(ANIZIP_KEY));
    },
  );
});

test('episode 7 stays episode 7 and is compatible with the streaming resolver (?ep=7)', async () => {
  const { StreamResolver } = await import('../src/streaming/stream-resolver.js');
  const { CacheManager } = await import('../src/cache/cache-manager.js');
  const { MemoryStore } = await import('../src/cache/memory/memory-store.js');

  const mappings = anizipMappings({
    anilistId: ANILIST_ID,
    malId: MAL_ID,
    episodes: {
      '1': anizipEpisode({ episode: 1 }),
      '2': anizipEpisode({ episode: 2 }),
      '7': anizipEpisode({
        episode: 7,
        title: 'Episode 7',
        image: 'https://artworks.thetvdb.com/banners/episodes/78857/296981.jpg',
      }),
    },
  });
  await withServer(
    {
      ...anizipPrimaryMocks({ mappings }),
      megaplay: (url) => {
        const match = String(url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
        return { status: 200, json: { success: true, sources: [{ url: `https://cdn.example/${match[3]}.mp4` }] } };
      },
    },
    async (server) => {
      // AniZip keeps episode 7 as episode 7 (real number, gap 3..6 preserved).
      const episodesBody = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
      const ep7 = episodesBody.episodes.find((e) => e.episode === 7);
      assert.ok(ep7, 'episode 7 exists with its REAL number');
      assert.equal(ep7.image, 'https://artworks.thetvdb.com/banners/episodes/78857/296981.jpg');
      assert.ok(!episodesBody.episodes.some((e) => e.episode === 3)); // no renumbering

      // The SAME number flows straight into the streaming resolver (the
      // frontend requests ?ep=N with the episode field from this response).
      const streamResolver = new StreamResolver({
        megaplay: {
          async resolveByAnilistId(id, options) {
            return { data: { success: true, sources: [{ url: 'https://cdn.example/v.mp4' }] }, url: `https://megaplay.buzz/stream/ani/${id}/${options.episode}/sub` };
          },
        },
        identity: { async resolveAniListToMal() { return { anilistId: ANILIST_ID, malId: null, resolved: false, source: null, confidence: null }; } },
        cache: new CacheManager({ l1: new MemoryStore() }),
        proxy: {
          isConfigured: () => true,
          buildWatchUrl: ({ idType, id, episode, language }) => `https://megaplayproxy.test/watch/${id}?ep=${episode}&lang=${language}&idType=${idType}`,
        },
      });
      const stream = await streamResolver.resolveStream({ anilistId: ANILIST_ID, episode: ep7.episode });
      assert.equal(stream.episode, 7);
      assert.ok(stream.playbackUrl.includes('ep=7&'));
      assert.ok(!stream.playbackUrl.includes('ep=1&'));
    },
  );
});

test('multi-cour anime (148 episodes, live HxH shape): the SERVICE path returns every entry - never truncated to 58', async () => {
  // Live-verified anilist_id=11061 structure: 180 keys = 148 absolute
  // episodes + 32 specials; episodeNumber is PER-SEASON (resets each cour:
  // season 1 = 58, season 2 = 78, season 3 = 12 entries). Built
  // programmatically from the real structure - no anime-specific logic.
  const episodes = {};
  const courBoundaries = { 1: 58, 2: 78, 3: 12 };
  let absolute = 0;
  for (const season of [1, 2, 3]) {
    for (let perSeason = 1; perSeason <= courBoundaries[season]; perSeason += 1) {
      absolute += 1;
      episodes[String(absolute)] = anizipEpisode({
        episode: absolute,
        title: `Episode ${absolute}`,
        titleJa: `第${absolute}話`,
        extra: { episodeNumber: perSeason, seasonNumber: season, absoluteEpisodeNumber: absolute },
      });
    }
  }
  for (let s = 1; s <= 32; s += 1) episodes[`S${s}`] = anizipEpisode({ episode: 1, title: `Special ${s}` });

  const mappings = anizipMappings({ anilistId: ANILIST_ID, malId: MAL_ID, episodes, specialCount: 32 });
  await withServer(anizipPrimaryMocks({ mappings }), async (server) => {
    const body = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();
    // ALL 148 entries - the pre-fix bug returned exactly 58 (season 1 only).
    assert.equal(body.episodes.length, 148);
    assert.equal(body.totalEpisodes, 148);
    assert.deepEqual(
      body.episodes.map((e) => e.episode),
      Array.from({ length: 148 }, (_, i) => i + 1),
    );
    // The first cour / second cour boundary keeps absolute numbering.
    const ep59 = body.episodes.find((e) => e.episode === 59);
    assert.equal(ep59.episodeNumber, 1); // season 2's first episode...
    assert.equal(ep59.seasonNumber, 2); // ...but stays absolute episode 59
    // The cached normalized list is complete too (not truncated at 58).
    const cached = await cacheManager.get(ANIZIP_KEY);
    assert.equal(cached.episodes.length, 148);
    assert.equal(cached.totalEpisodes, 148);
  });
});

test('old pre-versioning cache entries holding TRUNCATED lists can never be served again', async () => {
  await withServer(anizipPrimaryMocks(), async (server, mock) => {
    // Simulate a pre-fix (v1) cached entry: an incomplete 58-entry list under
    // the OLD key `anizip:episodes:anilist:{id}` (e.g. written by the old
    // normalizer before the absolute-number fix).
    const truncated = {
      episodes: Array.from({ length: 58 }, (_, i) => ({ episode: i + 1, title: `Episode ${i + 1}`, source: 'anizip' })),
      totalEpisodes: 58,
      titles: null,
      images: null,
      mappings: null,
      episodeCount: 148,
      specialCount: 32,
    };
    await cacheManager.set(`anizip:episodes:anilist:${ANILIST_ID}`, truncated, 86_400);

    const body = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();

    // The v2 key is used: the truncated v1 entry is ignored, the complete
    // provider response is fetched, normalized and cached.
    assert.equal(body.episodes.length, 2);
    assert.equal(body.totalEpisodes, 2);
    assert.equal(mock.anizipCalls().length, 1); // v1 entry did NOT satisfy the request
    const v2 = await cacheManager.get(ANIZIP_KEY);
    assert.ok(v2, 'complete result cached under the v2 key');
    assert.equal(v2.totalEpisodes, 2);
  });
});

test('existing frontend response fields remain backward-compatible', async () => {
  await withServer(anizipPrimaryMocks(), async (server) => {
    const body = await (await fetch(`${server.baseUrl}/api/episodes/${ANILIST_ID}`)).json();

    // Top-level contract (Jikan/TMDB era names preserved).
    for (const field of ['id', 'anilistId', 'malId', 'totalEpisodes', 'pageInfo', 'episodes', 'source']) {
      assert.ok(field in body, `top-level field ${field} missing`);
    }
    assert.equal(body.totalEpisodes, 2);
    assert.equal(body.pageInfo, null);

    // Per-episode fields the frontend already consumes (Jikan/TMDB era names).
    for (const field of ['episode', 'globalEpisodeNumber', 'title', 'titleJapanese', 'overview', 'aired', 'runtime', 'score', 'image', 'filler', 'recap', 'source']) {
      assert.ok(field in body.episodes[0], `per-episode field ${field} missing`);
    }
    // New thumbnail-adjacent fields were ADDED without breaking the shape.
    assert.ok('titleVariants' in body.episodes[0]);
    assert.equal(typeof body.episodes[0].episode, 'number');

    // No stream/playback URLs anywhere in the episode payload.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('megaplay'));
    assert.ok(!raw.includes('playback'));
  });
});
