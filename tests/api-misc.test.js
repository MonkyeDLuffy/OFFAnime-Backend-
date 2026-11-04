/**
 * Phase 7 endpoint tests: GET /api/recommendations/:id, GET /api/seasons/:id,
 * GET /api/category/:type, GET /api/schedule, GET /api/tmdb/:id, and the
 * reserved GET /api/stream/resolve/:id (must remain 501 until Phase 8).
 *
 * Uses the real Express app on an ephemeral port with a mocked global fetch
 * routed by provider host. No live providers required.
 */

// Env setup MUST be the first import (ESM evaluates imports depth-first in
// order, so this runs before config/env.js loads). TMDB is configured for this
// file only (each test file is its own process) so visual enrichment tests
// exercise the real TMDB request path.
import './helpers/test-env-tmdb.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  anilistMedia,
  anilistPage,
  tmdbSearchResults,
  tmdbTvCandidate,
  tmdbImages,
  tmdbVideos,
  tmdbBackdrop,
  tmdbLogo,
  tmdbVideo,
} from './helpers/test-server.js';

/** @param {string} query */
function anilistKind(query) {
  if (query.includes('airingSchedules')) return 'schedule';
  if (query.includes('recommendations')) return 'recommendations';
  if (query.includes('relations')) return 'relations';
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  if (query.includes('$idMal')) return 'byMal';
  return 'byId';
}

test('GET /api/recommendations/:id -> 200 normalized AniList recommendations (AniList IDs)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'recommendations') {
        throw new Error(`expected recommendations, got: ${body.query}`);
      }
      return {
        data: {
          Media: {
            recommendations: {
              nodes: [
                { rating: 100, mediaRecommendation: anilistMedia({ id: 201, idMal: 301, title: 'Recommended A' }) },
                { rating: 80, mediaRecommendation: anilistMedia({ id: 202, idMal: 302, title: 'Recommended B' }) },
                { rating: 50, mediaRecommendation: null },
              ],
            },
          },
        },
      };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/recommendations/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body) && body.length === 2);
    // Recommendation IDs stay AniList namespaced - never converted to MAL IDs.
    assert.equal(body[0].id, 201);
    assert.equal(body[0].anilistId, 201);
    assert.equal(body[0].malId, 301);
    assert.equal(body[0].rating, 100);
    assert.ok(body[0].title);

    // No heavy per-recommendation enrichment.
    assert.equal(mock.jikanCalls().length, 0);
    assert.equal(mock.tmdbCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/recommendations/:id -> invalid ID -> 400; cached behavior on valid ID', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'recommendations') throw new Error('unexpected query');
      return { data: { Media: { recommendations: { nodes: [] } } } };
    },
  });
  const server = await startTestServer();
  try {
    const bad = await fetch(`${server.baseUrl}/api/recommendations/abc`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(mock.anilistCalls().length, 0);

    const first = await fetch(`${server.baseUrl}/api/recommendations/123`);
    assert.equal(first.status, 200);
    const callsAfterFirst = mock.calls.length;

    const second = await fetch(`${server.baseUrl}/api/recommendations/123`);
    assert.equal(second.status, 200);
    assert.equal(mock.calls.length, callsAfterFirst);
  } finally {
    await server.stop();
    mock.restore();
  }
});

// --- /api/seasons (AniList relations) fixtures ---------------------------------

/**
 * Raw AniList Media node for a RELATED entry (relations edge/node fields).
 * @param {{ id?: number|null, idMal?: number|null, type?: string, format?: string|null, status?: string, episodes?: number|null, season?: string|null, seasonYear?: number|null, averageScore?: number|null, genres?: string[], romaji?: string, english?: string|null, native?: string|null, poster?: string|null, xlPoster?: string|null, banner?: string|null }} [options]
 */
function relationNode({
  id,
  idMal = null,
  type = 'ANIME',
  format = 'TV',
  status = 'FINISHED',
  episodes = 12,
  season = 'WINTER',
  seasonYear = 2023,
  averageScore = 80,
  genres = ['Action'],
  romaji = 'Related Anime',
  english = null,
  native = null,
  poster = 'https://img.anilist.co/rel.jpg',
  xlPoster = null,
  banner = null,
} = {}) {
  return {
    id,
    idMal,
    type,
    format,
    status,
    episodes,
    season,
    seasonYear,
    averageScore,
    genres,
    title: { english, romaji, native },
    coverImage: { extraLarge: xlPoster, large: poster, medium: poster },
    bannerImage: banner,
  };
}

/**
 * Raw relations-edges Media payload for the /api/seasons query (parent fields
 * + edges in ONE response, exactly like the real AniList shape).
 * @param {{ id?: number, idMal?: number|null, romaji?: string, english?: string|null, native?: string|null, poster?: string|null, xlPoster?: string|null, banner?: string|null, format?: string, edges: Array<{ relationType: string|string|null, node: Record<string, unknown>|null }> }} options
 */
function relationsMedia({ id = 100, idMal = 200, romaji = 'Parent Anime', english = 'Parent Anime EN', native = '親アニメ', poster = 'https://img.anilist.co/parent.jpg', xlPoster = null, banner = null, format = 'TV', edges }) {
  return {
    id,
    idMal,
    type: 'ANIME',
    format,
    status: 'FINISHED',
    episodes: 12,
    title: { english, romaji, native },
    coverImage: { extraLarge: xlPoster, large: poster, medium: poster },
    bannerImage: banner,
    relations: { edges },
  };
}

test('GET /api/seasons/:id -> 200 categorized relations (prequels/sequels separated, deduped, anime-only)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'relations') throw new Error(`expected relations, got: ${body.query}`);
      // Query correctness: relationType MUST come from edges, never nodes
      // (the schema field placement that broke this endpoint before).
      assert.ok(
        ! /relations\s*\{\s*nodes/.test(body.query),
        'relations query must use edges (AniList lacks relationType on Media nodes)',
      );
      return {
        data: {
          Media: relationsMedia({
            edges: [
              { relationType: 'SEQUEL', node: relationNode({ id: 124, idMal: 457, romaji: 'Sequel', english: 'Sequel EN', banner: 'https://img.anilist.co/seq-banner.jpg' }) },
              { relationType: 'PREQUEL', node: relationNode({ id: 122, idMal: 455, romaji: 'Prequel', native: null }) },
              // Unusable/duplicate/invalid entries are all dropped, never fabricated:
              { relationType: 'SIDE_STORY', node: null },
              { relationType: 'SIDE_STORY', node: relationNode({ id: null, romaji: 'No Id' }) },
              { relationType: 'ADAPTATION', node: relationNode({ id: 900, type: 'MANGA', format: null, romaji: 'Manga Adaptation' }) },
              { relationType: 'SEQUEL', node: relationNode({ id: 124, romaji: 'Duplicate Sequel' }) },
              { relationType: 'UNKNOWN_TYPE', node: relationNode({ id: 130, romaji: 'Other Type' }) },
            ],
          }),
        },
      };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/100`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);

    // Parent anime identified in the SAME AniList request.
    assert.equal(body.anime.id, 100);
    assert.equal(body.anime.title, 'Parent Anime EN');
    assert.equal(body.anime.malId, 200);
    assert.deepEqual(body.anime.images, { poster: 'https://img.anilist.co/parent.jpg', banner: null });

    // Prequels and sequels are separate arrays.
    assert.equal(body.sequels.length, 1);
    const sequel = body.sequels[0];
    assert.equal(sequel.id, 124);
    assert.equal(sequel.anilistId, 124);
    assert.equal(sequel.malId, 457);
    assert.equal(sequel.relationType, 'SEQUEL');
    assert.equal(sequel.relationLabel, 'Sequel');
    assert.equal(sequel.format, 'TV');
    assert.equal(sequel.status, 'FINISHED');
    assert.equal(sequel.episodes, 12);
    assert.equal(sequel.season, 'WINTER');
    assert.equal(sequel.seasonYear, 2023);
    assert.equal(sequel.averageScore, 80);
    assert.deepEqual(sequel.genres, ['Action']);
    assert.equal(sequel.title, 'Sequel EN');
    assert.equal(sequel.titleEnglish, 'Sequel EN');
    assert.equal(sequel.titleRomaji, 'Sequel');

    assert.equal(body.prequels.length, 1);
    const prequel = body.prequels[0];
    assert.equal(prequel.relationType, 'PREQUEL');
    // English-first display title falls back to romaji, then native.
    assert.equal(prequel.title, 'Prequel');
    assert.equal(prequel.titleEnglish, null);
    assert.equal(prequel.titleRomaji, 'Prequel');

    // Other relations preserved (including unknown AniList types) with labels.
    assert.equal(body.other.length, 1);
    assert.equal(body.other[0].id, 130);
    assert.equal(body.other[0].relationType, 'UNKNOWN_TYPE');
    assert.equal(body.other[0].relationLabel, 'Unknown Type');

    // Manga excluded; pagination/dedup/self handled.
    assert.ok(!body.other.some((e) => e.type === 'MANGA'));
    assert.deepEqual(body.sideStories, []);
    assert.deepEqual(body.spinOffs, []);
    assert.deepEqual(body.alternativeVersions, []);
    assert.deepEqual(body.parentStory, []);
    // Every TV-format entry lands in the tv group (sequel, prequel AND the
    // unknown-relation entry), keyed by id.
    assert.deepEqual(
      Object.fromEntries(Object.entries(body.formatGroups).map(([k, v]) => [k, v.map((e) => e.id).sort((a, b) => a - b)])),
      { ova: [], ona: [], movies: [], specials: [], tv: [122, 124, 130], otherFormats: [] },
    );
    assert.equal(body.totalRelated, 3); // sequel + prequel + unknown-type; dupes/manga/self excluded

    // One exactly-one AniList request carried everything.
    assert.equal(mock.anilistCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/seasons/:id -> format groups derived from the same entries; OVA sequel keeps its category', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'relations') throw new Error(`expected relations, got: ${body.query}`);
      return {
        data: {
          Media: relationsMedia({
            edges: [
              { relationType: 'SEQUEL', node: relationNode({ id: 210, romaji: 'TV Short Sequel', format: 'TV_SHORT' }) },
              { relationType: 'SIDE_STORY', node: relationNode({ id: 211, romaji: 'OVA Side Story', format: 'OVA' }) },
              { relationType: 'SIDE_STORY', node: relationNode({ id: 212, romaji: 'ONA Side Story', format: 'ONA' }) },
              { relationType: 'SIDE_STORY', node: relationNode({ id: 213, romaji: 'Special Side Story', format: 'SPECIAL' }) },
              { relationType: 'SUMMARY', node: relationNode({ id: 214, romaji: 'Movie Summary', format: 'MOVIE' }) },
              { relationType: 'SPIN_OFF', node: relationNode({ id: 215, romaji: 'Music Spin-off', format: 'MUSIC' }) },
            ],
          }),
        },
      };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/100`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const findById = (entry) => entry.id;
    assert.deepEqual(body.formatGroups.ova.map(findById), [211]);
    assert.deepEqual(body.formatGroups.ona.map(findById), [212]);
    assert.deepEqual(body.formatGroups.movies.map(findById), [214]);
    assert.deepEqual(body.formatGroups.specials.map(findById), [213]);
    // TV_SHORT goes to tv; MUSIC (and unknown formats) goes to otherFormats.
    assert.deepEqual(body.formatGroups.tv.map(findById), [210]);
    assert.deepEqual(body.formatGroups.otherFormats.map(findById), [215]);

    // The same OBJECTS (not records, not fabrications): OVA entry keeps its
    // original relation category AND its format.
    assert.deepEqual(body.sideStories.map(findById), [211, 212, 213]);
    const ova = body.formatGroups.ova[0];
    assert.equal(ova.format, 'OVA');
    assert.equal(ova.relationType, 'SIDE_STORY');
    assert.equal(ova.id, body.sideStories[0].id);
    assert.equal(ova.title, body.sideStories[0].title);

    // The movie summary stays in `other` (relation categories by type) while
    // also being reachable via the movies format group. JSON round-trips mean
    // distinct object instances - compare by CONTENT, not reference.
    const movie = body.formatGroups.movies[0];
    assert.equal(movie.relationType, 'SUMMARY');
    assert.equal(movie.relationLabel, 'Summary');
    assert.ok(body.other.some((e) => JSON.stringify(e) === JSON.stringify(movie)));

    assert.equal(body.totalRelated, 6);
    assert.equal(mock.anilistCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/seasons/:id -> posters/banners per entry; xl poster preferred; missing banner is null (never a poster)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'relations') throw new Error(`expected relations, got: ${body.query}`);
      return {
        data: {
          Media: relationsMedia({
            id: 300,
            poster: null,
            xlPoster: 'https://img.anilist.co/parent-xl.jpg',
            banner: 'https://img.anilist.co/parent-banner.jpg',
            romaji: 'Banner Parent',
            edges: [
              { relationType: 'SEQUEL', node: relationNode({ id: 301, xlPoster: 'https://img.anilist.co/xl.jpg', banner: 'https://img.anilist.co/real-banner.jpg' }) },
              { relationType: 'PREQUEL', node: relationNode({ id: 302, xlPoster: null, poster: 'https://img.anilist.co/l.jpg', banner: null }) },
            ],
          }),
        },
      };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/300`);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Parent: extraLarge preferred, banner is the real AniList bannerImage.
    assert.equal(body.anime.images.poster, 'https://img.anilist.co/parent-xl.jpg');
    assert.equal(body.anime.images.banner, 'https://img.anilist.co/parent-banner.jpg');

    const sequel = body.sequels[0];
    assert.equal(sequel.images.poster, 'https://img.anilist.co/xl.jpg');
    assert.equal(sequel.images.banner, 'https://img.anilist.co/real-banner.jpg');

    const prequel = body.prequels[0];
    // large falls back before medium; poster never faked as a banner.
    assert.equal(prequel.images.poster, 'https://img.anilist.co/l.jpg');
    assert.equal(prequel.images.banner, null);
    assert.notEqual(prequel.images.banner, prequel.images.poster);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/seasons/:id -> spin-offs + side stories categorized; multiple sequels kept', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'relations') throw new Error(`expected relations, got: ${body.query}`);
      return {
        data: {
          Media: relationsMedia({
            edges: [
              { relationType: 'SEQUEL', node: relationNode({ id: 410, romaji: 'Sequel One' }) },
              { relationType: 'SEQUEL', node: relationNode({ id: 411, romaji: 'Sequel Two' }) },
              { relationType: 'SEQUEL', node: relationNode({ id: 412, romaji: 'Sequel Three' }) },
              { relationType: 'SPIN_OFF', node: relationNode({ id: 430, romaji: 'Spin One' }) },
              { relationType: 'SIDE_STORY', node: relationNode({ id: 431, romaji: 'Side One' }) },
              { relationType: 'ALTERNATIVE', node: relationNode({ id: 432, romaji: 'Alternative Version' }) },
              { relationType: 'PARENT', node: relationNode({ id: 433, romaji: 'Parent Story' }) },
              { relationType: 'SUMMARY', node: relationNode({ id: 434, romaji: 'Summary Recap' }) },
              { relationType: 'CHARACTER', node: relationNode({ id: 435, romaji: 'Chara Mix' }) },
              { relationType: 'ADAPTATION', node: relationNode({ id: 436, romaji: 'Adaptation' }) },
              { relationType: 'SOURCE', node: relationNode({ id: 437, romaji: 'Source' }) },
              { relationType: 'COMPILATION', node: relationNode({ id: 438, romaji: 'Compilation' }) },
              { relationType: 'CONTAINS', node: relationNode({ id: 439, romaji: 'Contains' }) },
              { relationType: 'SAME_UNIVERSE', node: relationNode({ id: 440, romaji: 'Same Universe' }) },
            ],
          }),
        },
      };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/100`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(body.sequels.map((e) => e.id), [410, 411, 412]);
    assert.deepEqual(body.spinOffs.map((e) => e.id), [430]);
    assert.deepEqual(body.sideStories.map((e) => e.id), [431]);
    assert.deepEqual(body.alternativeVersions.map((e) => e.id), [432]);
    assert.deepEqual(body.parentStory.map((e) => e.id), [433]);
    assert.deepEqual(
      body.other.map((e) => e.id).sort((a, b) => a - b),
      [434, 435, 436, 437, 438, 439, 440],
    );
    assert.equal(body.other[0].relationLabel, 'Summary');
    assert.equal(body.alternativeVersions[0].relationLabel, 'Alternative Version');
    assert.equal(body.spinOffs[0].relationLabel, 'Spin-off');
    assert.equal(body.totalRelated, 14); // 3 sequels + 4 other single categories + 7 "other" types
    assert.equal(mock.anilistCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/seasons/:id -> anime with no relations -> valid empty payload (cached once; cache hit identical)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'relations') throw new Error(`expected relations, got: ${body.query}`);
      return { data: { Media: relationsMedia({ id: 505, romaji: 'No Relations Anime', english: 'No Relations Anime EN', edges: [] }) } };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/505`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.anime.id, 505);
    assert.equal(body.anime.title, 'No Relations Anime EN');
    for (const category of ['prequels', 'sequels', 'sideStories', 'spinOffs', 'alternativeVersions', 'parentStory', 'other']) {
      assert.ok(Array.isArray(body[category]) && body[category].length === 0, `${category} must be an empty array`);
    }
    for (const group of ['ova', 'ona', 'movies', 'specials', 'tv', 'otherFormats']) {
      assert.ok(Array.isArray(body.formatGroups[group]) && body.formatGroups[group].length === 0, `formatGroups.${group} must be an empty array`);
    }
    assert.equal(body.totalRelated, 0);

    // Cache miss persisted the VALID empty result; a second request stays
    // identical with zero extra provider calls.
    const res2 = await fetch(`${server.baseUrl}/api/seasons/505`);
    assert.deepEqual(await res2.json(), body);
    assert.equal(mock.anilistCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/seasons/:id -> unknown anime -> 404 standard not-found response', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => new Response(JSON.stringify({ errors: [{ status: 404, message: 'Not Found.' }] }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/999999999`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(mock.anilistCalls().length, 1);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/seasons/:id -> invalid ID -> 400 ValidationError', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => { throw new Error('must not be called'); } });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/seasons/abc`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/category/:type -> 200 normalized genre category (AniList filtering)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'search') throw new Error(`expected search, got: ${body.query}`);
      return anilistPage([anilistMedia({ id: 41, idMal: 51, title: 'Action Anime' })]);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/category/action`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.results) && body.results.length === 1);
    assert.equal(body.results[0].id, 41);
    assert.equal(body.results[0].anilistId, 41);

    // The genre reached AniList as a validated enum value.
    assert.equal(mock.anilistCalls()[0].body.variables.genre, 'Action');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/category/:type -> special categories and pagination; invalid category -> 400', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => anilistPage([]) });
  const server = await startTestServer();
  try {
    // Special (non-genre) categories map to validated AniList options.
    const airing = await fetch(`${server.baseUrl}/api/category/airing`);
    assert.equal(airing.status, 200);
    assert.equal(mock.anilistCalls()[0].body.variables.status, 'RELEASING');

    const trending = await fetch(`${server.baseUrl}/api/category/trending`);
    assert.equal(trending.status, 200);
    assert.deepEqual(mock.anilistCalls()[1].body.variables.sort, ['TRENDING_DESC']);

    // Punctuation/separator-insensitive genre matching ('Sci-Fi' aliases).
    const sciFi = await fetch(`${server.baseUrl}/api/category/sci-fi`);
    assert.equal(sciFi.status, 200);
    assert.equal(mock.anilistCalls()[2].body.variables.genre, 'Sci-Fi');

    // Pagination passed through and validated.
    const paged = await fetch(`${server.baseUrl}/api/category/action?page=2&perPage=10`);
    assert.equal(paged.status, 200);
    assert.equal(mock.anilistCalls()[3].body.variables.page, 2);

    // Invalid category values never reach the provider.
    const invalid = await fetch(`${server.baseUrl}/api/category/not-a-category`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(mock.anilistCalls().length, 4);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/schedule -> 200 normalized airing schedule (AniList only, cached)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'schedule') throw new Error(`expected schedule, got: ${body.query}`);
      return {
        data: {
          Page: {
            pageInfo: { hasNextPage: true },
            airingSchedules: [
              { airingAt: 1700000000, episode: 5, media: { id: 123, idMal: 456, title: { romaji: 'Scheduled', english: null, userPreferred: 'Scheduled' } } },
              { airingAt: null, episode: 6, media: { id: 124, idMal: 457, title: { romaji: 'Bad', english: null, userPreferred: 'Bad' } } },
            ],
          },
        },
      };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/schedule`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.results) && body.results.length === 1);
    assert.equal(body.results[0].airingAt, 1700000000);
    assert.equal(body.results[0].episode, 5);
    // AniList identity preserved on schedule entries.
    assert.equal(body.results[0].anime.id, 123);
    assert.equal(body.results[0].anime.anilistId, 123);
    assert.equal(body.results[0].anime.malId, 456);

    assert.equal(mock.jikanCalls().length, 0);
    assert.equal(mock.tmdbCalls().length, 0);

    // Cached: second request makes zero provider calls.
    const callsAfterFirst = mock.calls.length;
    const second = await fetch(`${server.baseUrl}/api/schedule`);
    assert.equal(second.status, 200);
    assert.equal(mock.calls.length, callsAfterFirst);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/schedule -> provider failure -> 502 structured error (never fabricated times)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => ({ status: 500, json: { error: 'boom' } }) });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/schedule`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'PROVIDER_ERROR');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id -> 200 resolved visual enrichment + media assets; AniList identity untouched', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    tmdb: (url) => {
      if (url.includes('/search/tv')) {
        return tmdbSearchResults([tmdbTvCandidate({ id: 789, name: 'Test Anime', backdropPath: '/backdrop.jpg' })]);
      }
      if (url.includes('/tv/789') && !url.includes('/tv/789/')) {
        // TV details (season derivation): season 1 matches the entry year.
        return {
          status: 200,
          json: {
            id: 789,
            name: 'Test Anime',
            first_air_date: '2023-01-10',
            seasons: [{ season_number: 1, name: 'Season 1', air_date: '2023-01-10', episode_count: 12, poster_path: '/season-1.jpg' }],
          },
        };
      }
      if (url.includes('/tv/789/images')) return tmdbImages({
        backdrops: [
          tmdbBackdrop({ path: '/bd-a.jpg', width: 3840, height: 2160, voteAverage: 6 }),
          tmdbBackdrop({ path: '/bd-b.jpg', width: 1920, height: 1080, voteAverage: 4 }),
        ],
        logos: [
          tmdbLogo({ path: '/logo-jp.png', language: 'ja', voteAverage: 4 }),
          tmdbLogo({ path: '/logo-en.png', language: 'en', voteAverage: 4 }),
          tmdbLogo({ path: '/logo.svg', language: 'en', voteAverage: 9 }),
        ],
      });
      if (url.includes('/tv/789/videos')) {
        return tmdbVideos({ results: [
          tmdbVideo({ key: 'teaser1', name: 'Teaser', type: 'Teaser', official: true, publishedAt: '2023-02-01T00:00:00.000Z' }),
          tmdbVideo({ key: 'trailer1', name: 'Official Trailer', type: 'Trailer', official: true, publishedAt: '2023-01-01T00:00:00.000Z' }),
          tmdbVideo({ key: 'clip1', name: 'Clip', type: 'Clip', official: false }),
          tmdbVideo({ key: 'vimeo1', site: 'Vimeo', type: 'Trailer', official: true }),
        ] });
      }
      throw new Error(`unexpected TMDB path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Visual enrichment result - TMDB identity NEVER becomes canonical identity.
    assert.equal(body.resolved, true);
    assert.equal(body.tmdbId, 789);
    assert.equal(body.mediaType, 'tv');
    // Image URLs built from actual TMDB paths (never fabricated).
    assert.equal(body.images.backdrop, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
    assert.equal(body.images.banner, 'https://image.tmdb.org/t/p/original/backdrop.jpg');

    // Logo: transparent PNG preferred (svg ignored), language/quality ranked.
    assert.equal(body.logo.path, '/logo-en.png');
    assert.equal(body.logo.extension, 'png');
    assert.equal(body.logo.language, 'en');
    assert.equal(body.logo.url, 'https://image.tmdb.org/t/p/w500/logo-en.png');
    assert.equal(body.logo.urlOriginal, 'https://image.tmdb.org/t/p/original/logo-en.png');

    // Backdrops: high-quality landscape entries with dimensions, ranked.
    assert.ok(Array.isArray(body.backdrops) && body.backdrops.length === 2);
    assert.equal(body.backdrops[0].path, '/bd-a.jpg');
    assert.equal(body.backdrops[0].url, 'https://image.tmdb.org/t/p/w1280/bd-a.jpg');
    assert.equal(body.backdrops[0].urlOriginal, 'https://image.tmdb.org/t/p/original/bd-a.jpg');
    assert.equal(body.backdrops[0].width, 3840);
    assert.equal(body.backdrops[0].height, 2160);

    // Trailer: official YouTube Trailer preferred over Teaser; clips and
    // non-YouTube providers excluded.
    assert.equal(body.trailer.key, 'trailer1');
    assert.equal(body.trailer.site, 'YouTube');
    assert.equal(body.trailer.type, 'Trailer');
    assert.equal(body.trailer.official, true);
    assert.equal(body.trailer.url, 'https://www.youtube.com/watch?v=trailer1');
    assert.equal(body.trailer.embedUrl, 'https://www.youtube.com/embed/trailer1');
    assert.ok(Array.isArray(body.videos) && body.videos.length === 2);
    assert.ok(body.videos.every((v) => ['Trailer', 'Teaser'].includes(v.type)));

    // Season derivation: series match + season validated against TMDB seasons.
    assert.equal(body.tmdbSeasonNumber, 1);
    assert.equal(body.season.seasonNumber, 1);
    assert.equal(body.season.airDate, '2023-01-10');
    assert.equal(body.season.poster, 'https://image.tmdb.org/t/p/w500/season-1.jpg');
    assert.equal(body.matchStrategy, 'title');
    assert.equal(body.matchedTitle, 'Test Anime');

    // The AniList search used titles for matching; the id stays AniList.
    assert.equal(mock.anilistCalls()[0].body.variables.id, 123);
    assert.ok(!mock.tmdbCalls()[0].includes('123'), 'AniList ID never sent to TMDB');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id -> images/videos upstream failure degrades gracefully (200, fallback backdrop)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    tmdb: (url) => {
      if (url.includes('/search/tv')) {
        return tmdbSearchResults([tmdbTvCandidate({ id: 789, name: 'Test Anime', backdropPath: '/backdrop.jpg' })]);
      }
      // Both media-asset legs fail (e.g. partial TMDB outage).
      return { status: 500, json: { error: 'boom' } };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/123`);
    assert.equal(res.status, 200, 'media-asset failure never fails the response');

    const body = await res.json();
    // Existing visual contract intact.
    assert.equal(body.resolved, true);
    assert.equal(body.tmdbId, 789);
    assert.equal(body.images.backdrop, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
    // Details endpoint also failing -> season derivation degrades gracefully
    // (the reliable series match stands; the season stays unresolved).
    assert.equal(body.tmdbSeasonNumber, null);
    assert.equal(body.season, null);
    // Degraded media fields: no logo/trailer, fallback backdrop from the
    // enrichment's real TMDB path.
    assert.equal(body.logo, null);
    assert.equal(body.trailer, null);
    assert.deepEqual(body.videos, []);
    assert.deepEqual(body.backdrops, [{ path: null, url: 'https://image.tmdb.org/t/p/original/backdrop.jpg', urlOriginal: 'https://image.tmdb.org/t/p/original/backdrop.jpg', width: null, height: null, language: null, voteAverage: null }]);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id -> unresolved: 200 valid unresolved enrichment (no fake URLs)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    tmdb: () => tmdbSearchResults([]),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/123`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.resolved, false);
    assert.equal(body.tmdbId, null);
    assert.equal(body.images, null);
    assert.equal(body.poster, null);
    assert.ok(body.reason);
    // Additive media fields mirror the unresolved null convention - and NO
    // images/videos requests are made without a confident match.
    assert.equal(body.logo, null);
    assert.equal(body.backdrops, null);
    assert.equal(body.trailer, null);
    assert.equal(body.videos, null);
    assert.ok(mock.tmdbCalls().every((u) => u.includes('/search/tv')));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id -> TMDB failure -> 502 but canonical data unaffected (cached)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byId') throw new Error(`expected byId, got: ${body.query}`);
      return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
    },
    tmdb: () => ({ status: 500, json: { error: 'boom' } }),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/123`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'PROVIDER_ERROR');

    // Canonical AniList data was cached before enrichment: details still work
    // (getFullDetails catches the TMDB failure and skips enrichment).
    const details = await fetch(`${server.baseUrl}/api/details/123`);
    assert.equal(details.status, 200);
    const canonical = await details.json();
    assert.equal(canonical.id, 123);
    assert.equal(canonical.anilistId, 123);
    assert.equal(canonical.malId, 456);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id?type=mal -> resolves MAL ID via IdentityResolver (never treated as AniList/TMDB ID)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      const kind = anilistKind(body.query);
      if (kind === 'byMal') {
        return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
      }
      if (kind === 'byId') {
        return { data: { Media: anilistMedia({ id: 123, idMal: 456 }) } };
      }
      throw new Error(`unexpected AniList query: ${body.query}`);
    },
    tmdb: (url) => {
      if (url.includes('/search/tv')) {
        return tmdbSearchResults([tmdbTvCandidate({ id: 789, name: 'Test Anime', backdropPath: '/backdrop.jpg' })]);
      }
      if (url.includes('/tv/789') && !url.includes('/tv/789/')) {
        return {
          status: 200,
          json: {
            id: 789,
            name: 'Test Anime',
            first_air_date: '2023-01-10',
            seasons: [{ season_number: 1, name: 'Season 1', air_date: '2023-01-10', episode_count: 12, poster_path: null }],
          },
        };
      }
      if (url.includes('/tv/789/images')) return tmdbImages();
      if (url.includes('/tv/789/videos')) return tmdbVideos();
      throw new Error(`unexpected TMDB path: ${url}`);
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/456?type=mal`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.resolved, true);
    assert.equal(body.tmdbId, 789);
    assert.ok(body.trailer);

    // The MAL ID 456 was resolved through AniList's idMal (byMal), then the
    // canonical AniList ID 123 was used for title matching. TMDB never sees
    // either raw ID.
    const malCall = mock.anilistCalls().find((c) => anilistKind(c.body.query) === 'byMal');
    assert.equal(malCall.body.variables.idMal, 456);
    assert.ok(mock.tmdbCalls().every((u) => !u.includes('456') && !u.includes('/tv/456')));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id?type=mal -> unknown MAL ID -> 404 controlled error (never guessed)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'byMal') throw new Error(`expected byMal, got: ${body.query}`);
      return { data: { Media: null } };
    },
    tmdb: () => { throw new Error('must not be called'); },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/999999?type=mal`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(mock.tmdbCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/tmdb/:id -> invalid ID or unknown ID type -> 400 ValidationError, no provider request', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => { throw new Error('must not be called'); },
    tmdb: () => { throw new Error('must not be called'); },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/tmdb/abc`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');

    // Unknown id type: a bare number is ambiguous and never guessed.
    const badType = await fetch(`${server.baseUrl}/api/tmdb/123?type=tmdb`);
    assert.equal(badType.status, 400);
    assert.equal((await badType.json()).error.code, 'VALIDATION_ERROR');

    assert.equal(mock.anilistCalls().length, 0);
    assert.equal(mock.tmdbCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('GET /api/stream/resolve/:id is live in Phase 8 -> invalid id rejected (400) before any provider call', async () => {
  await resetL1Cache();
  const mock = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/abc`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');

    // No provider calls at all - no MegaPlay, no fabricated stream URLs.
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.megaplayCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});
