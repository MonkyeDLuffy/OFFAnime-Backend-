/**
 * POST /api/auth/signup tests (mocked GoTrue - no live Supabase).
 *
 * Verified:
 *   - valid signup -> 201, safe user (no app_metadata/roles leak), session
 *     tokens present, HttpOnly cookies set.
 *   - signup when email confirmation is required -> session: null +
 *     emailConfirmationRequired: true, NO cookies.
 *   - duplicate email -> 409 AUTH_EMAIL_TAKEN.
 *   - missing/malformed input -> 400 VALIDATION_ERROR WITHOUT any upstream
 *     call (validation happens before GoTrue).
 *
 * All requests use rawFetch (captured before startTestServer installs its
 * auto-injecting header wrapper) with explicit X-API-Key - mimicking the
 * trusted server-side proxy contract.
 */

// Env setup MUST be the first import (pins the TEST-ONLY secret + Supabase
// Auth configuration before config/env.js loads transitively).
import './helpers/test-env-auth.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { TEST_API_SECRET, TEST_ANON_KEY, gotrueSessionResponse, gotrueError } from './helpers/gotrue-fixtures.js';

const rawFetch = globalThis.fetch.bind(globalThis);

/**
 * POST to an auth endpoint as the trusted proxy would (X-API-Key header).
 * @param {string} baseUrl
 * @param {string} path
 * @param {object | undefined} body
 * @param {Record<string, string>} [extraHeaders]
 */
function post(baseUrl, path, body, extraHeaders = {}) {
  return rawFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_SECRET, ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('signup with valid input -> 201, safe user, session tokens, HttpOnly cookies', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'new-user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/signup', {
      email: 'New-User@Example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 201);

    const body = await res.json();
    assert.equal(body.user.email, 'new-user@example.com'); // normalized
    assert.equal(body.user.displayName, 'Test User');
    assert.equal(typeof body.user.id, 'string');
    assert.equal(JSON.stringify(body).includes('must-never-leak'), false, 'app_metadata roles leaked');
    assert.equal(JSON.stringify(body).includes('secret_note'), false, 'raw metadata leaked');
    assert.equal(JSON.stringify(body).includes('raw_user_meta_data'), false);
    assert.equal(body.session.tokenType, 'bearer');
    assert.ok(body.session.accessToken.startsWith('gt-access-token'));
    assert.ok(body.session.expiresAt);

    const cookies = res.headers.getSetCookie();
    const accessCookie = cookies.find((c) => c.startsWith('offanime_session='));
    const refreshCookie = cookies.find((c) => c.startsWith('offanime_refresh='));
    assert.ok(accessCookie, 'access cookie missing');
    assert.match(accessCookie, /HttpOnly/i);
    assert.match(accessCookie, /SameSite=Lax/i);
    assert.ok(refreshCookie, 'refresh cookie missing');
    assert.match(refreshCookie, /Path=\/api\/auth/i);

    // Exactly one GoTrue call, carrying the ANON key (never a service-role key).
    assert.equal(installed.supabaseAuthCalls().length, 1);
    const call = installed.supabaseAuthCalls()[0];
    assert.equal(call.init.headers.apikey, TEST_ANON_KEY);
    assert.ok(call.url.includes('/auth/v1/signup'));
    const sentBody = JSON.parse(String(call.init.body));
    assert.equal(sentBody.email, 'new-user@example.com');
    assert.equal(sentBody.password, 'correct-horse-battery'); // to provider only, over TLS
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('signup when email confirmation is required -> session null, confirmation flag, NO cookies', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'confirm-me@example.com', withSession: false }),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/signup', {
      email: 'confirm-me@example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.session, null);
    assert.equal(body.emailConfirmationRequired, true);
    assert.equal(res.headers.getSetCookie().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('duplicate email -> 409 AUTH_EMAIL_TAKEN', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(422, 'user_already_exists', 'User already registered'),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/signup', {
      email: 'taken@example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'AUTH_EMAIL_TAKEN');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('missing and malformed inputs -> 400 with NO upstream call', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const cases = [
      { body: undefined, reason: 'no body' },
      { body: {}, reason: 'missing both' },
      { body: { email: 'not-an-email', password: 'correct-horse-battery' }, reason: 'malformed email' },
      { body: { email: 'user@example.com' }, reason: 'missing password' },
      { body: { email: 'user@example.com', password: 'short' }, reason: 'short password' },
      { body: { email: 'user@example.com', password: 12345678 }, reason: 'non-string password' },
    ];
    for (const c of cases) {
      const res = await post(server.baseUrl, '/api/auth/signup', c.body);
      assert.equal(res.status, 400, `expected 400 for case: ${c.reason}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR', c.reason);
    }
    assert.equal(installed.supabaseAuthCalls().length, 0, 'validation must happen before any upstream call');
  } finally {
    await server.stop();
    installed.restore();
  }
});
