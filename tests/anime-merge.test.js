/**
 * Merge tests - explicit AniList-primary precedence for Jikan enrichment.
 *
 * Core guarantees verified:
 *   - AniList identity is NEVER overwritten (id, anilistId, userPreferred).
 *   - Jikan fills malId ONLY when canonical malId is null.
 *   - Primary fields: AniList wins; Jikan fills only null/empty fields.
 *   - Banner is NEVER filled from Jikan (no fake banners).
 *   - Jikan-only details live namespaced under enrichment.jikan.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { mergeJikanIntoCanonical } = await import('../src/normalizers/anime.merge.js');
const { normalizeAnilistAnime, normalizeJikanAnime, createBaseAnime } = await import('../src/normalizers/anime.normalizer.js');
const { ValidationError } = await import('../src/errors/index.js');

const anilistRaw = {
  id: 123,
  idMal: null, // AniList does not know the MAL ID
  title: { romaji: 'AniList Romaji', english: null, native: null, userPreferred: 'AniList Preferred' },
  description: 'AniList description',
  coverImage: { extraLarge: 'https://img.example/xl.jpg', large: 'https://img.example/l.jpg', medium: null },
  bannerImage: null,
  type: 'ANIME',
  format: 'TV',
  status: 'FINISHED',
  episodes: 12,
  season: 'SPRING',
  seasonYear: 2024,
  genres: ['Action'],
  synonyms: null,
  studios: { nodes: [{ name: 'AniList Studio' }] },
  startDate: { year: 2024, month: 4, day: 1 },
  endDate: null,
  averageScore: 85,
  popularity: 1000,
};
const anilistAnime = normalizeAnilistAnime(anilistRaw);

const jikanRaw = {
  mal_id: 456,
  title: 'Jikan Default',
  title_english: 'Jikan English',
  title_japanese: 'Jikan Japanese',
  title_synonyms: ['Jikan Synonym'],
  type: 'TV',
  source: 'Manga',
  episodes: 12,
  status: 'Currently Airing',
  airing: true,
  aired: { from: '2024-04-01T00:00:00+00:00', to: null },
  duration: '23 min per ep',
  rating: 'PG-13',
  score: 7.9,
  scored_by: 5000,
  rank: 500,
  popularity: 800,
  members: 90000,
  favorites: 700,
  synopsis: 'Jikan synopsis',
  background: 'Jikan background',
  season: 'spring',
  year: 2024,
  genres: [{ mal_id: 1, name: 'Action' }, { mal_id: 2, name: 'Adventure' }],
  themes: [{ mal_id: 50, name: 'Space' }],
  demographics: [{ mal_id: 42, name: 'Seinen' }],
  studios: [{ mal_id: 14, name: 'Jikan Studio' }],
  producers: [{ mal_id: 16, name: 'Jikan Producer' }],
  images: { jpg: { image_url: 'https://jikan.example/p.jpg', large_image_url: 'https://jikan.example/l.jpg' }, webp: {} },
  trailer: { youtube_id: 'abc123', url: 'https://www.youtube.com/watch?v=abc123', embed_url: 'https://www.youtube.com/embed/abc123' },
};
const jikanAnime = normalizeJikanAnime(jikanRaw);

test('AniList identity preserved: id/anilistId untouched, never Jikan malId', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(merged.id, 123);
  assert.equal(merged.anilistId, 123);
  assert.notEqual(merged.id, 456);
  assert.notEqual(merged.anilistId, 456);
});

test('AniList malId preserved when already known; Jikan malId fills when null', () => {
  const mergedNull = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(mergedNull.malId, 456); // filled because AniList had none

  const anilistWithMal = normalizeAnilistAnime({ ...anilistRaw, idMal: 999 });
  const mergedKnown = mergeJikanIntoCanonical(anilistWithMal, jikanAnime);
  assert.equal(mergedKnown.malId, 999); // AniList malId wins
  assert.notEqual(mergedKnown.malId, 456);
});

test('AniList title preserved; Jikan fills only missing variants; userPreferred never overwritten', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(merged.title.romaji, 'AniList Romaji'); // AniList wins
  assert.equal(merged.title.userPreferred, 'AniList Preferred'); // never overwritten
  assert.equal(merged.title.english, 'Jikan English'); // filled (AniList had none)
  assert.equal(merged.title.native, 'Jikan Japanese'); // filled (AniList had none)
});

test('AniList description/poster/cover preserved; Jikan fills only missing', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(merged.description, 'AniList description'); // AniList wins
  assert.equal(merged.images.poster, 'https://img.example/xl.jpg'); // AniList wins
  assert.equal(merged.images.cover, 'https://img.example/l.jpg'); // AniList wins

  // Missing poster/cover/description get filled from Jikan.
  const sparse = normalizeAnilistAnime({ ...anilistRaw, coverImage: null, description: null });
  const mergedSparse = mergeJikanIntoCanonical(sparse, jikanAnime);
  assert.equal(mergedSparse.images.poster, 'https://jikan.example/l.jpg');
  assert.equal(mergedSparse.images.cover, 'https://jikan.example/l.jpg');
  assert.equal(mergedSparse.description, 'Jikan synopsis');
});

test('banner NEVER filled from Jikan (no fake banners)', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(merged.images.banner, null); // Jikan provided images but no banner field
  assert.notEqual(merged.images.banner, 'https://jikan.example/l.jpg');
});

test('AniList primary fields win; Jikan fills only missing (status/episodes/format/season)', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(merged.format, 'TV'); // AniList wins (both "TV" anyway)
  assert.equal(merged.episodes, 12); // AniList wins
  assert.equal(merged.season, 'SPRING'); // AniList wins (casing preserved)
  assert.equal(merged.seasonYear, 2024);

  const sparse = normalizeAnilistAnime({
    ...anilistRaw,
    status: null,
    episodes: null,
    format: null,
    season: null,
    seasonYear: null,
  });
  const mergedSparse = mergeJikanIntoCanonical(sparse, jikanAnime);
  assert.equal(mergedSparse.status, 'Currently Airing'); // filled from Jikan
  assert.equal(mergedSparse.episodes, 12);
  assert.equal(mergedSparse.format, 'TV');
  assert.equal(mergedSparse.season, 'spring'); // honest Jikan value
  assert.equal(mergedSparse.seasonYear, 2024);
});

test('AniList lists win unless empty; Jikan fills empty lists', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.deepEqual(merged.genres, ['Action']); // AniList wins
  assert.deepEqual(merged.studios, ['AniList Studio']); // AniList wins

  const sparse = normalizeAnilistAnime({ ...anilistRaw, genres: [], studios: null, synonyms: null });
  const mergedSparse = mergeJikanIntoCanonical(sparse, jikanAnime);
  assert.deepEqual(mergedSparse.genres, ['Action', 'Adventure']); // filled from Jikan
  assert.deepEqual(mergedSparse.studios, ['Jikan Studio']);
  assert.deepEqual(mergedSparse.synonyms, ['Jikan Synonym']);
});

test('scores are NOT merged across scales (AniList 0-100 vs MAL 0-10); Jikan details live in enrichment', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.equal(merged.averageScore, 85); // AniList untouched
  assert.equal(merged.popularity, 1000); // AniList untouched
  assert.equal(merged.enrichment.jikan.score, 7.9); // MAL scale, namespaced
  assert.equal(merged.enrichment.jikan.background, 'Jikan background');
  assert.equal(merged.enrichment.jikan.trailer.youtubeId, 'abc123');
  assert.equal(merged.enrichment.jikan.sourceMaterial, 'Manga');
  assert.equal(merged.enrichment.jikan.themes.length, 1);
});

test('provenance records jikan: true while keeping anilist flag', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.deepEqual(merged.source, { anilist: true, jikan: true, tmdb: false });
});

test('merge is pure: inputs are not mutated', () => {
  const original = normalizeAnilistAnime(anilistRaw);
  const jikanBefore = JSON.stringify(jikanAnime);
  mergeJikanIntoCanonical(original, jikanAnime);
  assert.equal(original.malId, null); // canonical unchanged
  assert.equal(JSON.stringify(jikanAnime), jikanBefore);
});

test('relations and dates remain AniList-only', () => {
  const merged = mergeJikanIntoCanonical(anilistAnime, jikanAnime);
  assert.deepEqual(merged.startDate, '2024-04-01');
  assert.equal(merged.endDate, null);
  assert.deepEqual(merged.relations, []);
});

test('unusable inputs -> ValidationError, never silently coerced', () => {
  assert.throws(() => mergeJikanIntoCanonical(null, jikanAnime), ValidationError);
  assert.throws(() => mergeJikanIntoCanonical(createBaseAnime({ malId: 456 }), jikanAnime), ValidationError); // no AniList identity
  assert.throws(() => mergeJikanIntoCanonical(anilistAnime, null), ValidationError);
  assert.throws(() => mergeJikanIntoCanonical(anilistAnime, { malId: 1 }), ValidationError); // not normalized Jikan
});

test('full end-to-end: createBaseAnime + normalized sources -> enriched canonical', () => {
  const base = createBaseAnime({ anilistId: 1 });
  const merged = mergeJikanIntoCanonical(base, jikanAnime);
  assert.equal(merged.id, 1);
  assert.equal(merged.malId, 456); // filled
  assert.equal(merged.enrichment.jikan.malId, 456);
  assert.deepEqual(merged.source, { anilist: false, jikan: true, tmdb: false });
});
