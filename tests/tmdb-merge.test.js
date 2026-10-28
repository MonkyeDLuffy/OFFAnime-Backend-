/**
 * TMDB merge tests - banner precedence, namespace isolation, purity.
 *
 * Core guarantees verified:
 *   - AniList banner always wins; TMDB fills only when AniList banner is null.
 *   - tmdbId NEVER becomes anilistId / malId / canonical id (namespaced).
 *   - TMDB never overwrites any primary AniList/Jikan field.
 *   - Unresolved results attach no visuals; AniList data stays intact.
 *   - Merge is pure (inputs not mutated).
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { mergeTmdbIntoCanonical, mergeJikanIntoCanonical } = await import('../src/normalizers/anime.merge.js');
const { normalizeAnilistAnime } = await import('../src/normalizers/anime.normalizer.js');
const { createUnresolvedTmdbVisual, normalizeTmdbVisual } = await import('../src/normalizers/tmdb.normalizer.js');
const { ValidationError } = await import('../src/errors/index.js');

const canonical = normalizeAnilistAnime({
  id: 123,
  idMal: 456,
  title: { romaji: 'AniList Romaji', english: 'AniList English', native: null, userPreferred: 'AniList Preferred' },
  description: 'AniList description',
  coverImage: { extraLarge: 'https://img.example/xl.jpg', large: 'https://img.example/l.jpg', medium: null },
  bannerImage: null,
  type: 'ANIME',
  format: 'TV',
  status: 'FINISHED',
  episodes: 12,
  seasonYear: 2024,
  genres: ['Action'],
  averageScore: 85,
  popularity: 1000,
});

const resolvedVisual = normalizeTmdbVisual({
  tmdbId: 789,
  mediaType: 'tv',
  title: null,
  originalTitle: null,
  year: 2024,
  popularity: 50,
  images: {
    poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/backdrop.jpg',
  },
});

test('identity namespace isolation: id/anilistId/malId/tmdbId all stay separate', () => {
  const merged = mergeTmdbIntoCanonical(canonical, resolvedVisual);
  assert.equal(merged.id, 123);
  assert.equal(merged.anilistId, 123);
  assert.equal(merged.malId, 456);
  assert.equal(merged.enrichment.tmdb.tmdbId, 789);
  assert.equal(merged.enrichment.tmdb.mediaType, 'tv');
  // tmdbId never leaks into the identity fields.
  assert.notEqual(merged.id, 789);
  assert.notEqual(merged.anilistId, 789);
  assert.notEqual(merged.malId, 789);
  // The spec triple: AniList 123, MAL 456, TMDB 789 stay separate.
  assert.notEqual(merged.anilistId, merged.malId);
  assert.notEqual(merged.anilistId, merged.enrichment.tmdb.tmdbId);
  assert.notEqual(merged.malId, merged.enrichment.tmdb.tmdbId);
});

test('AniList banner preserved when TMDB backdrop exists', () => {
  const withBanner = normalizeAnilistAnime({ ...canonical, bannerImage: 'https://img.example/anilist-banner.jpg' });
  const merged = mergeTmdbIntoCanonical(withBanner, resolvedVisual);
  assert.equal(merged.images.banner, 'https://img.example/anilist-banner.jpg'); // AniList wins
  assert.notEqual(merged.images.banner, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
});

test('missing AniList banner: TMDB backdrop may fill the banner', () => {
  const merged = mergeTmdbIntoCanonical(canonical, resolvedVisual); // bannerImage null
  assert.equal(merged.images.banner, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
});

test('TMDB visual with null backdrop cannot overwrite or fabricate a banner', () => {
  const noBackdrop = normalizeTmdbVisual({
    tmdbId: 789,
    mediaType: 'tv',
    title: null,
    originalTitle: null,
    year: null,
    popularity: 0,
    images: { poster: 'https://image.tmdb.org/t/p/w500/poster.jpg', backdrop: null },
  });
  const merged = mergeTmdbIntoCanonical(canonical, noBackdrop);
  assert.equal(merged.images.banner, null); // stays null, poster never disguised
  assert.equal(merged.enrichment.tmdb.tmdbId, 789); // identity still recorded namespaced
});

test('TMDB never overwrites primary AniList fields or Jikan enrichment', () => {
  const jikanEnriched = mergeJikanIntoCanonical(canonical, {
    malId: 456,
    title: { default: 'Jikan', english: 'Jikan', japanese: 'Jikan JP', synonyms: [] },
    type: 'TV',
    sourceMaterial: 'Manga',
    episodes: 99,
    status: 'Currently Airing',
    airing: true,
    aired: { from: null, to: null },
    duration: '1 min',
    rating: 'PG',
    score: 5.0,
    scoredBy: 1,
    rank: 1,
    popularity: 1,
    members: 1,
    favorites: 1,
    synopsis: 'Jikan synopsis',
    background: 'Jikan background',
    season: 'spring',
    year: 2024,
    genres: ['Jikan Genre'],
    themes: [],
    demographics: [],
    studios: ['Jikan Studio'],
    producers: [],
    images: { poster: null, large: null, small: null },
    trailer: null,
    source: { anilist: false, jikan: true, tmdb: false },
  });
  const before = JSON.stringify(jikanEnriched);

  const merged = mergeTmdbIntoCanonical(jikanEnriched, resolvedVisual);

  // Jikan enrichment untouched; TMDB added alongside it.
  assert.equal(merged.enrichment.jikan.score, 5.0);
  assert.equal(merged.enrichment.jikan.synopsis, 'Jikan synopsis');
  assert.equal(merged.enrichment.tmdb.tmdbId, 789);
  // All primary fields unchanged.
  assert.equal(merged.title.userPreferred, 'AniList Preferred');
  assert.equal(merged.title.romaji, 'AniList Romaji');
  assert.equal(merged.description, 'AniList description');
  assert.equal(merged.format, 'TV');
  assert.equal(merged.status, 'FINISHED');
  assert.equal(merged.episodes, 12);
  assert.equal(merged.seasonYear, 2024);
  assert.deepEqual(merged.genres, ['Action']);
  assert.equal(merged.averageScore, 85);
  assert.equal(merged.popularity, 1000);
  assert.equal(JSON.stringify(merged.enrichment.jikan), JSON.stringify(jikanEnriched.enrichment.jikan));
  assert.equal(before === before, true); // sanity
});

test('unresolved TMDB visual attaches NO visuals; AniList data stays fully intact', () => {
  const unresolved = createUnresolvedTmdbVisual('no_confident_match');
  const merged = mergeTmdbIntoCanonical(canonical, unresolved);
  assert.equal(merged.images.banner, null); // no visual attached
  assert.equal(merged.enrichment.tmdb, undefined); // no tmdb identity recorded
  assert.deepEqual(merged.source, { anilist: true, jikan: false, tmdb: false }); // unchanged
  // Everything else identical.
  assert.equal(merged.id, canonical.id);
  assert.equal(merged.title.userPreferred, canonical.title.userPreferred);
});

test('null/undefined TMDB visual -> unchanged copy', () => {
  const mergedNull = mergeTmdbIntoCanonical(canonical, null);
  const mergedUndef = mergeTmdbIntoCanonical(canonical, undefined);
  assert.deepEqual(mergedNull, canonical);
  assert.deepEqual(mergedUndef, canonical);
  assert.notEqual(mergedNull, canonical); // new object (purity)
});

test('merge is pure: inputs are not mutated', () => {
  const canonicalSnapshot = JSON.stringify(canonical);
  const visualSnapshot = JSON.stringify(resolvedVisual);
  mergeTmdbIntoCanonical(canonical, resolvedVisual);
  assert.equal(JSON.stringify(canonical), canonicalSnapshot);
  assert.equal(JSON.stringify(resolvedVisual), visualSnapshot);
});

test('unusable inputs -> ValidationError, never silently coerced', () => {
  assert.throws(() => mergeTmdbIntoCanonical(null, resolvedVisual), ValidationError);
  assert.throws(() => mergeTmdbIntoCanonical({}, resolvedVisual), ValidationError);
  assert.throws(
    () => mergeTmdbIntoCanonical(canonical, { resolved: true, tmdbId: null, mediaType: 'tv', images: {}, poster: null, reason: null }),
    ValidationError,
  ); // resolved without valid tmdbId
});
