/**
 * Jikan normalizer tests - secondary representation + defensive behavior.
 *
 * All fixtures are mocked; no live API calls.
 */

process.env.LOG_LEVEL = 'error';

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeJikanAnime, normalizeJikanPage } = await import('../src/normalizers/anime.normalizer.js');
const { ProviderError } = await import('../src/errors/index.js');

/** Realistic full Jikan anime fixture (from /anime/{id}/full). */
const fullAnime = {
  mal_id: 1,
  url: 'https://myanimelist.net/anime/1/Cowboy_Bebop',
  images: {
    jpg: {
      image_url: 'https://cdn.myanimelist.net/images/anime/4/19644.jpg',
      small_image_url: 'https://cdn.myanimelist.net/images/anime/4/19644t.jpg',
      large_image_url: 'https://cdn.myanimelist.net/images/anime/4/19644l.jpg',
    },
    webp: {
      image_url: 'https://cdn.myanimelist.net/images/anime/1170/109222.webp',
      small_image_url: 'https://cdn.myanimelist.net/images/anime/1170/109222t.webp',
      large_image_url: 'https://cdn.myanimelist.net/images/anime/1170/109222l.webp',
    },
  },
  trailer: { youtube_id: 'qig4KOK2R2g', url: 'https://www.youtube.com/watch?v=qig4KOK2R2g', embed_url: 'https://www.youtube.com/embed/qig4KOK2R2g' },
  title: 'Cowboy Bebop',
  title_english: 'Cowboy Bebop',
  title_japanese: 'カウボーイビバップ',
  title_synonyms: ['Kaubōi Bibappu'],
  type: 'TV',
  source: 'Original',
  episodes: 26,
  status: 'Finished Airing',
  airing: false,
  aired: { from: '1998-04-03T00:00:00+00:00', to: '1999-04-24T00:00:00+00:00' },
  duration: '24 min per ep',
  rating: 'R - 17+ (violence & profanity)',
  score: 8.75,
  scored_by: 700000,
  rank: 27,
  popularity: 250,
  members: 1800000,
  favorites: 60000,
  synopsis: 'In 2071, <i>bounty hunters</i> roam the galaxy. "See you space cowboy..."',
  background: 'The series won awards.\n\nProduced by Sunrise.',
  season: 'spring',
  year: 1998,
  genres: [{ mal_id: 1, name: 'Action' }, { mal_id: 24, name: 'Sci-Fi' }],
  themes: [{ mal_id: 50, name: 'Space' }],
  demographics: [{ mal_id: 42, name: 'Seinen' }],
  studios: [{ mal_id: 14, name: 'Sunrise' }],
  producers: [{ mal_id: 16, name: 'Bandai Visual' }],
};

test('complete anime -> stable secondary shape with all fields', () => {
  const anime = normalizeJikanAnime(fullAnime);
  assert.equal(anime.malId, 1);
  assert.deepEqual(anime.title, {
    default: 'Cowboy Bebop',
    english: 'Cowboy Bebop',
    japanese: 'カウボーイビバップ',
    synonyms: ['Kaubōi Bibappu'],
  });
  assert.equal(anime.type, 'TV');
  assert.equal(anime.sourceMaterial, 'Original');
  assert.equal(anime.episodes, 26);
  assert.equal(anime.status, 'Finished Airing');
  assert.equal(anime.airing, false);
  assert.deepEqual(anime.aired, { from: '1998-04-03T00:00:00+00:00', to: '1999-04-24T00:00:00+00:00' });
  assert.equal(anime.duration, '24 min per ep');
  assert.equal(anime.rating, 'R - 17+ (violence & profanity)');
  assert.equal(anime.score, 8.75);
  assert.equal(anime.scoredBy, 700000);
  assert.equal(anime.rank, 27);
  assert.equal(anime.popularity, 250);
  assert.equal(anime.members, 1800000);
  assert.equal(anime.favorites, 60000);
  assert.deepEqual(anime.season, 'spring');
  assert.equal(anime.year, 1998);
  assert.deepEqual(anime.genres, ['Action', 'Sci-Fi']);
  assert.deepEqual(anime.themes, ['Space']);
  assert.deepEqual(anime.demographics, ['Seinen']);
  assert.deepEqual(anime.studios, ['Sunrise']);
  assert.deepEqual(anime.producers, ['Bandai Visual']);
  assert.deepEqual(anime.images, {
    poster: 'https://cdn.myanimelist.net/images/anime/1170/109222l.webp',
    large: 'https://cdn.myanimelist.net/images/anime/4/19644l.jpg',
    small: 'https://cdn.myanimelist.net/images/anime/4/19644t.jpg',
  });
  assert.deepEqual(anime.trailer, {
    youtubeId: 'qig4KOK2R2g',
    url: 'https://www.youtube.com/watch?v=qig4KOK2R2g',
    embedUrl: 'https://www.youtube.com/embed/qig4KOK2R2g',
  });
  assert.deepEqual(anime.source, { anilist: false, jikan: true, tmdb: false });
  assert.ok(!JSON.stringify(anime).includes('undefined'));
});

test('mal_id preservation: malId === Jikan mal_id', () => {
  const anime = normalizeJikanAnime({ ...fullAnime, mal_id: 5114 });
  assert.equal(anime.malId, 5114);
});

test('identity safety: Jikan normalization NEVER produces id or anilistId fields', () => {
  const anime = normalizeJikanAnime(fullAnime);
  assert.equal('id' in anime, false); // no id === malId
  assert.equal('anilistId' in anime, false); // no anilistId === malId
  assert.equal(anime.id, undefined);
  assert.equal(anime.anilistId, undefined);
});

test('malformed payload (null/missing/invalid mal_id) -> ProviderError', () => {
  assert.throws(() => normalizeJikanAnime(null), ProviderError);
  assert.throws(() => normalizeJikanAnime({}), ProviderError);
  assert.throws(() => normalizeJikanAnime({ mal_id: null }), ProviderError);
  assert.throws(() => normalizeJikanAnime({ mal_id: 0 }), ProviderError);
  assert.throws(() => normalizeJikanAnime([1, 2]), ProviderError);
});

test('missing synopsis/background -> null, no throw', () => {
  const anime = normalizeJikanAnime({ ...fullAnime, synopsis: null, background: null });
  assert.equal(anime.synopsis, null);
  assert.equal(anime.background, null);
});

test('synopsis HTML entities/tags cleaned; structure preserved', () => {
  const anime = normalizeJikanAnime(fullAnime);
  assert.equal(anime.synopsis.includes('<'), false);
  assert.ok(anime.synopsis.includes('"See you space cowboy..."')); // " decoded
  assert.ok(anime.synopsis.includes('bounty hunters'));
});

test('missing images -> all image fields null, no throw', () => {
  const anime = normalizeJikanAnime({ ...fullAnime, images: null });
  assert.deepEqual(anime.images, { poster: null, large: null, small: null });
});

test('missing trailer -> null (never fabricated YouTube URLs)', () => {
  assert.equal(normalizeJikanAnime({ ...fullAnime, trailer: null }).trailer, null);
  assert.equal(normalizeJikanAnime({ ...fullAnime, trailer: {} }).trailer, null);
  const partial = normalizeJikanAnime({ ...fullAnime, trailer: { youtube_id: 'abc123' } });
  assert.deepEqual(partial.trailer, { youtubeId: 'abc123', url: null, embedUrl: null });
});

test('missing genres/studios/producers -> []', () => {
  const anime = normalizeJikanAnime({
    ...fullAnime,
    genres: null,
    studios: [],
    producers: null,
    themes: null,
    demographics: null,
  });
  assert.deepEqual(anime.genres, []);
  assert.deepEqual(anime.studios, []);
  assert.deepEqual(anime.producers, []);
  assert.deepEqual(anime.themes, []);
  assert.deepEqual(anime.demographics, []);
});

test('null optional fields remain valid (score, rank, dates, season, year)', () => {
  const anime = normalizeJikanAnime({
    ...fullAnime,
    score: null,
    scored_by: null,
    rank: null,
    popularity: null,
    members: null,
    favorites: null,
    season: null,
    year: null,
    duration: null,
    rating: null,
    type: null,
    source: null,
  });
  assert.equal(anime.score, null);
  assert.equal(anime.scoredBy, null);
  assert.equal(anime.rank, null);
  assert.equal(anime.popularity, null);
  assert.equal(anime.members, null);
  assert.equal(anime.favorites, null);
  assert.equal(anime.season, null);
  assert.equal(anime.year, null);
  assert.equal(anime.duration, null);
  assert.equal(anime.rating, null);
  assert.equal(anime.type, null);
  assert.equal(anime.sourceMaterial, null);
});

test('partial dates: missing aired -> nulls; missing season/year honest', () => {
  const anime = normalizeJikanAnime({ ...fullAnime, aired: null });
  assert.deepEqual(anime.aired, { from: null, to: null });
  const partial = normalizeJikanAnime({ ...fullAnime, aired: { from: null, to: '1999-04-24T00:00:00+00:00' } });
  assert.deepEqual(partial.aired, { from: null, to: '1999-04-24T00:00:00+00:00' });
});

test('multiple title variants preserved; missing variants -> null', () => {
  const anime = normalizeJikanAnime({ ...fullAnime, title_english: null, title_japanese: null, title_synonyms: null });
  assert.deepEqual(anime.title, {
    default: 'Cowboy Bebop',
    english: null,
    japanese: null,
    synonyms: [],
  });
});

test('normalizeJikanPage builds stable page shape and drops junk entries', () => {
  const page = normalizeJikanPage({
    pagination: {
      last_visible_page: 2,
      has_next_page: true,
      current_page: 1,
      items: { count: 2, total: 30, per_page: 20 },
    },
    data: [
      { mal_id: 10, title: 'A', type: 'TV', images: { jpg: { image_url: 'https://x/a.jpg' } } },
      { title: 'no id' }, // missing mal_id -> dropped
    ],
  });
  assert.deepEqual(page.pageInfo, { page: 1, lastPage: 2, hasNextPage: true, total: 30, perPage: 20 });
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].malId, 10);
  assert.equal('anilistId' in page.results[0], false);
});

test('malformed page payload -> ProviderError (never cached as valid empty data)', () => {
  assert.throws(() => normalizeJikanPage(null), ProviderError);
  assert.throws(() => normalizeJikanPage({}), ProviderError); // missing data array
  assert.throws(() => normalizeJikanPage({ pagination: {} }), ProviderError);
});
