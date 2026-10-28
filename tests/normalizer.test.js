/**
 * Normalizer tests - canonical anime model + defensive behavior.
 *
 * All fixtures are mocked; no live API calls.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeAnilistAnime, createBaseAnime, normalizeAnilistTitle, normalizeAnilistImages, normalizeAnilistPage, normalizeAnilistRelations } = await import('../src/normalizers/anime.normalizer.js');
const { normalizeAnilistRelation } = await import('../src/normalizers/anime.normalizer.js');
const { cleanDescription } = await import('../src/utils/html.js');
const { ProviderError } = await import('../src/errors/index.js');

/** Realistic full AniList Media fixture. */
const fullMedia = {
  id: 1,
  idMal: 1,
  title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop', native: 'カウボーイビバップ', userPreferred: 'Cowboy Bebop' },
  description: 'In the year 2071, humanity has colonized<br>several of the planets and moons of the solar system. <i>Bounty hunters</i> roam the galaxy.',
  coverImage: { extraLarge: 'https://img.example/xl.jpg', large: 'https://img.example/l.jpg', medium: 'https://img.example/m.jpg' },
  bannerImage: 'https://img.example/banner.jpg',
  type: 'ANIME',
  format: 'TV',
  status: 'FINISHED',
  episodes: 26,
  duration: 24,
  season: 'SPRING',
  seasonYear: 1998,
  genres: ['Action', 'Sci-Fi'],
  synonyms: ['Kaubōi Bibappu'],
  studios: { nodes: [{ name: 'Sunrise' }] },
  startDate: { year: 1998, month: 4, day: 3 },
  endDate: { year: 1999, month: 4, day: 24 },
  averageScore: 86,
  popularity: 200000,
};

test('valid AniList object -> full canonical shape with id === anilistId', () => {
  const anime = normalizeAnilistAnime(fullMedia);
  assert.equal(anime.id, 1);
  assert.equal(anime.anilistId, 1);
  assert.equal(anime.id, anime.anilistId);
  assert.equal(anime.malId, 1);
  assert.deepEqual(anime.title, {
    romaji: 'Cowboy Bebop',
    english: 'Cowboy Bebop',
    native: 'カウボーイビバップ',
    userPreferred: 'Cowboy Bebop',
  });
  assert.deepEqual(anime.images, {
    poster: 'https://img.example/xl.jpg',
    cover: 'https://img.example/l.jpg',
    banner: 'https://img.example/banner.jpg',
  });
  assert.equal(anime.type, 'ANIME');
  assert.equal(anime.format, 'TV');
  assert.equal(anime.status, 'FINISHED');
  assert.equal(anime.episodes, 26);
  assert.equal(anime.duration, 24);
  assert.equal(anime.season, 'SPRING');
  assert.equal(anime.seasonYear, 1998);
  assert.deepEqual(anime.genres, ['Action', 'Sci-Fi']);
  assert.deepEqual(anime.studios, ['Sunrise']);
  assert.deepEqual(anime.synonyms, ['Kaubōi Bibappu']);
  assert.equal(anime.startDate, '1998-04-03');
  assert.equal(anime.endDate, '1999-04-24');
  assert.equal(anime.averageScore, 86);
  assert.equal(anime.popularity, 200000);
  assert.deepEqual(anime.source, { anilist: true, jikan: false, tmdb: false });
  // No undefined anywhere in the serialized model.
  assert.ok(!JSON.stringify(anime).includes('undefined'));
});

test('missing MAL ID -> malId null, anilistId preserved', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia, idMal: null });
  assert.equal(anime.malId, null);
  assert.equal(anime.anilistId, 1);
  assert.equal(anime.id, 1);
});

test('malId never becomes the anilistId / id', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia, id: 500, idMal: 999 });
  assert.equal(anime.id, 500);
  assert.equal(anime.anilistId, 500);
  assert.equal(anime.malId, 999);
  assert.notEqual(anime.id, 999);
});

test('missing description -> null, no throw', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia, description: null });
  assert.equal(anime.description, null);
});

test('missing images -> all image fields null, no throw', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia, coverImage: null, bannerImage: null });
  assert.deepEqual(anime.images, { poster: null, cover: null, banner: null });
});

test('banner is null unless AniList genuinely provides one (poster is never faked as banner)', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia, bannerImage: null });
  assert.equal(anime.images.banner, null);
  assert.notEqual(anime.images.banner, anime.images.poster);
});

test('missing title variants -> nulls; userPreferred falls back to existing fields', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia, title: {} });
  assert.deepEqual(anime.title, { romaji: null, english: null, native: null, userPreferred: null });

  const romajiOnly = normalizeAnilistTitle({ romaji: 'Romaji Only' });
  assert.equal(romajiOnly.userPreferred, 'Romaji Only');

  const englishAndRomaji = normalizeAnilistTitle({ romaji: 'Romaji', english: 'English' });
  assert.equal(englishAndRomaji.userPreferred, 'English');
});

test('userPreferred is never overwritten when present', () => {
  const t = normalizeAnilistTitle({ romaji: 'A', english: 'B', userPreferred: 'C' });
  assert.equal(t.userPreferred, 'C');
});

test('empty arrays and missing list fields normalize to []', () => {
  const anime = normalizeAnilistAnime({
    ...fullMedia,
    genres: [],
    synonyms: null,
    studios: null,
  });
  assert.deepEqual(anime.genres, []);
  assert.deepEqual(anime.synonyms, []);
  assert.deepEqual(anime.studios, []);
});

test('null optional fields remain valid (season, dates, scores, duration)', () => {
  const anime = normalizeAnilistAnime({
    ...fullMedia,
    season: null,
    seasonYear: null,
    duration: null,
    startDate: null,
    endDate: null,
    averageScore: null,
    popularity: null,
    episodes: null,
  });
  assert.equal(anime.season, null);
  assert.equal(anime.seasonYear, null);
  assert.equal(anime.duration, null);
  assert.equal(anime.startDate, null);
  assert.equal(anime.endDate, null);
  assert.equal(anime.averageScore, null);
  assert.equal(anime.popularity, null);
  assert.equal(anime.episodes, null);
});

test('partial fuzzy dates stay honest (year only -> "YYYY", year+month -> "YYYY-MM")', () => {
  const anime = normalizeAnilistAnime({
    ...fullMedia,
    startDate: { year: 2020 },
    endDate: { year: 2021, month: 7 },
  });
  assert.equal(anime.startDate, '2020');
  assert.equal(anime.endDate, '2021-07');
});

test('description HTML cleanup: tags stripped, structure preserved, entities decoded', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia });
  assert.equal(anime.description.includes('<'), false);
  assert.equal(anime.description.includes('>'), false);
  assert.ok(anime.description.includes('\n'));
  assert.ok(anime.description.includes('Bounty hunters'));
});

test('cleanDescription utility behavior', () => {
  assert.equal(cleanDescription('<b>Hello</b> & <i>world</i>'), 'Hello & world');
  assert.equal(cleanDescription('Line one<br>Line two</p><p>Line three'), 'Line one\nLine two\nLine three');
  assert.equal(cleanDescription('~!spoiler text!~ stays'), 'spoiler text stays');
  assert.equal(cleanDescription('&#039;quoted&#39; "text"'), "'quoted' \"text\"");
  assert.equal(cleanDescription(null), null);
  assert.equal(cleanDescription(undefined), null);
  assert.equal(cleanDescription('   '), null);
});

test('relations included when present; unusable relation nodes dropped', () => {
  const withRelations = normalizeAnilistAnime({
    ...fullMedia,
    relations: {
      nodes: [
        { id: 2, idMal: 2, relationType: 'SEQUEL', type: 'ANIME', format: 'TV', title: { romaji: 'Sequel' }, coverImage: { large: 'https://img.example/2.jpg' } },
        { idMal: 3, relationType: 'SIDE_STORY' }, // missing id -> dropped
        null, // junk node -> dropped
      ],
    },
  });
  assert.equal(withRelations.relations.length, 1);
  assert.equal(withRelations.relations[0].anilistId, 2);
  assert.equal(withRelations.relations[0].malId, 2);
  assert.equal(withRelations.relations[0].relationType, 'SEQUEL');
});

test('no relations in payload -> relations: []', () => {
  const anime = normalizeAnilistAnime({ ...fullMedia });
  assert.deepEqual(anime.relations, []);
});

test('malformed payload (null/missing id) -> ProviderError, never silent garbage', () => {
  assert.throws(() => normalizeAnilistAnime(null), ProviderError);
  assert.throws(() => normalizeAnilistAnime({}), ProviderError);
  assert.throws(() => normalizeAnilistAnime({ idMal: 5 }), ProviderError);
  assert.throws(() => normalizeAnilistAnime([1, 2]), ProviderError);
});

test('normalizeAnilistPage builds stable page shape and drops junk entries', () => {
  const page = normalizeAnilistPage({
    pageInfo: { total: 2, currentPage: 1, lastPage: 1, hasNextPage: false, perPage: 20 },
    media: [
      { id: 10, idMal: 10, title: { english: 'A' }, format: 'TV', status: 'FINISHED', coverImage: { large: 'https://img.example/a.jpg' }, bannerImage: 'https://img.example/b.jpg' },
      { idMal: 11 }, // missing id -> dropped
    ],
  });
  assert.equal(page.pageInfo.total, 2);
  assert.equal(page.pageInfo.hasNextPage, false);
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].anilistId, 10);
  // Card banners: genuine AniList bannerImage only (null when absent, never
  // the poster URL disguised as a banner).
  assert.equal(page.results[0].images.banner, 'https://img.example/b.jpg');
  assert.deepEqual(page.results[0].images, { poster: 'https://img.example/a.jpg', banner: 'https://img.example/b.jpg' });
});

test('media cards expose title variants; English preferred; missing variants stay null', () => {
  const page = normalizeAnilistPage({
    pageInfo: {},
    media: [
      // English available: preferred for the display title.
      { id: 1, idMal: 11, title: { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin', native: '進撃の巨人' } },
      // English missing/empty: display title falls back to Romaji, never "undefined"/"null".
      { id: 2, idMal: 12, title: { english: null, romaji: 'Romaji Only', native: '日本語' } },
      { id: 3, idMal: 13, title: { english: '   ', romaji: 'Whitespace English', native: null } },
      // No variants at all: explicit nulls.
      { id: 4, idMal: 14, title: {} },
    ],
  });

  assert.equal(page.results.length, 4);
  const [withEnglish, noEnglish, emptyEnglish, none] = page.results;

  // IDs/namespaces untouched by the title handling.
  assert.equal(withEnglish.id, 1);
  assert.equal(withEnglish.anilistId, 1);
  assert.equal(withEnglish.malId, 11);

  assert.equal(withEnglish.title, 'Attack on Titan');
  assert.equal(withEnglish.titleEnglish, 'Attack on Titan');
  assert.equal(withEnglish.titleRomaji, 'Shingeki no Kyojin');
  assert.equal(withEnglish.titleNative, '進撃の巨人');

  assert.equal(noEnglish.title, 'Romaji Only');
  assert.equal(noEnglish.titleEnglish, null);
  assert.equal(noEnglish.titleRomaji, 'Romaji Only');
  assert.equal(noEnglish.titleNative, '日本語');

  assert.equal(emptyEnglish.title, 'Whitespace English');
  assert.equal(emptyEnglish.titleEnglish, null);

  assert.equal(none.title, null);
  assert.equal(none.titleEnglish, null);
  assert.equal(none.titleRomaji, null);
  assert.equal(none.titleNative, null);
});

test('createBaseAnime yields the canonical skeleton', () => {
  const anime = createBaseAnime({ anilistId: 123, malId: 456 });
  assert.equal(anime.id, 123);
  assert.equal(anime.malId, 456);
  assert.deepEqual(anime.title, { romaji: null, english: null, native: null, userPreferred: null });
  assert.deepEqual(anime.images, { poster: null, cover: null, banner: null });
  assert.deepEqual(anime.genres, []);
  assert.deepEqual(anime.relations, []);
});
