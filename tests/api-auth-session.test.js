/**
 * Session endpoint tests: GET /api/auth/me, POST /api/auth/refresh,
 * POST /api/auth/logout (mocked GoTrue).
 *
 * Verified:
 *   - /me with Authorization: Bearer <access_token> (+ X-API-Key from the
 *     trusted proxy) -> 200 safe user. This also proves the API-key
 *     middleware accepts the DUAL header combination.
 *   - /me with the HttpOnly session cookie -> 200.
 *   - /me without any session -> 401 UNAUTHORIZED_ERROR.
 *   - /me with an expired/revoked token -> 401 AUTH_SESSION_EXPIRED.
 *   - /me NEVER trusts a client-submitted user id - identity comes only from
 *     what the token proves upstream.
 *   - refresh via body refresh token and via cookie; invalid -> 401.
 *   - logout revokes upstream, clears cookies, 401 without a session.
 */

import './helpers/test-env-auth.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { TEST_API_SECRET, gotrueUser, gotrueSessionResponse, gotrueError } from './helpers/gotrue-fixtures.js';

const rawFetch = globalThis.fetch.bind(globalThis);

/**
 * Request as the trusted proxy would (X-API-Key + optional extra headers).
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} path
 * @param {{ bearer?: string, cookie?: string, body?: object }} [options]
 */
function request(baseUrl, method, path, { bearer, cookie, body } = {}) {
  const headers = { 'X-API-Key': TEST_API_SECRET };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (cookie) headers.Cookie = cookie;
  return rawFetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('GET /api/auth/me with Bearer access token -> 200 safe user (dual-header proxy flow)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueUser({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/auth/me', { bearer: 'gt-access-token-abc123' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, 'user@example.com');
    assert.equal(JSON.stringify(body).includes('must-never-leak'), false);

    // Upstream verification happened (GET /auth/v1/user) with the user token.
    const calls = installed.supabaseAuthCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/auth/v1/user'));
    assert.equal(calls[0].init.headers.Authorization, 'Bearer gt-access-token-abc123');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('GET /api/auth/me with the session cookie -> 200 (no Bearer needed)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueUser({ email: 'cookie-user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/auth/me', {
      cookie: 'offanime_session=gt-access-token-abc123',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.email, 'cookie-user@example.com');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('GET /api/auth/me without any session -> 401 UNAUTHORIZED_ERROR (no upstream call)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('GET /api/auth/me with an expired/revoked token -> 401 AUTH_SESSION_EXPIRED', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(401, 'session_not_found', 'Session not found'),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/auth/me', { bearer: 'expired-token' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'AUTH_SESSION_EXPIRED');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('a client-submitted user id never establishes identity (token is the only proof)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueUser({ id: 'real-user-uuid', email: 'real@example.com' }),
  });
  const server = await startTestServer();
  try {
    // Attempt to spoof a victim's id via query/body - /me has no such input
    // and identity comes exclusively from the upstream-verified token.
    const res = await request(server.baseUrl, 'GET', '/api/auth/me?userId=victim-uuid', {
      bearer: 'gt-access-token-abc123',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, 'real-user-uuid', 'identity must come from the token, not the request');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/refresh with a body refresh token -> 200 fresh session', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({
      accessToken: 'gt-access-rotated-999',
      refreshToken: 'gt-refresh-rotated-888',
    }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/refresh', {
      body: { refreshToken: 'gt-refresh-token-xyz789' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session.accessToken, 'gt-access-rotated-999');
    assert.equal(body.session.refreshToken, 'gt-refresh-rotated-888');

    const calls = installed.supabaseAuthCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('grant_type=refresh_token'));
    assert.equal(JSON.parse(String(calls[0].init.body)).refresh_token, 'gt-refresh-token-xyz789');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/refresh with the HttpOnly refresh cookie -> 200 (no body token needed)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ accessToken: 'gt-access-rotated-777' }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/refresh', {
      cookie: 'offanime_refresh=gt-refresh-token-xyz789',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).session.accessToken, 'gt-access-rotated-777');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/refresh with an invalid/reused refresh token -> 401 AUTH_SESSION_EXPIRED', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'invalid_grant', 'Invalid Refresh Token'),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/refresh', {
      body: { refreshToken: 'stolen-or-reused-token' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'AUTH_SESSION_EXPIRED');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/logout revokes upstream, clears cookies, and is 401 without a session', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => new Response(null, { status: 204 }),
  });
  const server = await startTestServer();
  try {
    // With a session: 200 + cookies cleared.
    const res = await request(server.baseUrl, 'POST', '/api/auth/logout', { bearer: 'gt-access-token-abc123' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(installed.supabaseAuthCalls()[0].url.includes('/auth/v1/logout'), true);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith('offanime_session=') && /Expires=Thu, 01 Jan 1970/i.test(c)));
    assert.ok(cookies.some((c) => c.startsWith('offanime_refresh=') && /Path=\/api\/auth/i.test(c)));

    // Without a session: 401 (consistent error shape).
    const resNoSession = await request(server.baseUrl, 'POST', '/api/auth/logout');
    assert.equal(resNoSession.status, 401);
    assert.equal((await resNoSession.json()).error.code, 'UNAUTHORIZED_ERROR');
  } finally {
    await server.stop();
    installed.restore();
  }
});
