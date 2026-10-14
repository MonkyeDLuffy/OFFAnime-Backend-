/**
 * API key protection tests (development mode with a configured secret).
 *
 * Uses the real Express app on an ephemeral port; the secret is a TEST-ONLY
 * value set before any app import (config/env.js loads once per process, and
 * dotenv never overrides pre-set variables, so a local .env cannot interfere).
 *
 * Covered here:
 *   1. Protected endpoint without an API key            -> 401
 *   2. Protected endpoint with an invalid key           -> 401 (both headers)
 *   3. Protected endpoint with the correct key          -> 200 (Bearer + x-api-key)
 *   4. Wrong Authorization scheme (no Bearer)           -> 401
 *   5. CORS OPTIONS preflight without credentials       -> NOT blocked
 *   6. /api/health stays public (no key required)
 *   7. Authorized response schemas unchanged (search contract)
 * Production fail-closed behavior is covered in api-key-auth-fail-closed.test.js
 * and api-key-auth-production.test.js (each test file is its own process, so
 * NODE_ENV/secret can be pinned per file).
 */

// Env setup MUST be the first import: this helper pins the TEST-ONLY secret
// before config/env.js loads (transitively, via helpers/test-server.js).
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

const TEST_SECRET = process.env.BACKEND_API_SECRET;

// Raw fetch captured BEFORE startTestServer() installs its auto-injecting
// wrapper. Rejection tests MUST use this so requests genuinely go out without
// a key (or with an invalid one); localhost calls never need the provider
// mocks, which only route external hosts.
const rawFetch = globalThis.fetch.bind(globalThis);

/** @param {string} query */
function anilistKind(query) {
  if (query.includes('Page(') && query.includes('media(')) return 'search';
  return 'other';
}

function installSearchMock() {
  return installApiMocks({
    anilist: (body) => {
      if (anilistKind(body.query) !== 'search') throw new Error(`expected search, got: ${body.query}`);
      return anilistPage([anilistMedia({ id: 1, idMal: 11, title: 'Cowboy Bebop' })]);
    },
  });
}

test('protected endpoint WITHOUT an API key -> 401 UNAUTHORIZED_ERROR', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED_ERROR');
    // The response must not leak or hint at the expected secret.
    assert.equal(JSON.stringify(body).includes(TEST_SECRET), false);
    // The middleware short-circuits BEFORE the controller: no provider call.
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('protected endpoint with an INVALID key -> 401 (Authorization and x-api-key)', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const bearer = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { Authorization: `Bearer wrong-key-${TEST_SECRET.length}` },
    });
    assert.equal(bearer.status, 401);
    assert.equal((await bearer.json()).error.code, 'UNAUTHORIZED_ERROR');

    const xApiKey = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { 'x-api-key': 'wrong-key' },
    });
    assert.equal(xApiKey.status, 401);
    assert.equal((await xApiKey.json()).error.code, 'UNAUTHORIZED_ERROR');

    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('protected endpoint with the CORRECT key -> 200, unchanged response schema', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    // Preferred header: Authorization: Bearer <secret>
    const bearer = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { Authorization: `Bearer ${TEST_SECRET}` },
    });
    assert.equal(bearer.status, 200);
    const body = await bearer.json();
    // Schema identical to the pre-protection contract (api-search.test.js).
    assert.ok(Array.isArray(body.results) && body.results.length === 1);
    assert.equal(body.results[0].id, 1);
    assert.equal(body.results[0].anilistId, 1);
    assert.equal(body.results[0].malId, 11);
    assert.equal(body.results[0].title, 'Cowboy Bebop');
    assert.ok(body.pageInfo);

    // Accepted fallback header: x-api-key: <secret>
    const xApiKey = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { 'x-api-key': TEST_SECRET },
    });
    assert.equal(xApiKey.status, 200);
    assert.ok(Array.isArray((await xApiKey.json()).results));
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('Authorization header WITHOUT the Bearer scheme -> 401', async () => {
  await resetL1Cache();
  const mock = installSearchMock();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { Authorization: TEST_SECRET },
    });
    assert.equal(res.status, 401);
    assert.equal(mock.anilistCalls().length, 0);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('CORS OPTIONS preflight is NOT blocked by the API-key middleware', async () => {
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, { method: 'OPTIONS' });
    assert.ok(res.status !== 401, `preflight must not be rejected as 401 (got ${res.status})`);
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
  } finally {
    await server.stop();
  }
});

test('GET /api/health stays PUBLIC (no API key required)', async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'offanime-backend');
  } finally {
    await server.stop();
  }
});
