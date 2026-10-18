/**
 * Auth FAIL-CLOSED tests: without Supabase Auth configured (missing
 * SUPABASE_URL / SUPABASE_ANON_KEY), auth endpoints must REJECT requests with
 * a clear typed error - never fall back to permissive behavior.
 */

import './helpers/test-env-auth-unconfigured.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer } from './helpers/test-server.js';
import { TEST_API_SECRET } from './helpers/gotrue-fixtures.js';

const rawFetch = globalThis.fetch.bind(globalThis);

test('login without a configured identity provider -> 502 AUTH_PROVIDER_ERROR (fail closed)', async () => {
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_SECRET },
      body: JSON.stringify({ email: 'user@example.com', password: 'correct-horse-battery' }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'AUTH_PROVIDER_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('me without a configured identity provider -> 401 AUTH_SESSION_EXPIRED (never permissive)', async () => {
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/auth/me`, {
      headers: { 'X-API-Key': TEST_API_SECRET, Authorization: 'Bearer some-token' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'AUTH_SESSION_EXPIRED');
  } finally {
    await server.stop();
    installed.restore();
  }
});
