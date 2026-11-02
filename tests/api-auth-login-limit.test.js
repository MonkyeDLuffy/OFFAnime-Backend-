/**
 * Login attempt limiting tests (DB-backed policy, mocked GoTrue + Supabase REST).
 *
 * Verified against the PRODUCTION account policy (5 failed attempts within a
 * 15-minute window, then a 15-minute lock):
 *   1. five failed logins are counted; the SIXTH attempt gets 429 with a
 *      Retry-After header BEFORE any upstream call,
 *   2. after the cooldown window the account can attempt again (counter reset),
 *   3. a successful login clears the account's failure state,
 *   4. the locked response is identical for existing and unknown emails
 *      (no user enumeration),
 *   5. tracker-store failures FAIL OPEN (login availability first),
 *   6. concurrent failures are counted atomically (no lost updates) and lock
 *      the account immediately afterwards.
 *
 * The SEPARATE per-IP failure layer is covered in
 * tests/api-auth-login-ip-layer.test.js (different IP threshold).
 *
 * No in-memory-only enforcement is tested: the emulated REST state stands in
 * for the shared Supabase table + atomic RPC (production SQL in
 * supabase/migrations/20261102000001_auth_rate_limits.sql).
 */

import './helpers/test-env-auth-throttle.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { gotrueError, gotrueSessionResponse, TEST_API_SECRET } from './helpers/gotrue-fixtures.js';
import { jsonResponse } from './helpers/mock-fetch.js';
import { createThrottleState, routeThrottleRest } from './helpers/auth-throttle-mocks.js';

const rawFetch = globalThis.fetch.bind(globalThis);

/**
 * POST to an auth endpoint as the trusted proxy would (X-API-Key header).
 * @param {string} baseUrl
 * @param {string} path
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 */
function post(baseUrl, path, body, extraHeaders = {}) {
  return rawFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_SECRET, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

const WRONG = { email: 'user@example.com', password: 'wrong-password-123' };

/** The single login:email:* bucket in the mock state (or undefined). */
function findEmailBucket(state) {
  return [...state.limits.keys()].find((b) => b.startsWith('login:email:'));
}

/** The login:email:* bucket, asserted to exist. */
function emailBucket(state) {
  const bucket = findEmailBucket(state);
  assert.ok(bucket, 'expected a login:email bucket to exist');
  return bucket;
}

test('five failed logins -> SIXTH attempt blocked with 429 + Retry-After BEFORE upstream', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials'),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await post(server.baseUrl, '/api/auth/login', WRONG);
      assert.equal(res.status, 401, `attempt ${attempt} must be a counted 401 failure`);
    }
    assert.equal(installed.supabaseAuthCalls().length, 5, 'five upstream credential checks');
    assert.equal(state.limits.get(emailBucket(state)).hits, 5);

    const sixth = await post(server.baseUrl, '/api/auth/login', WRONG);
    assert.equal(sixth.status, 429);
    const body = await sixth.json();
    assert.equal(body.error.code, 'RATE_LIMIT_ERROR');
    assert.equal(body.error.details.reason, 'login_attempts_exceeded');
    assert.ok(body.error.details.retryAfterSeconds > 0, 'retryAfterSeconds required');
    assert.ok(Number(sixth.headers.get('retry-after')) >= 1, 'Retry-After header required');
    assert.equal(installed.supabaseAuthCalls().length, 5, 'the locked attempt must NOT reach GoTrue');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('after the cooldown window the account can attempt again (counter reset)', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials'),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal((await post(server.baseUrl, '/api/auth/login', WRONG)).status, 401);
    }
    assert.equal((await post(server.baseUrl, '/api/auth/login', WRONG)).status, 429);

    // Simulate the 15-minute window + lock having elapsed (real time cannot be
    // warped in a unit test; the SQL cooldown logic itself is verified by
    // supabase/tests/auth_attempt_limits_selftest.sql against the real DB).
    const bucket = emailBucket(state);
    const current = state.limits.get(bucket);
    state.limits.set(bucket, {
      ...current,
      windowStartedAt: Date.now() - 16 * 60 * 1000,
      lockedUntil: null,
    });

    const afterCooldown = await post(server.baseUrl, '/api/auth/login', WRONG);
    assert.equal(afterCooldown.status, 401, 'allowed through to GoTrue again');
    assert.equal(installed.supabaseAuthCalls().length, 6, 'upstream reached after the cooldown');
    assert.equal(state.limits.get(bucket).hits, 1, 'counter restarted with the new window');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('successful login clears the failed-attempt counter (reset after success)', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  // Deterministic upstream outcomes: 3 failures, 1 success, then 3 failures.
  const responses = [
    'invalid', 'invalid', 'invalid', 'session',
    'invalid', 'invalid', 'invalid',
  ];
  const installed = installApiMocks({
    supabaseAuth: () => {
      const kind = responses.shift() ?? 'invalid';
      return kind === 'session'
        ? gotrueSessionResponse({ email: WRONG.email })
        : gotrueError(400, 'invalid_credentials', 'Invalid login credentials');
    },
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal((await post(server.baseUrl, '/api/auth/login', WRONG)).status, 401);
    }

    const success = await post(server.baseUrl, '/api/auth/login', {
      email: WRONG.email,
      password: 'correct-horse-battery',
    });
    assert.equal(success.status, 200);
    assert.equal(findEmailBucket(state), undefined, 'counter cleared after success');

    // Two more failures: WITHOUT the reset these would total 5 and the next
    // attempt would be blocked. With the reset they are failures 1 and 2.
    assert.equal((await post(server.baseUrl, '/api/auth/login', WRONG)).status, 401);
    assert.equal((await post(server.baseUrl, '/api/auth/login', WRONG)).status, 401);

    const next = await post(server.baseUrl, '/api/auth/login', WRONG);
    assert.equal(next.status, 401, 'third failure after reset is still allowed (not 429)');
    assert.equal(state.limits.get(emailBucket(state)).hits, 3);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('locked responses are identical for existing and unknown emails (no enumeration)', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    // Real GoTrue returns the SAME invalid_credentials signal for unknown
    // addresses (anti-enumeration); the mock mirrors that.
    supabaseAuth: () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials'),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const known = { email: 'known-account@example.com', password: 'wrong-password-123' };
    const unknown = { email: 'nobody-special@example.com', password: 'wrong-password-123' };
    for (const credentials of [known, unknown]) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal((await post(server.baseUrl, '/api/auth/login', credentials)).status, 401);
      }
    }

    const knownLocked = await post(server.baseUrl, '/api/auth/login', known);
    const unknownLocked = await post(server.baseUrl, '/api/auth/login', unknown);
    assert.equal(knownLocked.status, 429);
    assert.equal(unknownLocked.status, 429);

    const knownBody = await knownLocked.json();
    const unknownBody = await unknownLocked.json();
    assert.equal(knownBody.error.code, unknownBody.error.code);
    assert.equal(knownBody.error.message, unknownBody.error.message);
    assert.equal(knownBody.error.details.reason, unknownBody.error.details.reason);
    assert.ok(Number(knownLocked.headers.get('retry-after')) >= 1);
    assert.ok(Number(unknownLocked.headers.get('retry-after')) >= 1);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('tracker-store outage FAILS OPEN: login availability is preserved', async () => {
  await resetL1Cache();
  let authCalls = 0;
  const installed = installApiMocks({
    supabaseAuth: () => {
      authCalls += 1;
      return authCalls === 1
        ? gotrueSessionResponse({ email: WRONG.email })
        : gotrueError(400, 'invalid_credentials', 'Invalid login credentials');
    },
    // Every tracker operation fails: the gate must treat this as "not locked".
    supabaseRest: () => jsonResponse({ message: 'supabase unavailable' }, 503),
  });
  const server = await startTestServer();
  try {
    const valid = await post(server.baseUrl, '/api/auth/login', {
      email: WRONG.email,
      password: 'correct-horse-battery',
    });
    assert.equal(valid.status, 200, 'a tracker outage must never block a valid login');
    assert.equal(installed.supabaseAuthCalls().length, 1);

    const wrong = await post(server.baseUrl, '/api/auth/login', WRONG);
    assert.equal(wrong.status, 401, 'failed login still returns the normal 401, never a tracker 429');
    assert.equal(installed.supabaseAuthCalls().length, 2);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('concurrent failed logins are counted atomically and lock the account immediately after', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials'),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => post(server.baseUrl, '/api/auth/login', WRONG)),
    );
    const statuses = results.map((r) => r.status);
    // Every concurrent attempt either failed credentials (401, counted) or was
    // already blocked by the gate (429) - never anything else.
    assert.ok(statuses.every((s) => s === 401 || s === 429), `unexpected statuses: ${statuses}`);

    const counted = statuses.filter((s) => s === 401).length;
    assert.ok(counted >= 5, `at least 5 failures must be admitted: ${counted}`);

    // Shared-counter semantics (mirroring the production SQL): increments are
    // serialized with no lost updates up to the policy limit; once the lock
    // engages, attempts during the cooldown are recorded but never
    // increment/extend the counter. The counter therefore saturates at
    // max + 1 = 6.
    const hits = state.limits.get(emailBucket(state)).hits;
    assert.ok(hits >= 5 && hits <= 6, `counter must saturate at the limit, got ${hits}`);

    const after = await post(server.baseUrl, '/api/auth/login', WRONG);
    assert.equal(after.status, 429, 'the account is blocked immediately after the burst');
  } finally {
    await server.stop();
    installed.restore();
  }
});
