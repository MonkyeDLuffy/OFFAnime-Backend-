/**
 * Manual live smoke test against the real MegaPlay API (PRIMARY streaming).
 *
 * NOT part of the unit test suite (`npm test` never runs this). Run manually:
 *
 *   node scripts/megaplay-smoke.js [anilistId] [episode] [language]
 *
 * MegaPlay requires no API key for the documented public endpoints. Exits
 * non-zero on a provider FAILURE (timeout/429/5xx/network). A genuine
 * no-stream result is NOT a failure - it is reported and exits 0. No stream
 * URL is ever fabricated: every reported source comes from an actual
 * MegaPlay response.
 *
 * Verifies:
 *   - the AniList endpoint (/stream/ani/{id}/{ep}/{lang}) is attempted FIRST
 *   - the raw response is classified (usable stream vs genuine no-stream)
 *   - on genuine no-stream: IdentityResolver -> MAL endpoint fallback
 *     (executed through the real StreamResolver with a fresh local cache)
 *   - no title search / fuzzy identity fallback occurs (enforced upstream)
 */

process.env.LOG_LEVEL = 'error';

import { megaplayProvider, anilistProvider } from '../src/providers/index.js';
import { StreamResolver } from '../src/streaming/stream-resolver.js';
import { IdentityResolver } from '../src/identity/identity-resolver.js';
import { CacheManager } from '../src/cache/cache-manager.js';
import { MemoryStore } from '../src/cache/memory/memory-store.js';
import { RequestCoalescer } from '../src/cache/request-coalescer.js';
import { normalizeMegaplayStreamResponse } from '../src/normalizers/megaplay-normalizer.js';

const anilistId = Number(process.argv[2] ?? 101922);
const episode = Number(process.argv[3] ?? 1);
const language = process.argv[4] ?? 'sub';

if (!Number.isInteger(anilistId) || anilistId <= 0 || !Number.isInteger(episode) || episode <= 0) {
  console.error('Usage: node scripts/megaplay-smoke.js <anilistId> [episode] [sub|dub]');
  process.exit(1);
}

try {
  // 1) Direct AniList-ID endpoint probe (the FIRST path the contract expects).
  const raw = await megaplayProvider.resolveByAnilistId(anilistId, { episode, language });
  const result = normalizeMegaplayStreamResponse(raw);

  console.log('LIVE MEGAPLAY SMOKE TEST');
  console.log(`endpoint: ${raw.url}`);
  console.log(`classification: ${result.usable ? 'USABLE STREAM' : `no-stream (${result.reason})`}`);
  if (result.usable) {
    for (const source of result.sources) {
      console.log(`  source: ${source.url}${source.quality ? ` (${source.quality})` : ''}${source.type ? ` [${source.type}]` : ''}`);
    }
    console.log('LIVE MEGAPLAY SMOKE TEST OK');
    process.exit(0);
  }

  // 2) Genuine no-stream -> full documented fallback flow through the REAL
  //    StreamResolver (AniList endpoint first, then IdentityResolver -> MAL
  //    endpoint). Fresh local L1-only cache (Supabase stays unconfigured).
  console.log('no usable stream on the AniList endpoint - running the documented MAL fallback flow...');
  const cache = new CacheManager({ l1: new MemoryStore(), l2: null, coalescer: new RequestCoalescer() });
  const identity = new IdentityResolver({ provider: anilistProvider, cache });
  const resolver = new StreamResolver({ megaplay: megaplayProvider, identity, cache });

  try {
    const stream = await resolver.resolveStream({ anilistId, episode, language });
    console.log(`resolved via ${stream.idType} ID: malId=${stream.malId}`);
    for (const source of stream.sources) {
      console.log(`  source: ${source.url}${source.quality ? ` (${source.quality})` : ''}${source.type ? ` [${source.type}]` : ''}`);
    }
    console.log('LIVE MEGAPLAY SMOKE TEST OK');
  } catch (err) {
    if (err.statusCode === 404) {
      console.log(`genuinely unresolved (no usable stream on either endpoint, no MAL mapping): ${err.message}`);
      console.log('LIVE MEGAPLAY SMOKE TEST OK');
    } else {
      throw err;
    }
  }
} catch (err) {
  console.error('LIVE MEGAPLAY SMOKE TEST FAILED:', err.code ?? '', err.message);
  process.exit(1);
}
