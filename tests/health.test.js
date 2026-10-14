/**
 * Functional test for the only live Phase 1 endpoint: GET /api/health.
 *
 * Uses the real Express app on an ephemeral port and the global fetch, so there
 * is no extra test dependency. Exercises the full middleware + route stack.
 */

// Keep logs quiet during tests; set BEFORE importing the app (ESM imports are
// hoisted, so env must be assigned before a dynamic import of config).
process.env.LOG_LEVEL = 'error';
// A TEST-ONLY secret so the fail-closed API-key middleware lets the protected
// route checks through (the key is sent explicitly in those fetch calls). A
// local .env can never leak in: dotenv does not override pre-set variables.
process.env.BACKEND_API_SECRET = 'test-only-default-secret';

import test from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../src/app.js');

/**
 * Start the app on a random free port and return its base URL + a stop fn.
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void> }>}
 */
async function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /api/health -> 200 and a healthy payload', async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'offanime-backend');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.timestamp, 'string');

    // Correlation header should always be present.
    assert.ok(res.headers.get('x-request-id'));
  } finally {
    await stop();
  }
});

test('unknown route -> 404 with structured error shape', async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    // Unknown /api/* routes sit BEHIND the API-key middleware, so the key is
    // required to reach the 404 handler (fail closed: unauthenticated callers
    // get 401, never route-existence information).
    const res = await fetch(`${baseUrl}/api/does-not-exist`, {
      headers: { Authorization: `Bearer ${process.env.BACKEND_API_SECRET}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally {
    await stop();
  }
});

test('Phase 8 route is live: /api/stream/resolve/:id validates input (no fake data)', async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    // `/api/stream/resolve/:id` is implemented since Phase 8; an invalid AniList
    // ID is rejected with 400 before any provider call. Protected route: the
    // API key must be presented explicitly (health above proves the public path).
    const res = await fetch(`${baseUrl}/api/stream/resolve/abc`, {
      headers: { Authorization: `Bearer ${process.env.BACKEND_API_SECRET}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  } finally {
    await stop();
  }
});
