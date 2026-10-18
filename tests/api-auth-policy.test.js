/**
 * Auth ROUTE POLICY tests: how /api/auth/* interacts with the central
 * API-key middleware, CSRF origin guard, and CORS credentials.
 *
 * Deliberate policy under test (see routes/index.js + README):
 *   - /api/auth/* sits BEHIND the API-key middleware: no key -> 401, wrong
 *     key -> 401, valid key -> controller reached. The browser never holds
 *     the key; the trusted proxy adds it.
 *   - A USER session token in Authorization is NOT an API key: a request
 *     carrying only `Authorization: Bearer <user-token>` is rejected - the
 *     proxy must present its own X-API-Key.
 *   - The DUAL combination (X-API-Key + Authorization Bearer user token) is
 *     accepted - user-session requests ride the proxy's key.
 *   - Cookie-authenticated state-changing requests with a foreign Origin are
 *     CSRF-rejected (403) - defense in depth on top of SameSite=Lax.
 *   - Query-param API keys are NOT accepted on auth endpoints (GET-only
 *     allowlist does not include POST /api/auth/*).
 *   - CORS: with an explicit origin allowlist, credentialed CORS headers are
 *     emitted (cookie mode requirement).
 */

// This file needs an EXPLICIT CORS_ORIGIN allowlist (cookie/CSRF behavior).
import './helpers/test-env-auth-cors.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { TEST_API_SECRET, TEST_ANON_KEY, gotrueSessionResponse } from './helpers/gotrue-fixtures.js';

const rawFetch = globalThis.fetch.bind(globalThis);

function login(baseUrl, { headers = {}, body } = {}) {
  return rawFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const validLoginBody = { email: 'user@example.com', password: 'correct-horse-battery' };

test('login WITHOUT any API credential -> 401 from the API-key middleware (controller never reached)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await login(server.baseUrl, { body: validLoginBody });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('login with ONLY a user Bearer token -> 401 (a session is not an API key)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await login(server.baseUrl, {
      body: validLoginBody,
      headers: { Authorization: 'Bearer gt-access-token-abc123' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('login with a WRONG API key -> 401 even with a valid user token present', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await login(server.baseUrl, {
      body: validLoginBody,
      headers: { 'X-API-Key': 'wrong-key', Authorization: 'Bearer gt-access-token-abc123' },
    });
    assert.equal(res.status, 401);
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('login with the proxy key (X-API-Key) -> 200 (trusted proxy flow works)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await login(server.baseUrl, {
      body: validLoginBody,
      headers: { 'X-API-Key': TEST_API_SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.email, 'user@example.com');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('DUAL header combination (proxy key + user session token) reaches the controller -> 200', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    const res = await login(server.baseUrl, {
      body: validLoginBody,
      headers: { 'X-API-Key': TEST_API_SECRET, Authorization: 'Bearer gt-access-token-abc123' },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.email, 'user@example.com');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('query-param API key is NOT accepted on auth POSTs (GET-only allowlist policy)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/auth/login?api_key=${TEST_API_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validLoginBody),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('CSRF: cookie-authenticated login POST with a foreign Origin -> 403 FORBIDDEN', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await login(server.baseUrl, {
      body: validLoginBody,
      headers: {
        'X-API-Key': TEST_API_SECRET,
        Cookie: 'offanime_session=gt-access-token-abc123',
        Origin: 'https://evil.example',
      },
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'FORBIDDEN');
    assert.equal(installed.supabaseAuthCalls().length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('CSRF: same request from the ALLOWED origin passes; no-cookie requests are unaffected', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    // Allowed origin + cookie -> reaches the controller.
    const allowed = await login(server.baseUrl, {
      body: validLoginBody,
      headers: {
        'X-API-Key': TEST_API_SECRET,
        Cookie: 'offanime_session=gt-access-token-abc123',
        Origin: 'https://offanime.example',
      },
    });
    assert.equal(allowed.status, 200);

    // Allowed origin WITHOUT any cookie -> the CSRF guard is not applicable.
    const noCookie = await login(server.baseUrl, {
      body: validLoginBody,
      headers: { 'X-API-Key': TEST_API_SECRET, Origin: 'https://offanime.example' },
    });
    assert.equal(noCookie.status, 200);

    // Foreign origin WITHOUT a cookie -> guard not applicable (Bearer/none
    // cannot be CSRF-forged); controller reached.
    const foreignNoCookie = await login(server.baseUrl, {
      body: validLoginBody,
      headers: { 'X-API-Key': TEST_API_SECRET, Origin: 'https://evil.example' },
    });
    assert.equal(foreignNoCookie.status, 200);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('CORS preflight for the trusted proxy flow -> credentialed CORS headers emitted', async () => {
  await resetL1Cache();
  const installed = installApiMocks({});
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://offanime.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-api-key,content-type,authorization',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://offanime.example');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
    assert.ok(/x-api-key/i.test(allowHeaders), 'x-api-key must be allowed for the proxy');
    assert.ok(/authorization/i.test(allowHeaders), 'authorization must be allowed for user sessions');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('existing data routes remain API-key protected and unchanged (search still works)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    anilist: () => ({
      status: 200,
      json: { data: { Page: { pageInfo: { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false, perPage: 20 }, media: [] } } },
    }),
  });
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { 'X-API-Key': TEST_API_SECRET },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).results));
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('auth endpoints never send the service-role key upstream', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: () => gotrueSessionResponse({ email: 'user@example.com' }),
  });
  const server = await startTestServer();
  try {
    await login(server.baseUrl, { body: validLoginBody, headers: { 'X-API-Key': TEST_API_SECRET } });
    for (const call of installed.supabaseAuthCalls()) {
      assert.equal(call.init.headers.apikey, TEST_ANON_KEY);
      assert.equal(
        String(call.init.headers.Authorization).includes('service-role'),
        false,
        'service-role key must never be used for auth',
      );
    }
  } finally {
    await server.stop();
    installed.restore();
  }
});
