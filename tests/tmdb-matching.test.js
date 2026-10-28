/**
 * TMDB season-aware matching tests (pure functions - no HTTP):
 *
 *   stripSeasonSuffix / stripSeasonSuffixDeep / extractTitleSeasonNumber /
 *   deriveTmdbSeasonNumber / selectBestMatch layered strategy.
 *
 * All fixtures mirror REAL verified AniList/TMDB metadata shapes (Black
 * Clover, One-Punch Man, Overlord, Fruits Basket) - never invented IDs for
 * expected matches, only synthetic stand-ins with the same structure.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeTitleForComparison,
  stripSeasonSuffix,
  stripSeasonSuffixDeep,
  extractTitleSeasonNumber,
  deriveTmdbSeasonNumber,
  selectBestMatch,
} = await import('../src/normalizers/tmdb.matching.js');

// --- title normalization ---------------------------------------------------------

test('normalizeTitleForComparison strips trailing sequel punctuation', () => {
  assert.equal(normalizeTitleForComparison('Kaguya-sama: Love is War?'), 'kaguya sama love is war');
  assert.equal(normalizeTitleForComparison('Kaguya-sama: Love Is War'), 'kaguya sama love is war');
  assert.equal(normalizeTitleForComparison('Kono Subarashii Sekai ni Shukufuku wo!'), 'kono subarashii sekai ni shukufuku wo');
  assert.equal(normalizeTitleForComparison('Haikyu!!'), 'haikyu');
  // Interior punctuation is preserved as a separator (CJK must stay matchable).
  assert.equal(normalizeTitleForComparison('ワンパンマン'), 'ワンパンマン');
});

// --- season suffix stripping -------------------------------------------------------

test('stripSeasonSuffix strips one trailing season/sequel suffix', () => {
  assert.equal(stripSeasonSuffix('Black Clover 2nd Season'), 'Black Clover');
  assert.equal(stripSeasonSuffix('Black Clover Season 2'), 'Black Clover');
  assert.equal(stripSeasonSuffix('One Punch Man 2'), 'One Punch Man');
  assert.equal(stripSeasonSuffix('Overlord II'), 'Overlord');
  assert.equal(stripSeasonSuffix('Overlord III'), 'Overlord');
  assert.equal(stripSeasonSuffix('Fruits Basket 2nd Season'), 'Fruits Basket');
  assert.equal(stripSeasonSuffix('Shingeki no Kyojin Season 2 Part 1'), 'Shingeki no Kyojin Season 2');
  // Untouched titles pass through unchanged.
  assert.equal(stripSeasonSuffix('Black Clover'), 'Black Clover');
  assert.equal(stripSeasonSuffix('86'), '86'); // suffix must never consume the whole title
  assert.equal(stripSeasonSuffix('Kaguya-sama: Love is War -Ultra Romantic-'), 'Kaguya-sama: Love is War -Ultra Romantic-');
  assert.equal(stripSeasonSuffix(null), '');
});

test('stripSeasonSuffixDeep reduces chained suffixes to the franchise base', () => {
  assert.equal(stripSeasonSuffixDeep('One Punch Man Season 3 Part 2'), 'One Punch Man');
  assert.equal(stripSeasonSuffixDeep('Attack on Titan The Final Season Part 2'), 'Attack on Titan');
  assert.equal(stripSeasonSuffixDeep('Fruits Basket The Final'), 'Fruits Basket');
  assert.equal(stripSeasonSuffixDeep('One Punch Man 2'), 'One Punch Man');
  assert.equal(stripSeasonSuffixDeep('Attack on Titan'), 'Attack on Titan');
});

// --- season-number title evidence ---------------------------------------------------

test('extractTitleSeasonNumber reads sequel numbering from titles', () => {
  assert.equal(extractTitleSeasonNumber('Black Clover 2nd Season'), 2);
  assert.equal(extractTitleSeasonNumber('Black Clover Season 2'), 2);
  assert.equal(extractTitleSeasonNumber('One Punch Man 2'), 2);
  assert.equal(extractTitleSeasonNumber('One-Punch Man Season 3'), 3);
  assert.equal(extractTitleSeasonNumber('Overlord II'), 2);
  assert.equal(extractTitleSeasonNumber('Overlord IV'), 4);
  assert.equal(extractTitleSeasonNumber('Kono Subarashii Sekai ni Shukufuku wo! 3'), 3);
  assert.equal(extractTitleSeasonNumber('Shingeki no Kyojin Season 2 Part 1'), 2);
  assert.equal(extractTitleSeasonNumber('Attack on Titan The Final Season Part 2'), 2); // cours evidence (validated later)
  assert.equal(extractTitleSeasonNumber('Black Clover'), null);
  assert.equal(extractTitleSeasonNumber('Kaguya-sama: Love is War -Ultra Romantic-'), null);
  assert.equal(extractTitleSeasonNumber('86'), null);
  assert.equal(extractTitleSeasonNumber(null), null);
});

// --- season derivation (title/year evidence vs TMDB seasons) -------------------------

const seasons = [
  { seasonNumber: 0, name: 'Specials', airDate: '2016-11-27', posterPath: null, poster: null, episodeCount: 2 },
  { seasonNumber: 1, name: 'Season 1', airDate: '2017-10-03', posterPath: null, poster: null, episodeCount: 170 },
  { seasonNumber: 2, name: 'Season 2', airDate: '2026-10-03', posterPath: null, poster: null, episodeCount: 26 },
];

test('deriveTmdbSeasonNumber: title evidence validated against TMDB season air year', () => {
  // Black Clover S2 (2026): title says 2, TMDB season 2 airs 2026.
  assert.equal(deriveTmdbSeasonNumber({ seasons, titleSeasonNumber: 2, entryYear: 2026, seriesStartYear: 2017 }), 2);
  // Title number that contradicts the year evidence falls through.
  assert.equal(deriveTmdbSeasonNumber({ seasons, titleSeasonNumber: 1, entryYear: 2026, seriesStartYear: 2017 }), null);
});

test('deriveTmdbSeasonNumber: year evidence picks the uniquely closest season', () => {
  // Kaguya-style: suffix-less sequel title, year evidence disambiguates.
  const kaguyaSeasons = [
    { seasonNumber: 1, airDate: '2019-01-10' },
    { seasonNumber: 2, airDate: '2020-04-11' },
    { seasonNumber: 3, airDate: '2022-04-09' },
  ];
  assert.equal(deriveTmdbSeasonNumber({ seasons: kaguyaSeasons, titleSeasonNumber: null, entryYear: 2020 }), 2);
  assert.equal(deriveTmdbSeasonNumber({ seasons: kaguyaSeasons, titleSeasonNumber: null, entryYear: 2022 }), 3);
  assert.equal(deriveTmdbSeasonNumber({ seasons: kaguyaSeasons, titleSeasonNumber: null, entryYear: 2019 }), 1);
});

test('deriveTmdbSeasonNumber: cours splits resolve via year evidence (never entry numbering)', () => {
  // AoT-style: "The Final Season Part 2" (2021) extracts cours number 2, but
  // TMDB season 2 aired 2017 -> title evidence rejected; year evidence wins.
  const aotSeasons = [
    { seasonNumber: 1, airDate: '2013-04-07' },
    { seasonNumber: 2, airDate: '2017-04-01' },
    { seasonNumber: 3, airDate: '2018-07-22' },
    { seasonNumber: 4, airDate: '2020-12-06' },
  ];
  assert.equal(deriveTmdbSeasonNumber({ seasons: aotSeasons, titleSeasonNumber: 2, entryYear: 2021, seriesStartYear: 2013 }), 4);
});

test('deriveTmdbSeasonNumber: honest nulls for missing/ambiguous evidence', () => {
  // Overlord II/III both aired 2018 - a tie without title evidence stays null.
  const overlordSeasons = [
    { seasonNumber: 1, airDate: '2015-07-07' },
    { seasonNumber: 2, airDate: '2018-01-09' },
    { seasonNumber: 3, airDate: '2018-07-10' },
    { seasonNumber: 4, airDate: '2022-07-05' },
  ];
  assert.equal(deriveTmdbSeasonNumber({ seasons: overlordSeasons, titleSeasonNumber: null, entryYear: 2018 }), null);
  // With roman-numeral title evidence the tie is resolved confidently.
  assert.equal(deriveTmdbSeasonNumber({ seasons: overlordSeasons, titleSeasonNumber: 2, entryYear: 2018 }), 2);
  assert.equal(deriveTmdbSeasonNumber({ seasons: overlordSeasons, titleSeasonNumber: 3, entryYear: 2018 }), 3);
  assert.equal(deriveTmdbSeasonNumber({ seasons: overlordSeasons, titleSeasonNumber: 4, entryYear: 2022 }), 4);
  // No entry year and no title evidence -> null. Specials-only -> null.
  assert.equal(deriveTmdbSeasonNumber({ seasons, titleSeasonNumber: null, entryYear: null }), null);
  assert.equal(deriveTmdbSeasonNumber({ seasons: [{ seasonNumber: 0, airDate: '2016-11-27' }], titleSeasonNumber: 1, entryYear: 2017 }), null);
  assert.equal(deriveTmdbSeasonNumber({ seasons: [], titleSeasonNumber: 1, entryYear: 2017 }), null);
  // Upcoming seasons without an air date never disqualify title evidence.
  const upcoming = [{ seasonNumber: 1, airDate: '2017-10-03' }, { seasonNumber: 2, airDate: null }];
  assert.equal(deriveTmdbSeasonNumber({ seasons: upcoming, titleSeasonNumber: 2, entryYear: 2026 }), 2);
});

// --- layered candidate selection ------------------------------------------------------

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

test('selectBestMatch: full-title match wins with strategy "title"', () => {
  const match = selectBestMatch([makeCandidate({ tmdbId: 10, title: 'Black Clover', year: 2017 })], {
    titles: ['Black Clover'], year: 2017, mediaType: 'tv',
  });
  assert.equal(match.candidate.tmdbId, 10);
  assert.equal(match.strategy, 'title');
});

test('selectBestMatch: sequel entry matches the SHARED series via its base title', () => {
  // AniList "Black Clover 2nd Season" (2026) -> TMDB "Black Clover" (2017).
  const match = selectBestMatch([makeCandidate({ tmdbId: 73223, title: 'Black Clover', year: 2017 })], {
    titles: ['Black Clover 2nd Season', 'Black Clover Season 2'], year: 2026, mediaType: 'tv',
  });
  assert.equal(match.candidate.tmdbId, 73223);
  assert.equal(match.strategy, 'title_base');
});

test('selectBestMatch: TV candidate may premiere years BEFORE the entry (later season)', () => {
  // One-Punch Man S2 (2019) -> series premiered 2015.
  const match = selectBestMatch([makeCandidate({ tmdbId: 63926, title: 'One-Punch Man', year: 2015 })], {
    titles: ['One Punch Man 2', 'One-Punch Man Season 2'], year: 2019, mediaType: 'tv',
  });
  assert.equal(match.candidate.tmdbId, 63926);
});

test('selectBestMatch: TV candidate premiering AFTER the entry is rejected (old entry never matches a reboot)', () => {
  // "Hunter x Hunter" 1999 entry must not resolve to the 2011 reboot.
  const match = selectBestMatch(
    [makeCandidate({ tmdbId: 46298, title: 'Hunter x Hunter', year: 2011 })],
    { titles: ['Hunter x Hunter'], year: 1999, mediaType: 'tv' },
  );
  assert.equal(match, null);
});

test('selectBestMatch: MOVIE candidates keep the strict +/-1 year rule', () => {
  const candidates = [makeCandidate({ tmdbId: 20, title: 'Anime Movie', mediaType: 'movie', year: 2015 })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime Movie'], year: 2015, mediaType: 'movie' }).candidate.tmdbId, 20);
  assert.equal(selectBestMatch(candidates, { titles: ['Anime Movie'], year: 2016, mediaType: 'movie' }).candidate.tmdbId, 20);
  assert.equal(selectBestMatch(candidates, { titles: ['Anime Movie'], year: 2019, mediaType: 'movie' }), null);
});

test('selectBestMatch: same-name reboots disambiguated by year proximity', () => {
  // Fruits Basket (2001) vs Fruits Basket (2019) - both match by title.
  const candidates = [
    makeCandidate({ tmdbId: 30001, title: 'Fruits Basket', year: 2001 }),
    makeCandidate({ tmdbId: 30002, title: 'Fruits Basket', year: 2019 }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Fruits Basket'], year: 2019, mediaType: 'tv' }).candidate.tmdbId, 30002);
  assert.equal(selectBestMatch(candidates, { titles: ['Fruits Basket'], year: 2001, mediaType: 'tv' }).candidate.tmdbId, 30001);
  // A 2nd-season entry (2020) also lands on the 2019 series.
  assert.equal(selectBestMatch(candidates, { titles: ['Fruits Basket 2nd Season'], year: 2020, mediaType: 'tv' }).candidate.tmdbId, 30002);
});

test('selectBestMatch: full-title match (via native title) beats a base-title impostor', () => {
  // Overlord IV (2022): the true series matches the native title (full tier);
  // an unrelated same-named series only base-matches and is closer in years -
  // the title tier MUST dominate year proximity.
  const candidates = [
    makeCandidate({ tmdbId: 64196, title: 'Overlord', originalTitle: 'オーバーロード', year: 2015, popularity: 400 }),
    makeCandidate({ tmdbId: 111993, title: 'Overlord', originalTitle: '九流霸主', year: 2020, popularity: 30 }),
  ];
  const match = selectBestMatch(candidates, {
    titles: ['Overlord IV', 'Overlord 4', 'オーバーロード IV'], year: 2022, mediaType: 'tv',
  });
  assert.equal(match.candidate.tmdbId, 64196);
});

test('selectBestMatch: unknown candidate year never disqualifies; popularity stays a tie-breaker', () => {
  assert.equal(
    selectBestMatch([makeCandidate({ tmdbId: 9, title: 'Anime A', year: null })], { titles: ['Anime A'], year: 2018, mediaType: 'tv' }).candidate.tmdbId,
    9,
  );
  const candidates = [
    makeCandidate({ tmdbId: 10, title: 'Anime A', popularity: 50 }),
    makeCandidate({ tmdbId: 11, title: 'Anime A', popularity: 90 }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], mediaType: 'tv' }).candidate.tmdbId, 11);
});

test('selectBestMatch: wrong title rejected even when a synonym resembles it (never forced)', () => {
  const candidates = [
    makeCandidate({ tmdbId: 5, title: 'Anime B' }),
    makeCandidate({ tmdbId: 6, title: 'Completely Different' }),
  ];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], year: 2018, mediaType: 'tv' }), null);
  assert.equal(selectBestMatch([], { titles: ['Anime A'] }), null);
  assert.equal(selectBestMatch([makeCandidate({ title: 'Anime A' })], { titles: [] }), null);
});

test('selectBestMatch: media type incompatibility rejected', () => {
  const candidates = [makeCandidate({ tmdbId: 18, title: 'Anime A', mediaType: 'movie' })];
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], mediaType: 'tv' }), null);
  assert.equal(selectBestMatch(candidates, { titles: ['Anime A'], mediaType: 'movie' }).candidate.tmdbId, 18);
});
