/**
 * Details-pipeline benchmark (Phase: performance audit).
 *
 * Repeatable offline benchmark for GET /api/details/:id using the REAL app +
 * mocked provider fetches with fixed simulated latencies. This isolates the
 * orchestration behavior (sequencing, waiting, caching) from real network
 * noise, so before/after comparisons are apples-to-apples.
 *
 * Scenarios:
 *   1. cold-cache    - fresh L1 per sample (AniList 150ms, Jikan 250ms, TMDB 200ms/search)
 *   2. warm-cache    - repeated request, composite served from L1
 *   3. concurrent    - 10 parallel cold requests for the same anime (coalescing)
 *   4. slow-jikan    - Jikan responds in 6s (slow optional provider)
 *   5. slow-tmdb     - 2 TMDB searches x 3s each (slow optional provider)
 *   6. optional-down - Jikan + TMDB both return HTTP 500 (failures)
 *   7. no-mal-id     - anime without MAL mapping (no Jikan leg at all)
 *
 * Usage: node scripts/benchmark-details.js
 * NOT a test file: deliberately outside tests/ and not named *.test.js so
 * `npm test` (node --test) never picks it up.
 */

process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';
process.env.MEGAPLAY_PROXY_URL = '';
process.env.TMDB_API_KEY = 'benchmark-key'; // configured so the TMDB leg really runs (mocked)
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.REQUEST_TIMEOUT_MS = '10000';
// Read by the optimized pipeline (bounded enrichment deadline); ignored by the
// pre-optimization code, so the same script works for before/after runs.
process.env.ENRICHMENT_TIMEOUT_MS = '4000';

const SAMPLES = 12;
const ANILIST_ID = 123;
const DETAILS_KEY = `api:details:anilist:${ANILIST_ID}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dynamic imports AFTER env setup (ESM static imports would hoist and load
// config/env.js before the env overrides above are applied).
const { installApiMocks, startTestServer, resetL1Cache, anilistMedia, jikanAnime, tmdbSearchResults, tmdbTvCandidate } = await import('../tests/helpers/test-server.js');

/** Wrap a mock handler with fixed simulated upstream latency. */
const withLatency = (ms, handler) => async (...args) => {
  await sleep(ms);
  return handler(...args);
};

const anilistHandler = ({ idMal = 456 } = {}) => (body) => {
  if (body.variables?.id !== ANILIST_ID) return { data: { Media: null } };
  return { data: { Media: anilistMedia({ id: ANILIST_ID, idMal, title: 'One Piece' }) } };
};

const jikanHandler = () => jikanAnime({ malId: 456, title: 'One Piece' });

const tmdbHandler = () => tmdbSearchResults([tmdbTvCandidate({ id: 789, name: 'One Piece' })]);

/**
 * @param {{ anilistMs?: number, jikanMs?: number|null, tmdbMs?: number, idMal?: number|null, jikanFail?: boolean, tmdbFail?: boolean }} [opts]
 */
function installBenchMocks({ anilistMs = 150, jikanMs = 250, tmdbMs = 200, idMal = 456, jikanFail = false, tmdbFail = false } = {}) {
  return installApiMocks({
    anilist: withLatency(anilistMs, anilistHandler({ idMal })),
    jikan: jikanMs === null ? undefined : withLatency(jikanMs, () => (jikanFail ? { status: 500, json: { error: 'boom' } } : jikanHandler())),
    tmdb: tmdbMs === null ? undefined : withLatency(tmdbMs, () => (tmdbFail ? { status: 500, json: { error: 'boom' } } : tmdbHandler())),
  });
}

/** @param {number[]} xs */
function stats(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { median, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

async function timeRequest(baseUrl) {
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/api/details/${ANILIST_ID}`);
  await res.json();
  return { latencyMs: Date.now() - t0, status: res.status };
}

/**
 * @param {string} label
 * @param {object} opts mock options
 * @param {(baseUrl: object) => Promise<{ latencies: number[], statuses: number[], upstreamCalls: number }>} scenario
 */
async function runScenario(label, opts, scenario) {
  const mock = installBenchMocks(opts);
  const server = await startTestServer();
  try {
    const { latencies, statuses, upstreamCalls } = await scenario(server, mock);
    const s = stats(latencies);
    console.log(
      `${label.padEnd(22)} median ${String(s.median).padStart(6)}ms | p95 ${String(s.p95).padStart(6)}ms | min ${String(s.min).padStart(6)}ms | max ${String(s.max).padStart(6)}ms | n=${latencies.length} | upstream=${upstreamCalls} | status=${[...new Set(statuses)].join(',')}`,
    );
  } finally {
    await server.stop();
    mock.restore();
  }
}

console.log(`\n=== /api/details/:id benchmark (simulated upstream: AniList 150ms, Jikan 250ms, TMDB 200ms/search; enrichment deadline ${process.env.ENRICHMENT_TIMEOUT_MS}ms) ===\n`);

// 1. Cold cache: fresh L1 per sample, one AniList + one Jikan + one TMDB search.
await runScenario('cold-cache', {}, async (server, mock) => {
  const latencies = [];
  const statuses = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    await resetL1Cache();
    const r = await timeRequest(server.baseUrl);
    latencies.push(r.latencyMs);
    statuses.push(r.status);
  }
  return { latencies, statuses, upstreamCalls: mock.calls.length };
});

// 2. Warm cache: first load, then repeated hits on the composite entry.
await runScenario('warm-cache', {}, async (server, mock) => {
  await resetL1Cache();
  await timeRequest(server.baseUrl);
  const latencies = [];
  const statuses = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const r = await timeRequest(server.baseUrl);
    latencies.push(r.latencyMs);
    statuses.push(r.status);
  }
  return { latencies, statuses, upstreamCalls: mock.calls.length };
});

// 3. Concurrent same-anime: one upstream load, coalesced followers.
await runScenario('concurrent-x10', {}, async (server, mock) => {
  await resetL1Cache();
  const results = await Promise.all(Array.from({ length: 10 }, () => timeRequest(server.baseUrl)));
  return {
    latencies: results.map((r) => r.latencyMs),
    statuses: results.map((r) => r.status),
    upstreamCalls: mock.calls.length,
  };
});

// 4. Slow Jikan (6s) - slow optional provider.
await runScenario('slow-jikan-6s', { jikanMs: 6000 }, async (server, mock) => {
  const latencies = [];
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    await resetL1Cache();
    const r = await timeRequest(server.baseUrl);
    latencies.push(r.latencyMs);
    statuses.push(r.status);
  }
  return { latencies, statuses, upstreamCalls: 3 };
});

// 5. Slow TMDB (2 searches x 3s) - slow optional provider.
await runScenario('slow-tmdb-2x3s', { tmdbMs: 3000 }, async (server, mock) => {
  const latencies = [];
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    await resetL1Cache();
    const r = await timeRequest(server.baseUrl);
    latencies.push(r.latencyMs);
    statuses.push(r.status);
  }
  return { latencies, statuses, upstreamCalls: mock.calls.length };
});

// 6. Optional providers down (Jikan + TMDB HTTP 500).
await runScenario('optional-down', { jikanFail: true, tmdbFail: true }, async (server, mock) => {
  const latencies = [];
  const statuses = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    await resetL1Cache();
    const r = await timeRequest(server.baseUrl);
    latencies.push(r.latencyMs);
    statuses.push(r.status);
  }
  return { latencies, statuses, upstreamCalls: 3 };
});

// 7. No MAL mapping: Jikan leg absent entirely.
await runScenario('no-mal-id', { jikanMs: null, idMal: null }, async (server, mock) => {
  const latencies = [];
  const statuses = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    await resetL1Cache();
    const r = await timeRequest(server.baseUrl);
    latencies.push(r.latencyMs);
    statuses.push(r.status);
  }
  return { latencies, statuses, upstreamCalls: 2 };
});

console.log('');
