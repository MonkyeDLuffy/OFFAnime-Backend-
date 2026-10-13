/**
 * AniZip normalizer tests - pinned to the LIVE-VERIFIED response shape
 * (https://api.ani.zip/mappings?anilist_id=21 One Piece / anilist_id=20
 * Naruto): `episodes` is an OBJECT keyed by episode number; prefixed keys
 * ("S1", "O29") are specials/openings; entries carry episodeNumber,
 * absoluteEpisodeNumber, locale title maps, airDate/airDateUtc, runtime/
 * length, overview/summary, image, episode (string), anidbEid, rating.
 *
 * Covered: real-shaped payload normalization, real episode numbers (never
 * iteration order), numeric sorting, numbering gaps preserved, thumbnails
 * preserved, missing optional fields -> null, specials excluded + counted,
 * duplicate/invalid entries dropped, malformed payloads -> typed
 * ProviderError, no stream/playback URLs invented.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAnizipEpisodes } from '../src/normalizers/anizip-normalizer.js';
import { ProviderError } from '../src/errors/index.js';

/** A minimal entry shaped exactly like a live AniZip episode entry. */
function liveEpisode(overrides = {}) {
  return {
    tvdbShowId: 81797,
    tvdbId: 361887,
    seasonNumber: 1,
    episodeNumber: 1,
    absoluteEpisodeNumber: 1,
    title: {
      ja: '俺はルフィ! 海賊王になる男だ!',
      en: "I`m Luffy! The Man Who`s Gonna Be King of the Pirates!",
      'x-jat': 'Ore wa Luffy! Kaizoku Ou ni Naru Otoko Da!',
    },
    airDate: '1999-10-20',
    airDateUtc: '1999-10-20T14:15:00Z',
    runtime: 25,
    overview: 'Alvida pirates plunder a ship...',
    image: 'https://artworks.thetvdb.com/banners/v4/episode/361887/screencap/604df7d3ecf3a.jpg',
    episode: '1',
    anidbEid: 440,
    length: 25,
    airdate: '1999-10-20',
    rating: '6.03',
    summary: 'Countless souls have been lured along the Grand Line...',
    ...overrides,
  };
}

test('a real-shaped mappings response normalizes correctly (live One Piece shape)', () => {
  const raw = {
    titles: { en: 'One Piece', ja: 'ONE PIECE', 'x-jat': 'OP TV' },
    episodes: {
      '1': liveEpisode(),
      '2': liveEpisode({ tvdbId: 361888, episodeNumber: 2, absoluteEpisodeNumber: 2, episode: '2', anidbEid: 441 }),
      S1: liveEpisode({ episodeNumber: 1, episode: '1', title: { en: 'Special 1' } }),
    },
    episodeCount: 1184,
    specialCount: 51,
    images: [{ coverType: 'Poster', url: 'https://artworks.thetvdb.com/banners/v4/series/81797/posters/63ab23cde990b.jpg' }],
    mappings: { anilist_id: 21, mal_id: 21, type: 'TV' },
  };

  const result = normalizeAnizipEpisodes(raw);

  // Specials ("S1") are excluded from the main list; real episodes kept.
  assert.equal(result.episodes.length, 2);
  assert.equal(result.totalEpisodes, 2);
  assert.equal(result.episodeCount, 1184);
  assert.equal(result.specialCount, 51);
  assert.deepEqual(result.titles, raw.titles);
  assert.deepEqual(result.images, [{ coverType: 'Poster', url: raw.images[0].url }]);
  assert.deepEqual(result.mappings, raw.mappings);

  const ep1 = result.episodes[0];
  assert.equal(ep1.episode, 1);
  assert.equal(ep1.globalEpisodeNumber, 1);
  assert.equal(ep1.episodeNumber, 1);
  assert.equal(ep1.seasonNumber, 1);
  assert.equal(ep1.absoluteEpisodeNumber, 1);
  assert.equal(ep1.anidbEid, 440);
  assert.equal(ep1.tvdbId, 361887);
  assert.equal(ep1.title, "I`m Luffy! The Man Who`s Gonna Be King of the Pirates!");
  assert.equal(ep1.titleJapanese, '俺はルフィ! 海賊王になる男だ!');
  assert.deepEqual(ep1.titleVariants, raw.episodes['1'].title);
  assert.equal(ep1.image, 'https://artworks.thetvdb.com/banners/v4/episode/361887/screencap/604df7d3ecf3a.jpg');
  assert.equal(ep1.overview, 'Alvida pirates plunder a ship...');
  assert.equal(ep1.aired, '1999-10-20');
  assert.equal(ep1.airDateUtc, '1999-10-20T14:15:00Z');
  assert.equal(ep1.runtime, 25);
  assert.equal(ep1.score, 6.03);
  assert.equal(ep1.source, 'anizip');
  // Episode METADATA only: no stream/playback fields are ever invented.
  for (const key of ['playbackUrl', 'sources', 'url', 'stream']) {
    assert.ok(!(key in ep1), `no ${key} field on a normalized episode`);
  }
});

test('episode numbers are the REAL numbers, sorted numerically (never iteration order)', () => {
  const raw = {
    episodes: {
      '10': liveEpisode({ episodeNumber: 10, episode: '10', absoluteEpisodeNumber: 10 }),
      '2': liveEpisode({ episodeNumber: 2, episode: '2', absoluteEpisodeNumber: 2 }),
      '1': liveEpisode({ episodeNumber: 1, episode: '1', absoluteEpisodeNumber: 1 }),
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.deepEqual(
    result.episodes.map((e) => e.episode),
    [1, 2, 10],
  );
});

test('numbering GAPS are preserved exactly (never renumbered; compatible with ?ep=N)', () => {
  const raw = {
    episodes: {
      '1': liveEpisode({ episodeNumber: 1, episode: '1', absoluteEpisodeNumber: 1 }),
      '2': liveEpisode({ episodeNumber: 2, episode: '2', absoluteEpisodeNumber: 2 }),
      '7': liveEpisode({ episodeNumber: 7, episode: '7', absoluteEpisodeNumber: 7 }),
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.deepEqual(
    result.episodes.map((e) => e.episode),
    [1, 2, 7],
  );
  assert.equal(result.totalEpisodes, 3);
  const ep7 = result.episodes.find((e) => e.episode === 7);
  assert.equal(ep7.episodeNumber, 7); // the entry's own real number
  assert.equal(ep7.globalEpisodeNumber, 7);
});

test('thumbnail/image URLs are preserved exactly as returned by AniZip', () => {
  const url = 'https://artworks.thetvdb.com/banners/episodes/78857/296975.jpg';
  const raw = { episodes: { '1': liveEpisode({ image: url }) } };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes[0].image, url);
});

test('missing optional fields become null (never fabricated values)', () => {
  const raw = {
    episodes: {
      '1': liveEpisode({
        title: {},
        episodeNumber: null,
        airDate: null,
        airdate: null,
        airDateUtc: null,
        runtime: null,
        length: null,
        overview: null,
        summary: null,
        image: null,
        rating: null,
        anidbEid: null,
        tvdbId: null,
        absoluteEpisodeNumber: null,
      }),
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  const ep = result.episodes[0];
  assert.equal(ep.title, null);
  assert.equal(ep.titleJapanese, null);
  assert.equal(ep.titleVariants, null);
  assert.equal(ep.aired, null);
  assert.equal(ep.airDateUtc, null);
  assert.equal(ep.runtime, null);
  assert.equal(ep.overview, null);
  assert.equal(ep.image, null);
  assert.equal(ep.score, null);
  assert.equal(ep.anidbEid, null);
  assert.equal(ep.tvdbId, null);
  // absoluteEpisodeNumber falls back to the (real) object key - honest
  // absolute-numbering metadata, never a fabricated value.
  assert.equal(ep.absoluteEpisodeNumber, 1);
  // Per-season numbering metadata is null when the response omits it.
  assert.equal(ep.episodeNumber, null);
  assert.equal(ep.malId, null);
  assert.equal(ep.filler, null);
  assert.equal(ep.recap, null);
  assert.equal(ep.episodeType, null);
  // The episode number itself is still real (from the object key).
  assert.equal(ep.episode, 1);
});

test('per-season episodeNumber that differs from the absolute key is PRESERVED as metadata (multi-cour shows)', () => {
  // Live HxH shape: key 62 is the absolute episode; episodeNumber 4 is the
  // season-2 number. The entry is kept with both numbers intact - never
  // dropped, never renumbered.
  const raw = {
    episodes: {
      '62': liveEpisode({ episode: '62', episodeNumber: 4, seasonNumber: 2, absoluteEpisodeNumber: 62 }),
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].episode, 62);
  assert.equal(result.episodes[0].globalEpisodeNumber, 62);
  assert.equal(result.episodes[0].episodeNumber, 4); // per-season metadata
  assert.equal(result.episodes[0].seasonNumber, 2);
  assert.equal(result.episodes[0].absoluteEpisodeNumber, 62);
});

test('an entry whose ABSOLUTE number (episode field) contradicts its key is dropped (never renumbered)', () => {
  const raw = {
    episodes: {
      '3': liveEpisode({ episode: '5' }), // episode (absolute) contradicts the key
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes.length, 0);
  assert.equal(result.totalEpisodes, 0);
});

test('duplicate episode records are removed (same episode number never repeats)', () => {
  const raw = {
    episodes: [
      liveEpisode({ episodeNumber: 1, episode: '1', absoluteEpisodeNumber: 1 }),
      liveEpisode({ episodeNumber: 1, episode: '1', absoluteEpisodeNumber: 1, tvdbId: 999, title: { en: 'Duplicate' } }),
    ],
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].tvdbId, 361887); // first occurrence kept
});

test('overview falls back to the AniDB summary when overview is absent', () => {
  const raw = { episodes: { '1': liveEpisode({ overview: null, summary: 'AniDB synopsis' }) } };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes[0].overview, 'AniDB synopsis');
});

test('runtime falls back to the AniDB length when runtime is absent', () => {
  const raw = { episodes: { '1': liveEpisode({ runtime: null, length: 24 }) } };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes[0].runtime, 24);
});

test('title falls back to the x-jat romaji when en is absent (Naruto-style entries)', () => {
  const raw = {
    episodes: {
      '1': liveEpisode({ title: { ja: '参上! うずまきナルト', 'x-jat': 'Sanjou! Uzumaki Naruto' } }),
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.equal(result.episodes[0].title, 'Sanjou! Uzumaki Naruto');
  assert.equal(result.episodes[0].titleJapanese, '参上! うずまきナルト');
});

test('array-shaped episode containers use the entries OWN absolute numbers (never the index)', () => {
  const raw = {
    episodes: [
      liveEpisode({ episode: '3', episodeNumber: 3, absoluteEpisodeNumber: 3 }),
      liveEpisode({ episode: '1', episodeNumber: 1, absoluteEpisodeNumber: 1 }),
    ],
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.deepEqual(
    result.episodes.map((e) => e.episode),
    [1, 3],
  );
});

test('multi-cour shows: EVERY episode entry is kept (live Hunter x Hunter 2011 shape, 148 episodes)', () => {
  // Live-verified anilist_id=11061 shape: 180 keys = 148 absolute episodes
  // ("1".."148", continuous across 3 seasons) + 32 specials ("S1".."S32");
  // each entry's episodeNumber is the PER-SEASON number. Real per-season
  // counts from the live payload: season 1 = 58, season 2 = 78, season 3 =
  // 12 episodes (so season 2 starts at absolute 59, season 3 at absolute
  // 137). Built programmatically from the real structure - no hardcoded
  // anime logic anywhere in the backend; the counts below only PIN the
  // fixture to the live shape.
  const episodes = {};
  const courBoundaries = { 1: 58, 2: 78, 3: 12 }; // episodes per season 1..3
  let absolute = 0;
  for (const season of [1, 2, 3]) {
    for (let perSeason = 1; perSeason <= courBoundaries[season]; perSeason += 1) {
      absolute += 1;
      episodes[String(absolute)] = liveEpisode({
        episode: String(absolute),
        episodeNumber: perSeason,
        seasonNumber: season,
        absoluteEpisodeNumber: absolute,
        title: { en: `Episode ${absolute}`, ja: `第${absolute}話` },
      });
    }
  }
  for (let s = 1; s <= 32; s += 1) episodes[`S${s}`] = liveEpisode({ title: { en: `Special ${s}` } });

  const result = normalizeAnizipEpisodes({ episodes, specialCount: 32 });
  // ALL 148 absolute episodes are returned - the list is never truncated
  // after the first cour (the old bug returned exactly 58).
  assert.equal(result.episodes.length, 148);
  assert.equal(result.totalEpisodes, 148);
  assert.equal(result.specialCount, 32);

  // Continuous absolute numbering 1..148, in numeric order, gaps preserved.
  assert.deepEqual(
    result.episodes.map((e) => e.episode),
    Array.from({ length: 148 }, (_, i) => i + 1),
  );

  // Cour boundaries keep their absolute numbers and per-season metadata.
  const ep58 = result.episodes.find((e) => e.episode === 58);
  assert.equal(ep58.episodeNumber, 58); // season 1
  assert.equal(ep58.seasonNumber, 1);
  const ep59 = result.episodes.find((e) => e.episode === 59);
  assert.equal(ep59.episodeNumber, 1); // season 2's first episode...
  assert.equal(ep59.seasonNumber, 2); // ...but stays absolute episode 59
  assert.equal(ep59.absoluteEpisodeNumber, 59);
  const ep148 = result.episodes.find((e) => e.episode === 148);
  assert.equal(ep148.episodeNumber, 12); // season 3
  assert.equal(ep148.seasonNumber, 3);
  assert.equal(ep148.absoluteEpisodeNumber, 148);
});

test('a large single-cour list is not truncated (arbitrary-size lists pass through)', () => {
  const episodes = {};
  for (let i = 1; i <= 1000; i += 1) {
    episodes[String(i)] = liveEpisode({ episode: String(i), episodeNumber: i, absoluteEpisodeNumber: i });
  }
  const result = normalizeAnizipEpisodes({ episodes });
  assert.equal(result.episodes.length, 1000);
  assert.equal(result.episodes[999].episode, 1000);
});

test('invalid image values (non-http, relative paths) become null - never constructed', () => {
  const raw = {
    episodes: {
      '1': liveEpisode({ episode: 1, episodeNumber: 1, absoluteEpisodeNumber: 1, image: '/banners/guessed.jpg' }),
      '2': liveEpisode({ episode: 2, episodeNumber: 2, absoluteEpisodeNumber: 2, image: 'ftp://not-http/x.jpg' }),
      '3': liveEpisode({ episode: 3, episodeNumber: 3, absoluteEpisodeNumber: 3, image: '   ' }),
    },
  };
  const result = normalizeAnizipEpisodes(raw);
  assert.deepEqual(
    result.episodes.map((e) => e.image),
    [null, null, null],
  );
});

test('malformed payloads throw a typed ProviderError (never cached as valid data)', () => {
  for (const bad of [null, undefined, 'string', 42, [], {}, { noEpisodes: true }, { episodes: null }]) {
    assert.throws(() => normalizeAnizipEpisodes(bad), ProviderError, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('a VALID payload with no normal episodes normalizes to an honest empty list', () => {
  const raw = { episodes: { S1: liveEpisode(), O29: liveEpisode() }, specialCount: 2 };
  const result = normalizeAnizipEpisodes(raw);
  assert.deepEqual(result.episodes, []);
  assert.equal(result.totalEpisodes, 0);
  assert.equal(result.specialCount, 2);
});
