/**
 * Continue Watching endpoint tests (mocked GoTrue + Supabase REST - no live
 * calls). Mirrors tests/api-watchlist.test.js conventions.
 *
 * Verified:
 *   - a VERIFIED session is required for every operation (401 without one;
 *     query-parameter API keys are never sufficient - this is user data),
 *   - save accepts { anilistId, episode } with optional progress; title,
 *     poster, banner and other anime metadata are NOT required (the frontend
 *     hydrates display data through the existing anime endpoints),
 *   - save -> 200 { saved: true, entry }; repeat save updates the SAME row
 *     (upsert by user_id + anilist_id): episode/progress advance, no
 *     duplicates, updated_at moves forward,
 *   - GET returns only the verified user's entries, newest-watch first,
 *     with `progress` omitted when null,
 *   - invalid progress (negative / non-numeric) -> 400 VALIDATION_ERROR,
 *     missing anilistId/episode -> 400, storage never touched,
 *   - identity comes ONLY from the verified session: a userId supplied in the
 *     request body is ignored entirely; cross-user isolation (A never sees or
 *     removes B's rows),
 *   - the backend forwards the user token + anon key so Postgres RLS (see
 *     supabase/migrations/20261102000004_continue_watching.sql) enforces
 *     ownership; the service-role key is never used,
 *   - login -> both data sets fetchable -> logout (data NOT deleted) ->
 *     re-login: Continue Watching and Watchlist both persist across
 *     sessions/devices,
 *   - storage failures surface as typed 502 errors, never as raw 500s.
 */

import './helpers/test-env-auth.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { TEST_API_SECRET, TEST_ANON_KEY, gotrueUser, gotrueSessionResponse } from './helpers/gotrue-fixtures.js';
import { jsonResponse } from './helpers/mock-fetch.js';
import { routeThrottleRest, createThrottleState } from './helpers/auth-throttle-mocks.js';

const rawFetch = globalThis.fetch.bind(globalThis);

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_A = 'gt-access-token-user-a';
const TOKEN_B = 'gt-access-token-user-b';

/** GoTrue handler: GET /auth/v1/user returns the user for the presented token. */
function authHandler(tokenToUser) {
  return (url, call) => {
    if (url.includes('/auth/v1/user') && (call.method ?? 'GET') === 'GET') {
      const token = String(call.init.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
      const userId = tokenToUser[token];
      if (!userId) return { status: 401, json: { error_code: 'invalid_token', msg: 'invalid JWT' } };
      return { status: 200, json: gotrueUser({ id: userId, email: `${userId}@example.com` }) };
    }
    throw new Error(`unexpected auth call in continue-watching test: ${call.method} ${url}`);
  };
}

/** Minimal progress payload: anilistId + episode are the only required fields. */
function progressPayload(overrides = {}) {
  return { anilistId: 16498, episode: 10, ...overrides };
}

/**
 * Stateful in-memory emulation of the continue_watching PostgREST surface with
 * the production semantics that matter (PK conflict -> in-place update of
 * episode/progress/updated_at; created_at preserved). Every REST call is
 * recorded so tests can assert identity/filters/headers.
 */
function createContinueWatchingState() {
  return {
    /** `${user_id}:${anilist_id}` -> row */
    rows: new Map(),
    /** every REST call: { method, url, headers, body } */
    calls: [],
  };
}

/** @param {ReturnType<typeof createContinueWatchingState>} state */
function routeContinueWatchingRest(state, url, call) {
  const parsed = new URL(url);
  assert.ok(parsed.pathname.endsWith('/rest/v1/continue_watching'), `unexpected REST path: ${url}`);
  state.calls.push({
    method: call.method ?? 'GET',
    url,
    headers: call.init.headers ?? {},
    body: call.init.body !== undefined ? JSON.parse(String(call.init.body)) : undefined,
  });

  if ((call.method ?? 'GET') === 'POST') {
    // Emulates ON CONFLICT (user_id, anilist_id) DO UPDATE: episode,
    // progress and updated_at move forward; created_at is preserved.
    const body = state.calls[state.calls.length - 1].body;
    const key = `${body.user_id}:${body.anilist_id}`;
    const existing = state.rows.get(key);
    const now = new Date().toISOString();
    if (existing) {
      const row = {
        ...existing,
        ...body,
        created_at: existing.created_at,
        updated_at: now,
      };
      state.rows.set(key, row);
      return jsonResponse([row], 200);
    }
    const row = { ...body, created_at: now, updated_at: now };
    state.rows.set(key, row);
    return jsonResponse([row], 201);
  }

  if ((call.method ?? 'GET') === 'DELETE') {
    const userId = (parsed.searchParams.get('user_id') ?? '').replace(/^eq\./, '');
    const anilistId = (parsed.searchParams.get('anilist_id') ?? '').replace(/^eq\./, '');
    state.rows.delete(`${userId}:${anilistId}`);
    return new Response(null, { status: 204 });
  }

  const userId = (parsed.searchParams.get('user_id') ?? '').replace(/^eq\./, '');
  const rows = [...state.rows.values()]
    .filter((row) => row.user_id === userId)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return jsonResponse(rows, 200);
}

/** Route every Supabase REST call (throttle tables vs the CW/watchlist tables). */
function makeRestRouter({ cw, throttle, watchlist } = {}) {
  return (url, call) => {
    const path = new URL(url).pathname;
    if (path.includes('/auth_attempt_limits') || path.includes('/auth_signup_dedupe') || path.includes('/rpc/')) {
      return routeThrottleRest(throttle, url, call);
    }
    if (path.endsWith('/rest/v1/watchlist')) {
      assert.equal(call.method ?? 'GET', 'GET', 'watchlist mock only supports list');
      const parsed = new URL(url);
      const userId = (parsed.searchParams.get('user_id') ?? '').replace(/^eq\./, '');
      const rows = [...watchlist.rows.values()]
        .filter((row) => row.user_id === userId)
        .sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)))
        .map((row) => ({ anime_id: row.anime_id, added_at: row.added_at }));
      return jsonResponse(rows, 200);
    }
    return routeContinueWatchingRest(cw, url, call);
  };
}

function request(baseUrl, method, path, { token, body } = {}) {
  return rawFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-API-Key': TEST_API_SECRET,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('continue watching requires a verified session: 401 without a token, storage never touched', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    assert.equal((await request(server.baseUrl, 'GET', '/api/user/continue-watching')).status, 401);
    assert.equal((await request(server.baseUrl, 'POST', '/api/user/continue-watching', { body: progressPayload() })).status, 401);
    assert.equal((await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/16498')).status, 401);
    assert.equal(cw.calls.length, 0, 'no storage access without a session');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('query-parameter API keys are NOT accepted on user data endpoints', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const res = await rawFetch(`${server.baseUrl}/api/user/continue-watching?api_key=${TEST_API_SECRET}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(cw.calls.length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('save {anilistId, episode} without title/poster -> 200, progress omitted from response', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const saved = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload(),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.ok(savedBody.saved);
    const entry = savedBody.entry;
    assert.equal(entry.anilistId, 16498);
    assert.equal(entry.episode, 10);
    assert.equal(entry.progress, undefined, 'progress omitted when not provided');
    assert.ok(entry.updatedAt);
    assert.equal(cw.rows.size, 1);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('save {anilistId, episode, progress} -> entry includes progress', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const saved = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ progress: 35 }),
    });
    assert.equal(saved.status, 200);
    const entry = (await saved.json()).entry;
    assert.equal(entry.progress, 35);

    // GET reflects the stored progress.
    const list = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.count, 1);
    assert.equal(listBody.items[0].progress, 35);
    assert.equal(listBody.items[0].episode, 10);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('repeat save same anime -> 200: same single row updated, no duplicates', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const first = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ episode: 10, progress: 35 }),
    });
    assert.equal(first.status, 200);
    const firstEntry = (await first.json()).entry;
    const firstUpdatedAt = firstEntry.updatedAt;

    const second = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ episode: 11, progress: 300 }),
    });
    assert.equal(second.status, 200);
    const secondEntry = (await second.json()).entry;
    assert.equal(secondEntry.episode, 11);
    assert.equal(secondEntry.progress, 300);
    assert.ok(secondEntry.updatedAt > firstUpdatedAt, 'updated_at advanced');
    assert.equal(cw.rows.size, 1, 'upsert never created a duplicate row');

    const list = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal((await list.json()).count, 1);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('multiple anime tracked independently, ordered newest-watch first', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ anilistId: 16498, episode: 5, progress: 100 }),
    });
    await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ anilistId: 21, episode: 1, progress: 10 }),
    });

    const list = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.count, 2);
    assert.deepEqual(listBody.items.map((item) => item.anilistId), [21, 16498], 'most recent anime first');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('invalid progress / missing ids -> 400 VALIDATION_ERROR, storage never touched', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const invalid = [
      progressPayload({ anilistId: 'not-an-id' }),
      progressPayload({ episode: 'nope' }),
      progressPayload({ episode: 0 }),
      progressPayload({ progress: -5 }),
      progressPayload({ progress: 'abc' }),
      progressPayload({ progress: {} }),
      { episode: 1 },        // missing anilistId
      { anilistId: 21 },     // missing episode
      {},                    // nothing
    ];
    for (const body of invalid) {
      const res = await request(server.baseUrl, 'POST', '/api/user/continue-watching', { token: TOKEN_A, body });
      assert.equal(res.status, 400, `expected 400 for payload ${JSON.stringify(body)}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR', JSON.stringify(body));
    }
    assert.equal(cw.calls.length, 0, 'invalid payloads must never reach storage');
    assert.equal(cw.rows.size, 0);

    const badDelete = await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/nope', { token: TOKEN_A });
    assert.equal(badDelete.status, 400);
    assert.equal((await badDelete.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(cw.calls.length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('identity comes ONLY from the verified session (body userId is ignored)', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  cw.rows.set(`${USER_B}:30`, {
    user_id: USER_B, anilist_id: 30, episode: 1, progress: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A, [TOKEN_B]: USER_B }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ anilistId: 99, userId: USER_B }),
    });
    assert.equal(res.status, 200);

    const stored = [...cw.rows.values()].find((row) => row.anilist_id === 99);
    assert.equal(stored.user_id, USER_A, 'the stored owner must be the VERIFIED session user');
    assert.equal(cw.calls.find((c) => c.method === 'POST').body.user_id, USER_A);

    const listA = await (await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A })).json();
    assert.deepEqual(listA.items.map((item) => item.anilistId), [99]);
    const listB = await (await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_B })).json();
    assert.deepEqual(listB.items.map((item) => item.anilistId), [30]);

    const getCalls = cw.calls.filter((c) => c.method === 'GET');
    assert.ok(getCalls.some((c) => String(c.url).includes(`user_id=eq.${USER_A}`)));
    assert.ok(getCalls.some((c) => String(c.url).includes(`user_id=eq.${USER_B}`)));
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('cross-user isolation: removing another user\'s entry is impossible (scoped filters)', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  cw.rows.set(`${USER_B}:30`, {
    user_id: USER_B, anilist_id: 30, episode: 1, progress: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/30', { token: TOKEN_A });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, anilistId: 30 });
    assert.equal(cw.rows.has(`${USER_B}:30`), true, "B's row survives A's delete attempt");
    const deleteCall = cw.calls.find((c) => c.method === 'DELETE');
    assert.ok(String(deleteCall.url).includes(`user_id=eq.${USER_A}`));
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('remove flow: delete + repeat delete are idempotent successes', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A, body: progressPayload({ anilistId: 21 }),
    });
    assert.equal(cw.rows.size, 1);

    const removed = await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/21', { token: TOKEN_A });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, anilistId: 21 });

    const removedAgain = await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/21', { token: TOKEN_A });
    assert.equal(removedAgain.status, 200);
    assert.equal(cw.rows.size, 0);

    const after = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal((await after.json()).count, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('tampered session -> 401 AUTH_SESSION_EXPIRED; storage never touched', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: 'tampered-token' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'AUTH_SESSION_EXPIRED');
    assert.equal(cw.calls.length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('storage failure -> typed 502 PROVIDER_ERROR (never a raw 500)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: () => jsonResponse({ code: 'PGRST205', message: 'Could not find the table' }, 404),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');
    assert.equal(body.error.details.provider, 'supabase');
    assert.equal(body.error.details.operation, 'list');
    assert.equal(body.error.details.upstreamStatus, 404);
    assert.equal(body.error.details.upstreamCode, 'PGRST205');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('every storage call acts AS THE VERIFIED USER (anon apikey + user Bearer; no service-role)', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A, body: progressPayload({ progress: 7 }),
    });
    await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/16498', { token: TOKEN_A });

    for (const restCall of cw.calls) {
      assert.equal(restCall.headers.apikey, TEST_ANON_KEY, 'continue watching must use the anon apikey');
      assert.equal(restCall.headers.Authorization, `Bearer ${TOKEN_A}`, 'continue watching must act as the user');
      assert.equal(String(restCall.headers.Authorization).includes('service-role'), false);
    }
    const postCall = cw.calls.find((c) => c.method === 'POST');
    assert.ok(String(postCall.url).includes('on_conflict=user_id'), 'upsert needs an explicit conflict target');
    assert.equal(postCall.body.title === undefined, true, 'title is not stored');
    assert.equal(postCall.body.poster_url === undefined, true, 'poster is not stored');
    assert.ok(postCall.body.updated_at, 'updated_at moves on every save');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('login -> both data sets fetchable -> logout -> re-login: data persists across sessions/devices', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const throttle = createThrottleState();
  const watchlist = { rows: new Map([[`${USER_A}:1535`, { user_id: USER_A, anime_id: 1535, added_at: new Date().toISOString() }]]) };
  const GRANT_TOKENS = ['gt-access-e2e-first-login', 'gt-access-e2e-second-login'];
  let grantIndex = 0;

  function e2eAuthHandler() {
    return (url, call) => {
      if (url.includes('/auth/v1/user') && (call.method ?? 'GET') === 'GET') {
        const token = String(call.init.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
        const userId = { [GRANT_TOKENS[0]]: USER_A, [GRANT_TOKENS[1]]: USER_A }[token];
        if (!userId) return { status: 401, json: { error_code: 'invalid_token', msg: 'invalid JWT' } };
        return { status: 200, json: gotrueUser({ id: userId, email: 'viewer@example.com' }) };
      }
      if (url.includes('/auth/v1/token?grant_type=password')) {
        return gotrueSessionResponse({
          userId: USER_A,
          email: 'viewer@example.com',
          accessToken: GRANT_TOKENS[grantIndex],
        });
      }
      if (url.includes('/auth/v1/logout')) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected auth call: ${call.method ?? 'GET'} ${url}`);
    };
  }

  const installed = installApiMocks({
    supabaseAuth: e2eAuthHandler(),
    supabaseRest: makeRestRouter({ cw, throttle, watchlist }),
  });
  const server = await startTestServer();
  try {
    // LOGIN on device A
    grantIndex = 0;
    const login = await request(server.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'viewer@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.user.id, USER_A);
    const firstToken = loginBody.session.accessToken;
    assert.equal(firstToken, GRANT_TOKENS[0]);

    // Both user-data sets synchronize with the SAME verified session token.
    const wl = await request(server.baseUrl, 'GET', '/api/watchlist', { token: firstToken });
    assert.equal(wl.status, 200);
    assert.equal((await wl.json()).count, 1, 'the existing watchlist keeps working after login');

    const cwList = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: firstToken });
    assert.equal(cwList.status, 200);
    assert.equal((await cwList.json()).count, 0, 'continue watching empty before first progress');

    // Watch an episode -> progress saved.
    const saved = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: firstToken,
      body: progressPayload({ anilistId: 16498, episode: 10, progress: 300 }),
    });
    assert.equal(saved.status, 200);
    assert.equal(cw.rows.size, 1);

    // LOGOUT: revokes the session but NEVER deletes persistent records.
    const loggedOut = await request(server.baseUrl, 'POST', '/api/auth/logout', { token: firstToken });
    assert.equal(loggedOut.status, 200);
    assert.equal(cw.rows.size, 1, 'logout must not delete continue watching records');
    assert.equal(watchlist.rows.size, 1, 'logout must not delete watchlist records');

    // LOGIN on device B (new session) - same user's data reappears.
    grantIndex = 1;
    const login2 = await request(server.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'viewer@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(login2.status, 200);
    const secondToken = (await login2.json()).session.accessToken;
    assert.equal(secondToken, GRANT_TOKENS[1]);

    const resumed = await (await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: secondToken })).json();
    assert.equal(resumed.count, 1, 'continue watching survives logout/login (cross-device)');
    assert.equal(resumed.items[0].anilistId, 16498);
    assert.equal(resumed.items[0].episode, 10);
    assert.equal(resumed.items[0].progress, 300);
    const wl2 = await (await request(server.baseUrl, 'GET', '/api/watchlist', { token: secondToken })).json();
    assert.equal(wl2.count, 1, 'watchlist also survives (cross-device)');
  } finally {
    await server.stop();
    installed.restore();
  }
});
