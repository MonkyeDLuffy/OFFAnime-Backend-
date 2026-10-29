/**
 * API-key QUERY-PARAMETER authentication tests (?api_key= direct access).
 *
 * Policy under test (src/middleware/api-key-auth.js):
 *   - `?api_key=` is accepted ONLY on the approved GET endpoints
 *     (QUERY_KEY_APPROVED_GET_PATHS) and ONLY as the sole credential.
 *   - Header credentials (X-API-Key / Bearer) keep working on every protected
 *     route/method - this is the frontend server-side proxy flow.
 *   - Header + query together must be IDENTICAL; conflicting values are
 *     rejected (401) so an invalid credential can never ride along a valid one.
 *   - Query-only auth is rejected on unapproved routes and non-GET methods.
 *   - /api/health stays public; OPTIONS preflight is never blocked.
 *
 * All requests use rawFetch (captured before startTestServer installs its
 * auto-injecting header wrapper) so each test controls its exact credentials.
 */

// Env setup MUST be the first import (pins the TEST-ONLY secret before
// config/env.js loads transitively via helpers/test-server.js).
import './helpers/test-env-api-key.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
  anilistMedia,
  anilistPage,
} from './helpers/test-server.js';

const SECRET = process.env.BACKEND_API_SECRET;
const rawFetch = globalThis.fetch.bind(globalThis);

function installSearchMock() {
  return installApiMocks({
    anilist: () => anilistPage([anilistMedia({ id: 1, idMal: 11, title: 'Cowboy Bebop' })]),
  });
}

test('valid ?api_key= query param on an APPROVED GET endpoint -> 200, schema unchanged', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy&api_key=${SECRET}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.results) && body.results.length === 1);
    assert.equal(body.results[0].anilistId, 1);
    assert.equal(body.results[0].malId, 11);
    assert.ok(body.pageInfo);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('valid X-API-Key header (frontend server-side proxy flow) still succeeds', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { 'X-API-Key': SECRET },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).results));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('missing credentials -> 401 with the consistent error shape', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('INVALID query key on an approved GET endpoint -> 401', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy&api_key=wrong-key`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('query-only auth is ACCEPTED on the approved streaming routes', async () => {
  const server = await startTestServer();
  try {
    // Valid query key on an approved streaming route reaches the controller;
    // the invalid ID then produces a 400 from the controller (not a 401 from
    // the middleware). This proves query auth is now allowed on streaming.
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/abc?api_key=${SECRET}`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  } finally {
    await server.stop();
  }
});

test('query-only auth is ACCEPTED on the approved MAL streaming route (the exact task request shape)', async () => {
  const server = await startTestServer();
  try {
    // mal/:id with ?ep=1&language=sub&api_key=... — valid key accepted by
    // middleware; invalid id -> controller 400 (not middleware 401).
    const res = await rawFetch(
      `${server.baseUrl}/api/stream/resolve/mal/abc?ep=1&language=sub&api_key=${SECRET}`
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  } finally {
    await server.stop();
  }
});

test('valid query key on the approved mal streaming route with header present (identical) -> header policy applies', async () => {
  await resetL1Cache();
  const server = await startTestServer();
  try {
    const res = await rawFetch(
      `${server.baseUrl}/api/stream/resolve/mal/abc?ep=1&language=sub&api_key=${SECRET}`,
      { headers: { 'X-API-Key': SECRET } }
    );
    // Identical header + query -> treated as header credential -> controller reached -> 400
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  } finally {
    await server.stop();
  }
});

test('query-only auth is REJECTED on unapproved/unknown routes', async () => {
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/does-not-exist?api_key=${SECRET}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  } finally {
    await server.stop();
  }
});

test('query-only auth is REJECTED on non-GET methods (POST)', async () => {
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?api_key=${SECRET}`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  } finally {
    await server.stop();
  }
});

test('CONFLICTING header + query credentials -> 401 (valid header never overrides policy)', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const cases = [
      // valid header + invalid query
      { headers: { 'X-API-Key': SECRET }, url: `&api_key=wrong-value` },
      // invalid header + valid query
      { headers: { 'X-API-Key': 'wrong-value' }, url: `&api_key=${SECRET}` },
      // two DIFFERENT valid-format values
      { headers: { Authorization: `Bearer ${SECRET}` }, url: '&api_key=another-valid-looking-key' },
    ];
    for (const c of cases) {
      const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy${c.url}`, { headers: c.headers });
      assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(c.headers)} + ${c.url}`);
      assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    }
    // The conflict check short-circuits: no provider call was made.
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('IDENTICAL header + query credentials -> treated as one credential -> 200', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy&api_key=${SECRET}`, {
      headers: { 'X-API-Key': SECRET },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).results));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('identical header + query on an APPROVED streaming route -> header policy applies (controller reached)', async () => {
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/abc?api_key=${SECRET}`, {
      headers: { 'X-API-Key': SECRET },
    });
    // Header-authenticated requests pass the middleware: the invalid-ID
    // validation (400) proves the controller was reached. The query param is
    // redundant, not the reason for success.
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  } finally {
    await server.stop();
  }
});

test('malformed repeated query key (api_key=a&api_key=b) -> 401', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy&api_key=${SECRET}&api_key=${SECRET}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('empty api_key query value is treated as missing -> 401', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy&api_key=`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('CORS preflight with a query param is still NOT blocked', async () => {
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy&api_key=${SECRET}`, { method: 'OPTIONS' });
    assert.ok(res.status !== 401, `preflight must not be rejected as 401 (got ${res.status})`);
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
  } finally {
    await server.stop();
  }
});

test('GET /api/health stays public even when a query key is present', async () => {
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/health?api_key=whatever-value`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  } finally {
    await server.stop();
  }
});
