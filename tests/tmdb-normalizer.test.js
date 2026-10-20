/**
 * TMDB normalizer + conservative matcher tests.
 *
 * All fixtures are mocked; no live API calls. Verifies URL construction from
 * actual paths only, identity namespace isolation (tmdbId only), and the
 * deterministic conservative matching strategy.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeTmdbCandidate,
  normalizeTmdbCandidates,
  normalizeTmdbVisual,
  createUnresolvedTmdbVisual,
} = await import('../src/normalizers/tmdb.normalizer.js');
const {
  normalizeTitleForComparison,
  extractKnownTitles,
  selectBestMatch,
} = await import('../src/normalizers/tmdb.matching.js');
const { tmdbImageUrl } = await import('../src/providers/tmdb/tmdb.queries.js');

// --- URL construction -----------------------------------------------------------

test('image URLs built ONLY from actual TMDB paths; null paths -> null (never fabricated)', () => {
  assert.equal(tmdbImageUrl('/abc.jpg'), 'https://image.tmdb.org/t/p/original/abc.jpg');
  assert.equal(tmdbImageUrl('/abc.jpg', 'w500'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.equal(tmdbImageUrl(null), null);
  assert.equal(tmdbImageUrl(undefined), null);
  assert.equal(tmdbImageUrl(''), null);
  assert.equal(tmdbImageUrl(123), null);
});

// --- Normalization -----------------------------------------------------------

const rawTv = {
  id: 789,
  name: 'One Punch Man',
  original_name: 'ワンパンマン',
  first_air_date: '2015-10-04',
  popularity: 250.5,
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
};

test('valid candidate: normalized shape with tmdbId ONLY (no anilistId/malId/id)', () => {
  const candidate = normalizeTmdbCandidate(rawTv, 'tv');
  assert.deepEqual(candidate, {
    tmdbId: 789,
    mediaType: 'tv',
    title: 'One Punch Man',
    originalTitle: 'ワンパンマン',
    year: 2015,
    popularity: 250.5,
    images: {
      poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      backdrop: 'https://image.tmdb.org/t/p/original/backdrop.jpg',
    },
  });
  assert.equal('anilistId' in candidate, false);
  assert.equal('malId' in candidate, false);
  assert.equal('id' in candidate, false);
});

test('missing poster/backdrop paths -> null image URLs (never fabricated)', () => {
  const candidate = normalizeTmdbCandidate({ ...rawTv, poster_path: null, backdrop_path: null });
  assert.equal(candidate.images.poster, null);
  assert.equal(candidate.images.backdrop, null);
});

test('missing id -> candidate dropped (never fabricates)', () => {
  assert.equal(normalizeTmdbCandidate({ name: 'no id' }), null);
  assert.equal(normalizeTmdbCandidate(null), null);
  assert.equal(normalizeTmdbCandidates({ results: [{ name: 'x' }, rawTv] }).length, 1);
});

test('movie date extraction uses release_date; media_type respected', () => {
  const movie = normalizeTmdbCandidate(
    { id: 129, title: 'Spirited Away', release_date: '2001-07-20' },
    'movie',
  );
  assert.equal(movie.mediaType, 'movie');
  assert.equal(movie.year, 2001);
  assert.equal(movie.title, 'Spirited Away');
});

test('unusual year values -> null (never guessed)', () => {
  assert.equal(normalizeTmdbCandidate({ ...rawTv, first_air_date: null }).year, null);
  assert.equal(normalizeTmdbCandidate({ ...rawTv, first_air_date: 'garbage' }).year, null);
});

test('resolved visual from candidate: backdrop/banner from actual backdrop path only', () => {
  const visual = normalizeTmdbVisual(normalizeTmdbCandidate(rawTv, 'tv'), { strategy: 'title' });
  assert.equal(visual.resolved, true);
  assert.equal(visual.tmdbId, 789);
  assert.equal(visual.images.backdrop, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
  assert.equal(visual.images.banner, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
  // A poster is NEVER turned into a backdrop/banner.
  assert.notEqual(visual.images.banner, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  // Season fields start unresolved (the service derives them from evidence);
  // match provenance is attached.
  assert.equal(visual.tmdbSeasonNumber, null);
  assert.equal(visual.season, null);
  assert.equal(visual.matchedTitle, 'One Punch Man');
  assert.equal(visual.matchStrategy, 'title');
});

test('unresolved visual: valid result with reason, no fabricated data', () => {
  const unresolved = createUnresolvedTmdbVisual('no_confident_match');
  assert.deepEqual(unresolved, {
    resolved: false,
    tmdbId: null,
    mediaType: null,
    images: null,
    poster: null,
    tmdbSeasonNumber: null,
    season: null,
    matchedTitle: null,
    matchStrategy: null,
    reason: 'no_confident_match',
  });
});

// --- Matching: normalizeTitleForComparison ---------------------------------------

test('title normalization: trim, case-fold, whitespace, punctuation; non-latin preserved', () => {
  assert.equal(normalizeTitleForComparison('  One Punch Man  '), 'one punch man');
  assert.equal(normalizeTitleForComparison('ONE   PUNCH   MAN'), 'one punch man');
  assert.equal(normalizeTitleForComparison("One-Punch Man: Season 2!"), 'one punch man season 2');
  assert.equal(normalizeTitleForComparison('ワンパンマン'), 'ワンパンマン'); // CJK preserved for matching
  assert.equal(normalizeTitleForComparison(null), '');
  assert.equal(normalizeTitleForComparison(123), '');
});

// --- Matching: extractKnownTitles ------------------------------------------------

test('known titles: AniList-first priority, deduplicated, Jikan variants included', () => {
  const canonical = {
    title: { userPreferred: 'One Punch Man', english: 'One-Punch Man', romaji: 'Wanpanman', native: null },
    enrichment: {
      jikan: {
        title: { english: 'One-Punch Man', japanese: 'ワンパンマン', synonyms: ['OPM'] },
      },
    },
  };
  assert.deepEqual(extractKnownTitles(canonical), [
    'One Punch Man', // userPreferred first
    // 'One-Punch Man' deduped (same normalized form for matching)
    'Wanpanman',
    'ワンパンマン',
    'OPM',
  ]);
});

test('known titles: empty metadata -> []', () => {
  assert.deepEqual(extractKnownTitles({}), []);
  assert.deepEqual(extractKnownTitles(null), []);
});

// --- Matching: selectBestMatch (layered: full/base titles, year, media type) -----

const makeCandidate = (over = {}) => ({
  tmdbId: 1,
  mediaType: 'tv',
  title: null,
  originalTitle: null,
  year: null,
  popularity: 0,
  images: { poster: null, backdrop: null },
  ...over,
});

test('exact title match accepted', () => {
  const candidates = [makeCandidate({ tmdbId: 1, title: 'One Punch Man' })];
  const match = selectBestMatch(candidates, { titles: ['One Punch Man'], year: null });
  assert.equal(match.candidate.tmdbId, 1);
  assert.equal(match.strategy, 'title');
});

test('case-insensitive match accepted', () => {
  const candidates = [makeCandidate({ tmdbId: 2, title: 'one punch man' })];
  assert.equal(selectBestMatch(candidates, { titles: ['One Punch Man'] }).candidate.tmdbId, 2);
});

test('whitespace and punctuation normalization in matching', () => {
  const candidates = [makeCandidate({ tmdbId: 3, title: 'one-punch man' })];
  assert.equal(selectBestMatch(candidates, { titles: ['One   Punch  Man'] }).candidate.tmdbId, 3);
});

test('alternate (original) title match accepted', () => {
  const candidates = [makeCandidate({ tmdbId: 4, originalTitle: 'ワンパンマン' })];
  assert.equal(selectBestMatch(candidates, { titles: ['One Punch Man', 'ワンパンマン'] }).candidate.tmdbId, 4);
});

test('wrong title rejected (never forced)', () => {
  const candidates = [
    makeCandidate({ tmdbId: 5, title: 'Anime B' }),
    makeCandidate({ tmdbId: 6, title: 'Anime C' }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'] }), null);
});

test('year-compatible match accepted', () => {
  const candidates = [makeCandidate({ tmdbId: 7, title: 'Anime A', year: 2015 })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2015 }).candidate.tmdbId, 7);
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2016 }).candidate.tmdbId, 7);
});

test('TV year rule: candidate premiering AFTER the entry is rejected (never a later reboot)', () => {
  const candidates = [makeCandidate({ tmdbId: 8, title: 'Anime A', year: 2011 })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 1999 }), null);
});

test('TV year rule: candidate premiering YEARS BEFORE the entry is a valid later season', () => {
  // One-Punch Man S2 (2019) -> series premiered 2015 (shared TMDB series).
  const candidates = [makeCandidate({ tmdbId: 9, title: 'Anime A', year: 2003 })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A 2'], year: 2018 }).candidate.tmdbId, 9);
});

test('MOVIE year rule: strict +/-1 (a movie IS the entry)', () => {
  const candidates = [makeCandidate({ tmdbId: 10, title: 'Anime A', year: 2003, mediaType: 'movie' })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2018, mediaType: 'movie' }), null);
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2004, mediaType: 'movie' }).candidate.tmdbId, 10);
});

test('candidate with unknown year is not rejected (never guessed)', () => {
  const candidates = [makeCandidate({ tmdbId: 11, title: 'Anime A', year: null })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2018 }).candidate.tmdbId, 11);
});

test('multiple candidates: popularity is a tie-breaker ONLY among equal title rank', () => {
  const candidates = [
    makeCandidate({ tmdbId: 12, title: 'Anime A', popularity: 50 }),
    makeCandidate({ tmdbId: 13, title: 'Anime A', popularity: 90 }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'] }).candidate.tmdbId, 13);
});

test('multiple candidates: primary title match preferred over alternate', () => {
  const candidates = [
    makeCandidate({ tmdbId: 14, originalTitle: 'ワンパンマン', popularity: 999 }), // alternate match
    makeCandidate({ tmdbId: 15, title: 'One Punch Man', popularity: 10 }), // primary match
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['One Punch Man', 'ワンパンマン'] }).candidate.tmdbId, 15);
});

test('ambiguous candidates: same title different years -> year proximity resolves', () => {
  const candidates = [
    makeCandidate({ tmdbId: 16, title: 'Anime A', year: 1999 }),
    makeCandidate({ tmdbId: 17, title: 'Anime A', year: 2018 }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2018 }).candidate.tmdbId, 17);
});

test('no acceptable candidate -> null (missing banner beats wrong banner)', () => {
  const candidates = [
    makeCandidate({ tmdbId: 18, title: 'Unrelated Show', year: 1990 }),
    makeCandidate({ tmdbId: 19, title: 'Another Unrelated', year: 2020 }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2018 }), null);
  assert.equal(selectBestMatch([], { titles: ['Anime A'] }), null);
  assert.equal(selectBestMatch([makeCandidate({ title: 'Anime A' })], { titles: [] }), null);
});

test('media type incompatibility rejected', () => {
  const candidates = [makeCandidate({ tmdbId: 20, title: 'Anime A', mediaType: 'movie' })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], mediaType: 'tv' }), null);
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], mediaType: 'movie' }).candidate.tmdbId, 20);
});
