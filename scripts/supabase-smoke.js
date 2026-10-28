/**
 * Manual live smoke test against a real Supabase project (L2 cache).
 *
 * NOT part of the unit test suite (`npm test` never runs this). Requires
 * configured Supabase environment variables (SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY) and the Phase 6 migration applied (see
 * supabase/migrations). Without configuration the script reports a skip and
 * exits 0. No credentials are hardcoded; the key is never printed.
 *
 * Verifies: set -> get (fresh) -> stale metadata -> update -> delete.
 *
 * Usage:
 *   node scripts/supabase-smoke.js
 *   node scripts/supabase-smoke.js --clear-test-key   # also delete the test key
 */

import { SupabaseStore } from '../src/cache/supabase/supabase-store.js';

const TEST_KEY = 'smoke:test:phase6';
const shouldDelete = process.argv.includes('--clear-test-key');

const store = new SupabaseStore();
if (!store.isConfigured()) {
  console.log('SUPABASE SMOKE TEST SKIPPED: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.');
  console.log('Set them in .env (see .env.example), apply supabase/migrations, and re-run.');
  process.exit(0);
}

try {
  console.log('LIVE SUPABASE SMOKE TEST');

  // 1) set -> get (fresh)
  await store.set(TEST_KEY, { hello: 'world', phase: 6 }, 300);
  const entry = await store.get(TEST_KEY);
  assertLike(entry?.value, { hello: 'world', phase: 6 });
  assertOk(Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now(), 'entry is fresh');
  assertOk(Number.isFinite(entry.staleUntil) && entry.staleUntil > entry.expiresAt, 'stale_until > expires_at');
  console.log('set -> get (fresh): OK');

  // 2) update
  await store.set(TEST_KEY, { hello: 'updated', phase: 6 }, 300);
  const updated = await store.get(TEST_KEY);
  assertLike(updated.value, { hello: 'updated', phase: 6 });
  console.log('update (atomic upsert): OK');

  // 3) stale metadata (entry kept after fresh expiry; manager decides usability)
  assertOk(entry.storedAt > 0 && updated.ttlSeconds === 300, 'ttl metadata preserved');
  console.log('stale metadata: OK');

  // 4) delete
  if (shouldDelete) {
    await store.delete(TEST_KEY);
    const deleted = await store.get(TEST_KEY);
    assertOk(deleted === null, 'deleted entry is a miss');
    console.log('delete: OK (test key removed)');
  } else {
    console.log('delete: SKIPPED (pass --clear-test-key to also delete the test key)');
  }

  console.log('LIVE SUPABASE SMOKE TEST OK');
} catch (err) {
  console.error('LIVE SUPABASE SMOKE TEST FAILED:', err.code ?? '', err.message);
  process.exit(1);
}

/** Minimal assertion helpers (no test-runner dependency). */
function assertOk(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
function assertLike(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      throw new Error(`assertion failed: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`);
    }
  }
}
