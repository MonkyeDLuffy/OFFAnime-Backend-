/**
 * API key protection: production FAIL-CLOSED behavior.
 *
 * When NODE_ENV=production and BACKEND_API_SECRET is missing/empty, the
 * middleware must REJECT every protected request (500, "not configured")
 * instead of silently disabling authentication. /api/health stays public so
 * deployment probes still work, and CORS preflight is still not blocked.
 *
 * Runs in its own process (node --test runs each file separately), so
 * NODE_ENV and the (absent) secret can be pinned for the whole file.
 */

// Env setup MUST be the first import: this helper pins NODE_ENV=production and
// an EMPTY secret before config/env.js loads (transitively, via
// helpers/test-server.js).
import './helpers/test-env-api-key-fail-closed.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, resetL1Cache } from './helpers/test-server.js';

test('production WITHOUT a configured secret: protected endpoint FAILS CLOSED (500)', async () => {
  await resetL1Cache();
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search?q=cowboy`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    // The failure must be an explicit configuration failure, not an open API.
    assert.match(body.error.message, /not configured/i);
  } finally {
    await server.stop();
  }
});

test('production WITHOUT a configured secret: even a presented key fails closed (500)', async () => {
  await resetL1Cache();
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search?q=cowboy`, {
      headers: { Authorization: 'Bearer some-key' },
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'INTERNAL_ERROR');
  } finally {
    await server.stop();
  }
});

test('production WITHOUT a configured secret: /api/health stays public', async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  } finally {
    await server.stop();
  }
});

test('production WITHOUT a configured secret: CORS preflight still works', async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/search`, { method: 'OPTIONS' });
    assert.ok(res.status !== 401 && res.status !== 500, `preflight blocked (got ${res.status})`);
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
  } finally {
    await server.stop();
  }
});
