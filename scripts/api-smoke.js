/**
 * Lightweight API smoke test (Phase 9).
 *
 * Boots the REAL Express app locally (createApp, no mocks required) and
 * verifies the app starts and the main routes respond with their expected
 * contract shapes - WITHOUT live providers:
 *
 *   - GET /api/health          -> 200 (no provider/cache calls by design)
 *   - GET /api/details/abc     -> 400 VALIDATION_ERROR (validated BEFORE any
 *                                 provider request, so no network needed)
 *   - GET /api/stream/resolve/abc -> 400 VALIDATION_ERROR (same)
 *   - GET /api/does-not-exist  -> 404 structured error shape
 *   - GET /api/jikan/anime/abc -> 400 VALIDATION_ERROR (same)
 *
 * Live-provider smoke coverage lives in the per-provider scripts
 * (scripts/anilist-smoke.js, jikan-smoke.js, tmdb-smoke.js, supabase-smoke.js)
 * which only run when their credentials are explicitly configured.
 *
 * Usage:
 *   node scripts/api-smoke.js
 * Exits 0 when every check passes, 1 on any failure.
 *
 * API-key note: the middleware FAILS CLOSED in every environment, so this
 * script pins a SMOKE-ONLY secret (before config/env.js loads - hence the
 * dynamic imports) and sends it on every request. A real deployment secret is
 * respected when configured via the environment.
 */

process.env.LOG_LEVEL = 'error';
process.env.BACKEND_API_SECRET ||= 'smoke-only-secret';

// Dynamic imports AFTER env setup (ESM static imports would hoist and load
// config/env.js before the env overrides above are applied).
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config/env.js');

/** @type {Array<{ name: string, check: () => Promise<void> | void }>} */
let checks = [];

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Minimal fetch against the local app (no dependencies). When a
 * BACKEND_API_SECRET is configured, the API-key credential is attached
 * automatically so protected-route checks stay valid.
 * @param {string} url
 * @returns {Promise<{ status: number, body: any }>}
 */
async function request(url) {
  const headers = config.BACKEND_API_SECRET
    ? { Authorization: `Bearer ${config.BACKEND_API_SECRET}` }
    : {};
  const response = await fetch(url, { headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // non-JSON body is allowed; checks decide whether that is acceptable
  }
  return { status: response.status, body };
}

/**
 * @param {string} baseUrl
 * @returns {Promise<void>}
 */
async function checkHealth(baseUrl) {
  const { status, body } = await request(`${baseUrl}/api/health`);
  assertOk(status === 200, `expected /api/health 200, received ${status}`);
  assertOk(body && typeof body === 'object', '/api/health returned a non-JSON body');
}

/**
 * @param {string} baseUrl
 */
async function checkValidationErrorBeforeProvider(baseUrl) {
  // Invalid IDs are rejected at 400 BEFORE any provider request - safe to run
  // with zero network access to live providers.
  for (const path of ['/api/details/abc', '/api/stream/resolve/abc', '/api/jikan/anime/abc']) {
    const { status, body } = await request(`${baseUrl}${path}`);
    assertOk(status === 400, `expected ${path} 400, received ${status}`);
    assertOk(
      body?.error?.code === 'VALIDATION_ERROR',
      `expected ${path} VALIDATION_ERROR, received ${JSON.stringify(body?.error?.code)}`,
    );
  }
}

/**
 * @param {string} baseUrl
 */
async function checkStructured404(baseUrl) {
  const { status, body } = await request(`${baseUrl}/api/does-not-exist`);
  assertOk(status === 404, `expected unknown route 404, received ${status}`);
  assertOk(
    body?.error?.code === 'NOT_FOUND',
    `expected NOT_FOUND error shape, received ${JSON.stringify(body?.error?.code)}`,
  );
}

/**
 * Only runs when BACKEND_API_SECRET is configured: proves protection is active
 * (missing key -> 401) and the key itself authorizes (health stays 200, and a
 * validation path behind auth is reachable with the credential).
 * @param {string} baseUrl
 */
async function checkApiKeyProtection(baseUrl) {
  const noKey = await fetch(`${baseUrl}/api/details/abc`);
  assertOk(noKey.status === 401, `expected protected route 401 without key, received ${noKey.status}`);
  const noKeyBody = await noKey.json();
  assertOk(
    noKeyBody?.error?.code === 'UNAUTHORIZED_ERROR',
    `expected UNAUTHORIZED_ERROR, received ${JSON.stringify(noKeyBody?.error?.code)}`,
  );

  const withKey = await request(`${baseUrl}/api/details/abc`);
  assertOk(withKey.status === 400, `expected protected route 400 with key, received ${withKey.status}`);
  assertOk(
    withKey.body?.error?.code === 'VALIDATION_ERROR',
    `expected VALIDATION_ERROR with key, received ${JSON.stringify(withKey.body?.error?.code)}`,
  );
}

/** Run the smoke checks against a freshly built app on an ephemeral port. */
export async function runSmoke() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  checks = [
    { name: 'GET /api/health -> 200', check: () => checkHealth(baseUrl) },
    { name: 'invalid IDs -> 400 before any provider call', check: () => checkValidationErrorBeforeProvider(baseUrl) },
    { name: 'unknown route -> structured 404', check: () => checkStructured404(baseUrl) },
    ...(config.BACKEND_API_SECRET
      ? [{ name: 'API key protection: 401 without key, authorized with key', check: () => checkApiKeyProtection(baseUrl) }]
      : []),
  ];

  let failed = 0;
  try {
    for (const { name, check } of checks) {
      try {
        await check();
        process.stdout.write(`ok   ${name}\n`);
      } catch (err) {
        failed += 1;
        process.stdout.write(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // Defer the exit so libuv finishes tearing down handles (avoids a libuv
    // assertion race on Windows); the unref'd timer also allows a natural
    // exit when nothing else keeps the event loop alive.
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 50).unref();
  }
  return { total: checks.length, failed };
}

// Run directly (not when imported by the node:test suite).
const isMain = process.argv[1] && import.meta.url === new URL(`file:///${String(process.argv[1]).replace(/\\/g, '/')}`).href;
if (isMain) {
  const { total, failed } = await runSmoke();
  process.stdout.write(`\n${total - failed}/${total} smoke checks passed\n`);
}
