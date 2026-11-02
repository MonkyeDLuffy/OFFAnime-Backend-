/**
 * Test env for L2 CACHE RELIABILITY tests: Supabase L2 CONFIGURED (URL + anon
 * + service-role keys) with a small circuit-breaker threshold so the tests can
 * exercise "L2 unavailable -> L1-only fallback" without long waits.
 *
 * The actual Supabase REST traffic is always mocked in tests (no live calls).
 */

import './test-env.js';

process.env.LOG_LEVEL = 'error';
process.env.SUPABASE_URL = 'https://cache-tests.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-not-a-real-credential';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-not-a-real-credential';

// Breaker: open after 2 consecutive L2 failures; long cooldown so the
// endpoint test observes a stable open state.
process.env.CACHE_L2_FAILURE_THRESHOLD = '2';
process.env.CACHE_L2_BREAKER_OPEN_MS = '60000';
process.env.CACHE_L2_BREAKER_MAX_OPEN_MS = '120000';
