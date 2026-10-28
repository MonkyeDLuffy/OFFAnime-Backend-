/**
 * Manual live smoke test against the real Jikan API.
 *
 * NOT part of the unit test suite (`npm test` never runs this). Run manually
 * with a real MAL ID:
 *
 *   node scripts/jikan-smoke.js 5114
 *
 * Jikan requires no API key for normal usage. Exits non-zero on any provider
 * failure so it can be used as a quick connectivity check.
 */

import { jikanProvider } from '../src/providers/index.js';
import { normalizeJikanAnime } from '../src/normalizers/anime.normalizer.js';

const malId = Number(process.argv[2]);

if (!Number.isInteger(malId) || malId <= 0) {
  console.error('Usage: node scripts/jikan-smoke.js <malId>');
  process.exit(1);
}

try {
  const raw = await jikanProvider.getAnimeByMalId(malId);
  const anime = normalizeJikanAnime(raw);

  console.log('LIVE JIKAN SMOKE TEST OK');
  console.log(JSON.stringify({
    malId: anime.malId,
    title: anime.title.default,
    titleEnglish: anime.title.english,
    type: anime.type,
    status: anime.status,
    episodes: anime.episodes,
    score: anime.score,
    season: anime.season,
    year: anime.year,
    genres: anime.genres,
    studios: anime.studios,
    poster: anime.images.poster,
    trailerYoutubeId: anime.trailer?.youtubeId ?? null,
    synopsisPreview: anime.synopsis?.slice(0, 120) ?? null,
  }, null, 2));
} catch (err) {
  console.error('LIVE JIKAN SMOKE TEST FAILED:', err.code ?? '', err.message);
  process.exit(1);
}
