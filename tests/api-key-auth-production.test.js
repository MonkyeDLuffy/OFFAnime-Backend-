/**
 * API key protection: production mode WITH a correctly configured secret.
 *
 * Proves the production path is not just fail-closed but fully functional:
 * a valid Bearer key authorizes the request and the response schema is
 * unchanged. Runs in its own process so NODE_ENV can be pinned to production.
 */

// Env setup MUST be the first import: this helper pins NODE_ENV=production and
// a TEST-ONLY secret before config/env.js loads (transitively, via
// helpers/test-server.js).
import './helpers/test-env-api-key-production.js';

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
// wrapper, so the invalid-key test below genuinely presents a WRONG credential.
const rawFetch = globalThis.fetch.bind(globalThis);

test('production WITH a configured secret: valid key -> 200, schema unchanged', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => anilistPage([anilistMedia({ id: 1, idMal: 11, title: 'Cowboy Bebop' })]),
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { Authorization: `Bearer ${TEST_SECRET}` },
    });
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

test('production WITH a configured secret: invalid key -> 401', async () => {
  await resetL1Cache();
  const mock = installApiMocks({ anilist: () => { throw new Error('must not be called'); } });
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  } finally {
    await server.stop();
    mock.restore();
  }
});
