/**
 * Manual live smoke test against the real AniList API.
 *
 * NOT part of the unit test suite (`npm test` never runs this). Run manually:
 *
 *   node scripts/anilist-smoke.js [anilistId]
 *
 * AniList requires no API key for public GraphQL usage. Exits non-zero on any
 * provider failure so it can be used as a quick connectivity check.
 */

import { anilistProvider } from '../src/providers/index.js';
import { normalizeAnilistAnime } from '../src/normalizers/anime.normalizer.js';

const anilistId = Number(process.argv[2] ?? 1);

try {
  const raw = await anilistProvider.getAnimeById(anilistId);
  const anime = normalizeAnilistAnime(raw);

  console.log('LIVE ANILIST SMOKE TEST OK');
  console.log(JSON.stringify({
    id: anime.id,
    anilistId: anime.anilistId,
    idMatchesAnilistId: anime.id === anime.anilistId,
    malId: anime.malId,
    title: anime.title.userPreferred,
    format: anime.format,
    status: anime.status,
    episodes: anime.episodes,
    season: anime.season,
    seasonYear: anime.seasonYear,
    genres: anime.genres,
    poster: anime.images.poster,
    banner: anime.images.banner,
    descriptionPreview: anime.description?.slice(0, 120) ?? null,
  }, null, 2));
} catch (err) {
  console.error('LIVE ANILIST SMOKE TEST FAILED:', err.code ?? '', err.message);
  process.exit(1);
}
