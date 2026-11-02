/**
 * Login per-IP abuse layer tests (mocked GoTrue + Supabase REST).
 *
 * The IP layer is SEPARATE from the per-account lockout: it throttles
 * credential-stuffing floods from one source across DIFFERENT accounts, and it
 * never blocks a different source IP. Thresholds here are small (3) via
 * tests/helpers/test-env-auth-throttle-ip.js; the production default is 20.
 */

import './helpers/test-env-auth-throttle-ip.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { gotrueError, TEST_API_SECRET } from './helpers/gotrue-fixtures.js';
import { createThrottleState, routeThrottleRest } from './helpers/auth-throttle-mocks.js';

const rawFetch = globalThis.fetch.bind(globalThis);

function post(baseUrl, body, forwardedFor) {
  return rawFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': TEST_API_SECRET,
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('per-IP layer locks the source IP after N failures across DIFFERENT accounts; other IPs unaffected', async () => {
  await resetL1Cache();
  const state = createThrottleState();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials'),
    supabaseRest: (url, call) => routeThrottleRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const ATTACKER_IP = '203.0.113.7';
    // Three failures for three DIFFERENT accounts from the SAME IP.
    for (let i = 1; i <= 3; i += 1) {
      const res = await post(server.baseUrl, { email: `victim-${i}@example.com`, password: 'wrong-password-123' }, ATTACKER_IP);
      assert.equal(res.status, 401);
    }
    const ipBucket = [...state.limits.keys()].find((b) => b.startsWith('login:ip:'));
    assert.ok(ipBucket, 'expected a login:ip bucket');
    assert.ok(ipBucket.endsWith(ATTACKER_IP));
    assert.equal(state.limits.get(ipBucket).hits, 3);
    // No ACCOUNT was locked (one failure each < 5): this is the IP layer.
    for (const key of state.limits.keys()) {
      if (key.startsWith('login:email:')) {
        assert.ok(state.limits.get(key).hits < 5, 'account buckets must be below their limit');
      }
    }

    // 4th attempt from the SAME IP, brand-new account -> blocked BEFORE upstream.
    const blocked = await post(server.baseUrl, { email: 'fresh-target@example.com', password: 'wrong-password-123' }, ATTACKER_IP);
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, 'RATE_LIMIT_ERROR');
    assert.equal(body.error.details.reason, 'login_attempts_exceeded');
    assert.equal(installed.supabaseAuthCalls().length, 3, 'the blocked attempt must not reach GoTrue');

    // A DIFFERENT IP with a fresh account is completely unaffected.
    const other = await post(server.baseUrl, { email: 'other-user@example.com', password: 'wrong-password-123' }, '198.51.100.9');
    assert.equal(other.status, 401);
    assert.equal(installed.supabaseAuthCalls().length, 4);
  } finally {
    await server.stop();
    installed.restore();
  }
});
