/**
 * API-key log-redaction tests.
 *
 * The optional ?api_key= direct-access method means URLs can carry the secret.
 * The backend must never log or echo it:
 *   - request-logger  (http.request lines)
 *   - error-handler   (request.error lines)
 *   - not-found       (404 message -> logs AND response body)
 *
 * This file pins LOG_LEVEL=debug (via its first-import helper) so warn-level
 * request logs are emitted, captures ALL process stdout/stderr writes while
 * requests run, and asserts the secret value never appears anywhere.
 */

// Env setup MUST be the first import (pins LOG_LEVEL=debug + the TEST-ONLY
// secret before config/env.js loads transitively via helpers/test-server.js).
import './helpers/test-env-api-key-logs.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, resetL1Cache } from './helpers/test-server.js';

const SECRET = process.env.BACKEND_API_SECRET;
const rawFetch = globalThis.fetch.bind(globalThis);

/**
 * Capture everything the process writes to stdout/stderr while `fn` runs.
 * The logger writes via console.* which targets these streams.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ result: T, output: string }>}
 */
async function captureOutput(fn) {
  const chunks = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const record = (write) => (chunk, encoding, cb) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return write(chunk, encoding, cb);
  };
  process.stdout.write = record(originalOut);
  process.stderr.write = record(originalErr);
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('the API key in a query string NEVER appears in application logs or error messages', async () => {
  await resetL1Cache();
  const server = await startTestServer();
  try {
    const { result: results, output } = await captureOutput(async () => {
      // 1. INVALID query key -> 401 (middleware error path, logged at warn).
      const unauthorized = await rawFetch(`${server.baseUrl}/api/search?q=x&api_key=wrong-key`);
      // 2. VALID header key on an unknown route -> 404; the not-found message
      //    reaches BOTH the logs and the response body.
      const notFound = await rawFetch(`${server.baseUrl}/api/does-not-exist?api_key=${SECRET}`, {
        headers: { 'X-API-Key': SECRET },
      });
      // 3. Valid query key -> 200; the completion log line includes the path.
      const authorized = await rawFetch(`${server.baseUrl}/api/search?q=x&api_key=${SECRET}`);
      return {
        unauthorized: { status: unauthorized.status, body: await unauthorized.text() },
        notFound: { status: notFound.status, body: await notFound.text() },
        authorized: { status: authorized.status, body: await authorized.text() },
      };
    });

    assert.equal(results.unauthorized.status, 401);
    assert.equal(results.notFound.status, 404);
    assert.equal(results.authorized.status, 200);

    // Prove logging actually happened during the capture window.
    assert.match(output, /http\.request/);
    assert.match(output, /request\.error/);

    // The raw secret must appear NOWHERE in stdout/stderr...
    assert.equal(output.includes(SECRET), false, 'the API key leaked into application logs');
    // ...nor in any response body (404 message echoes the URL - redacted).
    assert.equal(results.notFound.body.includes(SECRET), false, 'the API key leaked into an error response');
    // All three error/response bodies keep the consistent shape.
    assert.equal(JSON.parse(results.unauthorized.body).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(JSON.parse(results.notFound.body).error.code, 'NOT_FOUND');

    // And the redacted placeholder IS present where the URL was logged.
    assert.match(output, /api_key=%5BREDACTED%5D/);
  } finally {
    await server.stop();
  }
});

test('the raw query key never reaches controllers, services, or cache state', async () => {
  await resetL1Cache();
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/search?q=logcheck&api_key=${SECRET}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.results));
    // The middleware deletes req.query.api_key before controllers run; a
    // full-response scan confirms no field echoes it back.
    assert.equal(JSON.stringify(body).includes(SECRET), false);
  } finally {
    await server.stop();
  }
});
