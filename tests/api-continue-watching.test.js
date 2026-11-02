/**
 * Continue Watching endpoint tests (mocked GoTrue + Supabase REST - no live
 * calls). Mirrors tests/api-watchlist.test.js conventions.
 *
 * Verified:
 *   - a VERIFIED session is required for every operation (401 without one;
 *     query-parameter API keys are never sufficient - this is user data),
 *   - save -> 201 (fresh row) / repeat save -> 200 (same single row updated:
 *     NO duplicates; episode/position advance, created_at preserved),
 *   - episode completion: position is clamped to the duration and the anime
 *     entry REMAINS (finishing one episode never closes the anime),
 *   - multiple anime are tracked independently and list newest-watch-first,
 *   - invalid progress payloads -> 400 VALIDATION_ERROR without storage access,
 *   - identity comes ONLY from the verified session: a userId supplied in the
 *     request body is ignored entirely; cross-user isolation (A never sees or
 *     removes B's rows),
 *   - the backend forwards the user token + anon key so Postgres RLS (see
 *     supabase/migrations/20261102000004_continue_watching.sql) enforces
 *     ownership; the service-role key is never used,
 *   - login -> logout -> re-login: both data sets are fetchable with the
 *     login session and persist across sessions (nothing is deleted on
 *     logout),
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

/**
 * Minimal sample payloads exercising every optional column.
 * @param {object} [overrides]
 */
function progressPayload(overrides = {}) {
  return {
    anilistId: 16498,
    malId: 21,
    title: 'One Piece',
    titleEnglish: 'One Piece',
    titleRomaji: 'One Piece',
    posterUrl: 'https://img.example/one-piece-poster.jpg',
    bannerUrl: 'https://img.example/one-piece-banner.jpg',
    episode: 10,
    position: 300.5,
    duration: 1440,
    language: 'sub',
    ...overrides,
  };
}

/**
 * Stateful in-memory emulation of the continue_watching PostgREST surface with
 * the production semantics that matter (PK conflict -> in-place update with
 * created_at preserved + updated_at refreshed by the DB trigger). Every REST
 * call is recorded so tests can assert identity/filters/headers.
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
    // Emulates ON CONFLICT (user_id, anilist_id) DO UPDATE + the touch trigger:
    // provided columns overwrite, created_at is preserved, updated_at moves.
    const body = state.calls[state.calls.length - 1].body;
    const key = `${body.user_id}:${body.anilist_id}`;
    const existing = state.rows.get(key);
    if (existing) {
      const row = { ...existing, ...body, created_at: existing.created_at, updated_at: new Date().toISOString() };
      state.rows.set(key, row);
      return jsonResponse([row], 200);
    }
    const now = new Date().toISOString();
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
    .sort((a, b) => String(b.last_watched_at).localeCompare(String(a.last_watched_at)));
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
      // GET-only emulation: newest first, scoped by the user_id filter.
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
    // The GET path is NOT in the query-key approved list (user data), so a
    // query-only key must not bypass authentication.
    const res = await rawFetch(`${server.baseUrl}/api/user/continue-watching?api_key=${TEST_API_SECRET}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(cw.calls.length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('save -> 201 fresh row; repeat save -> 200: same record updated, no duplicates, created_at preserved', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    // FIRST SAVE
    const first = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload(),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.ok(firstBody.saved);
    const entry = firstBody.entry;
    assert.equal(entry.anilistId, 16498);
    assert.equal(entry.malId, 21);
    assert.equal(entry.title, 'One Piece');
    assert.equal(entry.titleEnglish, 'One Piece');
    assert.equal(entry.titleRomaji, 'One Piece');
    assert.ok(entry.posterUrl);
    assert.ok(entry.bannerUrl);
    assert.equal(entry.episode, 10);
    assert.equal(entry.positionSeconds, 300.5);
    assert.equal(entry.durationSeconds, 1440);
    assert.equal(entry.language, 'sub');
    assert.ok(entry.createdAt && entry.updatedAt && entry.lastWatchedAt);
    assert.equal(cw.rows.size, 1, 'exactly one row for (user, anime)');

    // REPEAT SAVE: progress moves forward - same row updated in place.
    const second = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ episode: 11, position: 720, language: 'dub', malId: 21 }),
    });
    assert.equal(second.status, 200, 'an update of existing progress is a 200');
    const secondBody = await second.json();
    assert.equal(secondBody.entry.episode, 11);
    assert.equal(secondBody.entry.positionSeconds, 720);
    assert.equal(secondBody.entry.language, 'dub');
    assert.equal(secondBody.entry.createdAt, entry.createdAt, 'created_at preserved across updates');
    assert.ok(secondBody.entry.updatedAt > entry.updatedAt, 'updated_at advanced');
    assert.equal(cw.rows.size, 1, 'upsert never created a duplicate row');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('episode completion: position clamps to duration and the anime entry REMAINS', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    //finished episode: position beyond duration
    const done = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ episode: 10, position: 9999, duration: 1440 }),
    });
    assert.equal(done.status, 201);
    const doneBody = await done.json();
    assert.equal(doneBody.entry.positionSeconds, 1440, 'position clamped, never rejected');

    // Next episode starts - the same anime keeps progressing (one row).
    const next = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ episode: 11, position: 5, duration: 1440, language: 'sub' }),
    });
    assert.equal(next.status, 200);
    assert.equal(cw.rows.size, 1, 'no anime-completed concept: entry stays');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('multiple anime are tracked independently and ordered newest-watch first', async () => {
  await resetL1Cache();
  const cw = createContinueWatchingState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    const a = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ anilistId: 16498, title: 'One Piece' }),
    });
    assert.equal(a.status, 201);
    // Save a second anime - it was watched later, so it sorts first.
    const b = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ anilistId: 21, malId: 1, title: 'Another Anime', duration: undefined }),
    });
    assert.equal(b.status, 201);

    const list = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.count, 2);
    assert.deepEqual(listBody.items.map((item) => item.anilistId), [21, 16498], 'most recent anime first');
    assert.equal(listBody.items[0].title, 'Another Anime');
    assert.equal(listBody.items[0].episode, 10);
    // Anime without a reported duration stores null (optional column).
    assert.equal(listBody.items[0].durationSeconds, null);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('invalid progress payloads -> 400 VALIDATION_ERROR, storage never touched', async () => {
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
      progressPayload({ malId: 'nope' }),
      progressPayload({ title: '' }),
      progressPayload({ title: '   ' }),
      progressPayload({ posterUrl: undefined }),
      progressPayload({ episode: 0 }),
      progressPayload({ episode: -1 }),
      progressPayload({ position: -5 }),
      progressPayload({ position: 'abc' }),
      progressPayload({ position: {} }),   // JSON round-trips to NaN
      progressPayload({ duration: 0 }),
      progressPayload({ duration: -3 }),
      progressPayload({ language: 'september' }),
      progressPayload({ language: '' }),
      { anilistId: 20 }, // everything else missing
      {}, // nothing at all
    ];
    for (const body of invalid) {
      const res = await request(server.baseUrl, 'POST', '/api/user/continue-watching', { token: TOKEN_A, body });
      assert.equal(res.status, 400, `expected 400 for payload ${JSON.stringify(body)}`);
      const problem = await res.json();
      assert.equal(problem.error.code, 'VALIDATION_ERROR', JSON.stringify(body));
    }
    assert.equal(cw.calls.length, 0, 'invalid payloads must never reach storage');
    assert.equal(cw.rows.size, 0);

    // DELETE with a malformed id -> 400 as well, no storage call.
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
  // A row owned by user B must never appear for user A.
  cw.rows.set(`${USER_B}:30`, {
    user_id: USER_B, anilist_id: 30, mal_id: null, title: 'B anime', poster_url: 'https://img/b.jpg',
    episode: 1, position_seconds: 1, language: 'sub',
    last_watched_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A, [TOKEN_B]: USER_B }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    // Attempt a confused-deputy save: session = A, body claims userId = B.
    const res = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: TOKEN_A,
      body: progressPayload({ anilistId: 99, userId: USER_B, malId: undefined }),
    });
    assert.equal(res.status, 201);

    const stored = [...cw.rows.values()].find((row) => row.anilist_id === 99);
    assert.equal(stored.user_id, USER_A, 'the stored owner must be the VERIFIED session user');
    assert.equal(cw.calls.find((c) => c.method === 'POST').body.user_id, USER_A);
    assert.equal(stored.mal_id, undefined, 'absent optional malId stays absent');

    // User A's list contains only A's rows (never B's).
    const listA = await (await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A })).json();
    assert.deepEqual(listA.items.map((item) => item.anilistId), [99]);
    const listB = await (await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_B })).json();
    assert.deepEqual(listB.items.map((item) => item.anilistId), [30]);

    // The list calls filtered by the VERIFIED user id.
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
    user_id: USER_B, anilist_id: 30, mal_id: null, title: 'B anime', poster_url: 'https://img/b.jpg',
    episode: 1, position_seconds: 1, language: 'sub',
    last_watched_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: makeRestRouter({ cw }),
  });
  const server = await startTestServer();
  try {
    // User A tries to delete user B's anime id.
    const res = await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/30', { token: TOKEN_A });
    assert.equal(res.status, 200); // idempotent success for A (nothing of A's was removed)
    assert.deepEqual(await res.json(), { ok: true, anilistId: 30 });
    // User B's row survives (the DELETE filter carried A's verified id only).
    assert.equal(cw.rows.has(`${USER_B}:30`), true);
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
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }), // 'tampered-token' is unknown
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
    supabaseRest: () => jsonResponse({ code: '42501', message: 'permission denied for table continue_watching' }, 403),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PROVIDER_ERROR');
    assert.equal(body.error.details.provider, 'supabase');
    assert.equal(body.error.details.operation, 'list');
    assert.equal(body.error.details.upstreamStatus, 403);
    assert.equal(body.error.details.upstreamCode, '42501');
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
      token: TOKEN_A, body: progressPayload(),
    });
    await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: TOKEN_A });
    await request(server.baseUrl, 'DELETE', '/api/user/continue-watching/16498', { token: TOKEN_A });

    for (const restCall of cw.calls) {
      assert.equal(restCall.headers.apikey, TEST_ANON_KEY, 'continue watching must use the anon apikey');
      assert.equal(restCall.headers.Authorization, `Bearer ${TOKEN_A}`, 'continue watching must act as the user');
      assert.equal(String(restCall.headers.Authorization).includes('service-role'), false);
    }
    // The save targeted the (user_id, anilist_id) conflict pair -> single upsert,
    // no read-before-write, updated_at/created_at never sent by the backend.
    const postCall = cw.calls.find((c) => c.method === 'POST');
    assert.ok(String(postCall.url).includes('on_conflict=user_id'), 'upsert needs an explicit conflict target');
    assert.equal(postCall.body.created_at === undefined, true, 'created_at is DB-managed');
    assert.equal(postCall.body.updated_at === undefined, true, 'updated_at is DB-managed (trigger)');
    assert.ok(postCall.body.last_watched_at, 'last_watched_at moves on every save');
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
        // Each login acts as a NEW device/session: fresh access token.
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
    const wlBody = await wl.json();
    assert.equal(wlBody.count, 1, 'the existing watchlist keeps working after login');
    assert.equal(wlBody.items[0].animeId, 1535);

    const cwList = await request(server.baseUrl, 'GET', '/api/user/continue-watching', { token: firstToken });
    assert.equal(cwList.status, 200);
    assert.equal((await cwList.json()).count, 0, 'continue watching empty before first progress');

    // Watch an episode -> progress saved (this is the new feature).
    const saved = await request(server.baseUrl, 'POST', '/api/user/continue-watching', {
      token: firstToken,
      body: progressPayload({ anilistId: 16498, episode: 10, position: 300 }),
    });
    assert.equal(saved.status, 201);
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
    assert.equal(resumed.items[0].positionSeconds, 300);
    const wl2 = await (await request(server.baseUrl, 'GET', '/api/watchlist', { token: secondToken })).json();
    assert.equal(wl2.count, 1, 'watchlist also survives (cross-device)');
  } finally {
    await server.stop();
    installed.restore();
  }
});
