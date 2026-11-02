/**
 * Signup anti-abuse + email-confirmation-removal tests (mocked GoTrue + REST).
 *
 * Verified:
 *   - signup returns an IMMEDIATELY USABLE account: 201 + session tokens, no
 *     emailConfirmationRequired, and exactly ONE upstream call (the signup
 *     itself) - no verification email flow (no /resend, /verify, /recover),
 *   - duplicate signup within the dedupe TTL -> 409 AUTH_EMAIL_TAKEN with NO
 *     upstream call (repeated POSTs cannot burn Supabase Auth quota),
 *   - the per-IP signup budget registers atomically BEFORE the upstream call
 *     and blocks the (N+1)th attempt with a typed 429 + Retry-After,
 *   - a failed signup (upstream 429) is propagated and NEVER retried or
 *     recorded as success,
 *   - tracker-store failures fail OPEN (signup availability first).
 *
 * The per-IP budget in this env is 3 (tests/helpers/test-env-auth-throttle.js)
 * - the production default is 10; semantics are threshold-driven and identical.
 */

import './helpers/test-env-auth-throttle.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { gotrueError, gotrueSessionResponse, TEST_API_SECRET } from './helpers/gotrue-fixtures.js';
import { jsonResponse } from './helpers/mock-fetch.js';
import { createThrottleState, routeThrottleRest } from './helpers/auth-throttle-mocks.js';

const rawFetch = globalThis.fetch.bind(globalThis);

function post(baseUrl, body) {
  return rawFetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_SECRET },
    body: JSON.stringify(body),
  });
}

test('signup creates an immediately usable account: session returned, no verification email', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'new-user@example.com' }),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, { email: 'new-user@example.com', password: 'correct-horse-battery' });
    assert.equal(res.status, 201);

    const body = await res.json();
    assert.equal(body.user.email, 'new-user@example.com');
    assert.equal(body.emailConfirmationRequired, undefined, 'confirmation must NOT be required');
    assert.ok(body.session, 'signup must return a session');
    assert.ok(body.session.accessToken.startsWith('gt-access-token'));
    assert.equal(body.session.tokenType, 'bearer');

    // EXACTLY one upstream call - the signup. Nothing sends a verification
    // email (no /resend, /verify, /recover, /magiclink).
    const calls = installed.supabaseAuthCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/auth/v1/signup'));
    for (const call of calls) {
      assert.equal(/\/auth\/v1\/(resend|verify|recover|magiclink)/.test(call.url), false);
    }

    // The success marker was recorded for duplicate suppression (hashed key).
    assert.equal(state.dedupe.size, 1);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('duplicate signup within the dedupe TTL -> 409 AUTH_EMAIL_TAKEN with NO upstream call', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'repeat@example.com' }),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const first = await post(server.baseUrl, { email: 'repeat@example.com', password: 'correct-horse-battery' });
    assert.equal(first.status, 201);
    assert.equal(installed.supabaseAuthCalls().length, 1);

    // Same address, different casing (normalized before hashing).
    const duplicate = await post(server.baseUrl, { email: 'Repeat@Example.com', password: 'correct-horse-battery' });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'AUTH_EMAIL_TAKEN');
    assert.equal(installed.supabaseAuthCalls().length, 1, 'duplicate must NOT reach Supabase Auth');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('per-IP signup budget: attempts 1..N pass, attempt N+1 blocked with 429 before upstream', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: (url) => gotrueSessionResponse({ email: `user${Date.now()}@example.com` }),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    // Budget = 3 in this env: three DIFFERENT addresses succeed.
    for (let i = 1; i <= 3; i += 1) {
      const res = await post(server.baseUrl, { email: `signup-${i}@example.com`, password: 'correct-horse-battery' });
      assert.equal(res.status, 201, `signup ${i} must succeed`);
    }
    assert.equal(installed.supabaseAuthCalls().length, 3);

    // The 4th attempt from the same source is blocked BEFORE the upstream.
    const blocked = await post(server.baseUrl, { email: 'signup-4@example.com', password: 'correct-horse-battery' });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, 'RATE_LIMIT_ERROR');
    assert.equal(body.error.details.reason, 'signup_ip_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal(installed.supabaseAuthCalls().length, 3, 'blocked signup must not reach Supabase Auth');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('failed signup (upstream 429) is propagated, never retried, never marked successful', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    // The Supabase Auth signup rate-limit error that production logs showed.
    supabaseAuth: () => gotrueError(429, 'over_email_send_rate_limit', 'email rate limit exceeded'),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, { email: 'limited@example.com', password: 'correct-horse-battery' });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'RATE_LIMIT_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 1, 'failed signup must NOT be retried automatically');
    assert.equal(state.dedupe.size, 0, 'a failure must never be recorded as a successful signup');

    // The address is NOT suppressed by dedupe: a later attempt still reaches
    // the provider (and still fails upstream - without our layer blocking it).
    const again = await post(server.baseUrl, { email: 'limited@example.com', password: 'correct-horse-battery' });
    assert.equal(again.status, 429);
    assert.equal(installed.supabaseAuthCalls().length, 2);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('tracker-store outage FAILS OPEN: signup still reaches Supabase Auth', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'during-outage@example.com' }),
    supabaseRest: () => jsonResponse({ message: 'supabase unavailable' }, 503),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, { email: 'during-outage@example.com', password: 'correct-horse-battery' });
    assert.equal(res.status, 201, 'a tracker outage must never block signups');
    assert.equal(installed.supabaseAuthCalls().length, 1);
  } finally {
    await server.stop();
    installed.restore();
  }
});
