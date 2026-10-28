/**
 * Auth LOG-HYGIENE tests: passwords, access tokens, and refresh tokens must
 * NEVER appear in application logs (stdout/stderr), even at debug level, on
 * success AND failure paths. Runs with LOG_LEVEL=debug (via its first-import
 * helper) so every log line is emitted and captured.
 */

import './helpers/test-env-auth-logs.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { TEST_API_SECRET, gotrueSessionResponse, gotrueError } from './helpers/gotrue-fixtures.js';

const rawFetch = globalThis.fetch.bind(globalThis);
const PASSWORD = 'super-secret-password-123';
const ACCESS_TOKEN = 'gt-access-token-abc123';
const REFRESH_TOKEN = 'gt-refresh-token-xyz789';

/**
 * Capture everything the process writes to stdout/stderr while `fn` runs.
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

test('passwords and session tokens never appear in application logs', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: (url) => {
      if (url.includes('/auth/v1/signup')) return gotrueSessionResponse({ email: 'log-user@example.com' });
      if (url.includes('/auth/v1/user')) return gotrueSessionResponse({ email: 'log-user@example.com' });
      return gotrueError(400, 'invalid_credentials', 'Invalid login credentials');
    },
  });
  const server = await startTestServer();
  try {
    const { result: results, output } = await captureOutput(async () => {
      // 1. Successful signup (password + tokens in play; session cookies set).
      const signup = await rawFetch(`${server.baseUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_SECRET },
        body: JSON.stringify({ email: 'log-user@example.com', password: PASSWORD }),
      });
      // 2. FAILED login (error path - request.error logged at warn).
      const failedLogin = await rawFetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_SECRET },
        body: JSON.stringify({ email: 'log-user@example.com', password: PASSWORD }),
      });
      // 3. Authenticated /me (access token in play; verified upstream).
      const me = await rawFetch(`${server.baseUrl}/api/auth/me`, {
        headers: { 'X-API-Key': TEST_API_SECRET, Authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      return {
        signup: { status: signup.status, body: await signup.text() },
        failedLogin: { status: failedLogin.status, body: await failedLogin.text() },
        me: { status: me.status, body: await me.text() },
      };
    });

    assert.equal(results.signup.status, 201);
    assert.equal(results.failedLogin.status, 401);
    assert.equal(results.me.status, 200);

    // Prove logging actually happened during the capture window.
    assert.match(output, /http\.request/);
    assert.match(output, /request\.error/);

    // The credential material must appear NOWHERE in stdout/stderr...
    assert.equal(output.includes(PASSWORD), false, 'password leaked into application logs');
    assert.equal(output.includes(ACCESS_TOKEN), false, 'access token leaked into application logs');
    assert.equal(output.includes(REFRESH_TOKEN), false, 'refresh token leaked into application logs');
    assert.equal(output.includes(TEST_API_SECRET), false, 'API key leaked into application logs');
    // ...nor be echoed back in any response body.
    assert.equal(results.failedLogin.body.includes(PASSWORD), false);
  } finally {
    await server.stop();
    installed.restore();
  }
});
