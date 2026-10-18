/**
 * POST /api/auth/login tests (mocked GoTrue - no live Supabase).
 *
 * Verified:
 *   - valid login -> 200, safe user + session, HttpOnly cookies, anon key
 *     used upstream (service-role NEVER).
 *   - invalid credentials -> 401 AUTH_INVALID_CREDENTIALS.
 *   - unconfirmed email -> 403 AUTH_EMAIL_NOT_CONFIRMED.
 *   - provider rate limit -> 429 RATE_LIMIT_ERROR.
 *   - provider outage -> 502 AUTH_PROVIDER_ERROR (fail closed, no leak).
 */

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

test('valid login -> 200 with safe user, session, and cookies; anon key used upstream', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/login', {
      email: 'User@Example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.user.email, 'user@example.com');
    assert.equal(body.user.emailConfirmedAt, '2026-01-01T00:00:00.000Z');
    // The safe user shape: exactly the six public fields.
    assert.deepEqual(
      Object.keys(body.user).sort(),
      ['createdAt', 'displayName', 'email', 'emailConfirmedAt', 'id', 'lastSignInAt'],
    );
    assert.equal(body.session.refreshToken, 'gt-refresh-token-xyz789');

    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith('offanime_session=') && /HttpOnly/i.test(c)));
    assert.ok(cookies.some((c) => c.startsWith('offanime_refresh=') && /Path=\/api\/auth/i.test(c)));

    // Upstream: exactly one password-grant call with the anon key.
    assert.equal(installed.supabaseAuthCalls().length, 1);
    const call = installed.supabaseAuthCalls()[0];
    assert.ok(call.url.includes('/auth/v1/token?grant_type=password'));
    assert.equal(call.init.headers.apikey, TEST_ANON_KEY);
    assert.ok(String(call.init.body).includes('correct-horse-battery')); // provider request body only
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('invalid credentials -> 401 AUTH_INVALID_CREDENTIALS (upstream error body never echoed)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'invalid_credentials', 'Invalid login credentials'),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/login', {
      email: 'user@example.com',
      password: 'wrong-password-123',
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'AUTH_INVALID_CREDENTIALS');
    assert.equal(JSON.stringify(body).includes('wrong-password-123'), false, 'password echoed in error');
    // The upstream MESSAGE is never forwarded - only a safe status number.
    assert.equal(JSON.stringify(body).includes('Invalid login credentials'), false);
    assert.deepEqual(body.error.details, { upstreamStatus: 400 });
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('unconfirmed email -> 403 AUTH_EMAIL_NOT_CONFIRMED', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'email_not_confirmed', 'Email not confirmed'),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/login', {
      email: 'user@example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'AUTH_EMAIL_NOT_CONFIRMED');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('provider rate limit -> 429 RATE_LIMIT_ERROR', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(429, 'over_request_rate_limit', 'Too many requests'),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/login', {
      email: 'user@example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'RATE_LIMIT_ERROR');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('provider outage -> 502 AUTH_PROVIDER_ERROR (fail closed, no internals leaked)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => ({ status: 500, json: { msg: 'internal upstream explosion with secrets abc123' } }),
  });
  const server = await startTestServer();
  try {
    const res = await post(server.baseUrl, '/api/auth/login', {
      email: 'user@example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'AUTH_PROVIDER_ERROR');
    assert.equal(JSON.stringify(body).includes('explosion'), false, 'upstream body leaked');
  } finally {
    await server.stop();
    installed.restore();
  }
});
