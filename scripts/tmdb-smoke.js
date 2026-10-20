/**
 * Manual live smoke test against the real TMDB API.
 *
 * NOT part of the unit test suite (`npm test` never runs this). Run manually:
 *
 *   node scripts/tmdb-smoke.js "One Punch Man"
 *
 * Requires configured TMDB credentials (TMDB_API_KEY in .env or environment).
 * Without credentials the script reports a skip and exits 0. Exits non-zero on
 * a provider failure. No API credentials are hardcoded.
 */

import { TmdbProvider } from '../src/providers/tmdb/tmdb.provider.js';
import { normalizeTmdbCandidates, normalizeTmdbVisual } from '../src/normalizers/tmdb.normalizer.js';
import { selectBestMatch } from '../src/normalizers/tmdb.matching.js';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: node scripts/tmdb-smoke.js "<search query>"');
  process.exit(1);
}

const provider = new TmdbProvider();
if (!provider.isConfigured()) {
  console.log('TMDB SMOKE TEST SKIPPED: TMDB_API_KEY is not configured.');
  console.log('Set TMDB_API_KEY in .env (see .env.example) and re-run to test the live API.');
  process.exit(0);
}

try {
  const raw = await provider.searchTv(query);
  const candidates = normalizeTmdbCandidates(raw, 'tv');
  const match = selectBestMatch(candidates, { titles: [query] });
  console.log('LIVE TMDB SMOKE TEST OK');
  console.log(`Search "${query}" -> ${candidates.length} candidate(s)`);
  console.log('Top candidates (conservative matcher input, not auto-selected):');
  for (const candidate of candidates.slice(0, 3)) {
    console.log(JSON.stringify({
      tmdbId: candidate.tmdbId,
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      popularity: candidate.popularity,
    }));
  }
  if (match) {
    const visual = normalizeTmdbVisual(match.candidate, { strategy: match.strategy });
    console.log('Confident match found (normalized visual):');
    console.log(JSON.stringify(visual, null, 2));
  } else {
    console.log('No sufficiently confident match (valid unresolved enrichment).');
  }
} catch (err) {
  console.error('LIVE TMDB SMOKE TEST FAILED:', err.code ?? '', err.message);
  process.exit(1);
}
