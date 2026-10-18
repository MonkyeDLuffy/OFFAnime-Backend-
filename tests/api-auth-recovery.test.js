/**
 * Password-reset / email-verification endpoint tests (mocked GoTrue):
 *   POST /api/auth/password-reset  - request a reset email (uniform response,
 *                                    no user enumeration)
 *   POST /api/auth/verify          - exchange a one-time link token
 *   POST /api/auth/password-update - set a new password (session required)
 *   POST /api/auth/resend          - resend confirmation/recovery email
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
 * @param {{ bearer?: string, body?: object }} [options]
 */
function request(baseUrl, method, path, { bearer, body } = {}) {
  const headers = { 'X-API-Key': TEST_API_SECRET };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return rawFetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('POST /api/auth/password-reset -> 200 ok (uniform response, no user enumeration)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => ({ status: 200, json: {} }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/password-reset', {
      body: { email: 'maybe-existing@example.com' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const calls = installed.supabaseAuthCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/auth/v1/recover'));
    assert.equal(JSON.parse(String(calls[0].init.body)).email, 'maybe-existing@example.com');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/password-reset with a malformed email -> 400, no upstream call', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/password-reset', {
      body: { email: 'nope' },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/verify (signup confirmation token) -> 200 session + cookies', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'verified@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/verify', {
      body: { type: 'signup', tokenHash: 'one-time-link-hash' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, 'verified@example.com');
    assert.ok(body.session.accessToken.startsWith('gt-access-token'));

    const calls = installed.supabaseAuthCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/auth/v1/verify'));
    assert.equal(JSON.parse(String(calls[0].init.body)).token_hash, 'one-time-link-hash');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/verify (recovery token) -> 200 session (password reset completion)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'recovering@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/verify', {
      body: { type: 'recovery', token: 'link-otp-token' },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).session.tokenType, 'bearer');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/verify with an expired/invalid link -> 401 AUTH_SESSION_EXPIRED', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueError(400, 'otp_expired', 'Email link is invalid or has expired'),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/verify', {
      body: { type: 'recovery', token: 'used-link' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'AUTH_SESSION_EXPIRED');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/verify with an unsupported type or missing token -> 400', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const badType = await request(server.baseUrl, 'POST', '/api/auth/verify', {
      body: { type: 'magiclink', token: 'x' },
    });
    assert.equal(badType.status, 400);
    const noToken = await request(server.baseUrl, 'POST', '/api/auth/verify', { body: { type: 'signup' } });
    assert.equal(noToken.status, 400);
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/password-update with a valid session -> 200 updated user', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueUser({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/password-update', {
      bearer: 'gt-access-token-abc123',
      body: { password: 'new-secret-password-9' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, 'user@example.com');

    // Two upstream calls BY DESIGN: requireUser verifies the presented token
    // (GET /user), then the update runs (PUT /user). Identity is proven twice,
    // never assumed.
    const calls = installed.supabaseAuthCalls();
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes('/auth/v1/user'));
    assert.equal(calls[0].method, 'GET');
    assert.ok(calls[1].url.includes('/auth/v1/user'));
    assert.equal(calls[1].method, 'PUT');
    assert.equal(JSON.parse(String(calls[1].init.body)).password, 'new-secret-password-9');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/password-update without a session -> 401 (no password change)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/password-update', {
      body: { password: 'new-secret-password-9' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('POST /api/auth/resend -> 200 ok (confirmation email re-sent)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => ({ status: 200, json: {} }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/auth/resend', {
      body: { type: 'signup', email: 'pending@example.com' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(installed.supabaseAuthCalls()[0].url.includes('/auth/v1/resend'));
  } finally {
    await server.stop();
    installed.restore();
  }
});
