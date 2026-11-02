/**
 * Watchlist endpoint tests (mocked GoTrue + Supabase REST - no live calls).
 *
 * Verified:
 *   - a VERIFIED session is required for every operation (401 without one,
 *     and the session is re-verified upstream on each request),
 *   - add -> 201 (first time) / 200 (repeat, idempotent); list is scoped to
 *     the verified user; remove is idempotent,
 *   - identity comes ONLY from the verified session: a userId supplied in the
 *     request body is ignored entirely,
 *   - cross-user isolation: each user only ever reads/writes their own rows
 *     (the backend forwards the user token + anon key so Postgres RLS - see
 *     supabase/migrations/20261102000003_watchlist.sql - enforces ownership;
 *     the service-role key is never used for user data),
 *   - storage failures surface as typed 502 errors, never as raw 500s.
 */

import './helpers/test-env-auth.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { installApiMocks, startTestServer, resetL1Cache } from './helpers/test-server.js';
import { TEST_API_SECRET, TEST_ANON_KEY, gotrueUser } from './helpers/gotrue-fixtures.js';
import { jsonResponse } from './helpers/mock-fetch.js';

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
    throw new Error(`unexpected auth call in watchlist test: ${call.method} ${url}`);
  };
}

/**
 * Stateful in-memory emulation of the watchlist PostgREST surface with the
 * production RLS semantics approximated: rows belong to a user_id; the mock
 * records every call so tests can assert identity/filters/headers.
 */
function createWatchlistState() {
  return {
    /** `${user_id}:${anime_id}` -> row */
    rows: new Map(),
    /** every REST call: { method, url, headers, body } */
    calls: [],
  };
}

/** @param {ReturnType<typeof createWatchlistState>} state */
function routeWatchlistRest(state, url, call) {
  const parsed = new URL(url);
  assert.ok(parsed.pathname.endsWith('/rest/v1/watchlist'), `unexpected watchlist REST path: ${url}`);
  state.calls.push({
    method: call.method ?? 'GET',
    url,
    headers: call.init.headers ?? {},
    body: call.init.body !== undefined ? JSON.parse(String(call.init.body)) : undefined,
  });

  if ((call.method ?? 'GET') === 'POST') {
    const body = state.calls[state.calls.length - 1].body;
    const key = `${body.user_id}:${body.anime_id}`;
    if (state.rows.has(key)) return jsonResponse([], 201); // ON CONFLICT DO NOTHING: no row returned
    const row = { user_id: body.user_id, anime_id: Number(body.anime_id), added_at: new Date().toISOString() };
    state.rows.set(key, row);
    return jsonResponse([row], 201);
  }

  if ((call.method ?? 'GET') === 'DELETE') {
    const userId = (parsed.searchParams.get('user_id') ?? '').replace(/^eq\./, '');
    const animeId = (parsed.searchParams.get('anime_id') ?? '').replace(/^eq\./, '');
    state.rows.delete(`${userId}:${animeId}`);
    return new Response(null, { status: 204 });
  }

  const userId = (parsed.searchParams.get('user_id') ?? '').replace(/^eq\./, '');
  const rows = [...state.rows.values()]
    .filter((row) => row.user_id === userId)
    .sort((a, b) => b.added_at.localeCompare(a.added_at))
    .map((row) => ({ anime_id: row.anime_id, added_at: row.added_at }));
  return jsonResponse(rows, 200);
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

test('watchlist requires a verified session: 401 without a token, storage never touched', async () => {
  await resetL1Cache();
  const state = createWatchlistState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: (url, call) => routeWatchlistRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/watchlist');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    assert.equal(state.calls.length, 0, 'no storage access without a session');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('add -> 201; repeat -> 200 (idempotent); list scoped to the user; remove -> 200 (idempotent)', async () => {
  await resetL1Cache();
  const state = createWatchlistState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: (url, call) => routeWatchlistRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    // ADD (first time)
    const added = await request(server.baseUrl, 'POST', '/api/watchlist', { token: TOKEN_A, body: { animeId: 20 } });
    assert.equal(added.status, 201);
    const addedBody = await added.json();
    assert.deepEqual({ added: addedBody.added, animeId: addedBody.animeId }, { added: true, animeId: 20 });
    assert.ok(addedBody.addedAt, 'addedAt metadata required');

    // ADD (repeat) - idempotent, no duplicate row
    const repeat = await request(server.baseUrl, 'POST', '/api/watchlist', { token: TOKEN_A, body: { animeId: 20 } });
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), { added: false, animeId: 20, addedAt: null });
    assert.equal([...state.rows.values()].length, 1);

    // LIST
    const list = await request(server.baseUrl, 'GET', '/api/watchlist', { token: TOKEN_A });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.count, 1);
    assert.equal(listBody.items[0].animeId, 20);
    assert.ok(listBody.items[0].addedAt);

    // REMOVE + repeat remove (idempotent)
    const removed = await request(server.baseUrl, 'DELETE', '/api/watchlist/20', { token: TOKEN_A });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, animeId: 20 });
    const removedAgain = await request(server.baseUrl, 'DELETE', '/api/watchlist/20', { token: TOKEN_A });
    assert.equal(removedAgain.status, 200);
    assert.equal((await removedAgain.json()).ok, true);

    const after = await request(server.baseUrl, 'GET', '/api/watchlist', { token: TOKEN_A });
    assert.equal((await after.json()).count, 0);

    // EVERY storage call acted as the USER (RLS): anon apikey + user Bearer.
    for (const restCall of state.calls) {
      assert.equal(restCall.headers.apikey, TEST_ANON_KEY, 'watchlist must use the anon apikey');
      assert.equal(restCall.headers.Authorization, `Bearer ${TOKEN_A}`, 'watchlist must act as the user');
      assert.equal(String(restCall.headers.Authorization).includes('service-role'), false);
    }
    // POST targeted the (user_id, anime_id) conflict pair for idempotency.
    const postCall = state.calls.find((c) => c.method === 'POST');
    assert.ok(String(postCall.url).includes('on_conflict=user_id'), 'idempotent add needs an explicit conflict target');
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('identity comes ONLY from the verified session (body userId is ignored)', async () => {
  await resetL1Cache();
  const state = createWatchlistState();
  // A row owned by user B must never appear for user A.
  state.rows.set(`${USER_B}:30`, { user_id: USER_B, anime_id: 30, added_at: new Date().toISOString() });
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A, [TOKEN_B]: USER_B }),
    supabaseRest: (url, call) => routeWatchlistRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    // Attempt a confused-deputy add: session = A, body claims userId = B.
    const res = await request(server.baseUrl, 'POST', '/api/watchlist', {
      token: TOKEN_A,
      body: { animeId: 99, userId: USER_B },
    });
    assert.equal(res.status, 201);

    const stored = [...state.rows.values()].find((row) => row.anime_id === 99);
    assert.equal(stored.user_id, USER_A, 'the stored owner must be the VERIFIED session user');
    assert.equal(state.calls.find((c) => c.method === 'POST').body.user_id, USER_A);

    // User A's list contains only A's rows (never B's).
    const listA = await (await request(server.baseUrl, 'GET', '/api/watchlist', { token: TOKEN_A })).json();
    assert.deepEqual(listA.items.map((i) => i.animeId), [99]);
    const listB = await (await request(server.baseUrl, 'GET', '/api/watchlist', { token: TOKEN_B })).json();
    assert.deepEqual(listB.items.map((i) => i.animeId), [30]);

    // The list calls filtered by the VERIFIED user id.
    const getCalls = state.calls.filter((c) => c.method === 'GET');
    assert.ok(getCalls.some((c) => String(c.url).includes(`user_id=eq.${USER_A}`)));
    assert.ok(getCalls.some((c) => String(c.url).includes(`user_id=eq.${USER_B}`)));
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('cross-user isolation: removing another user\'s entry is impossible (scoped filters)', async () => {
  await resetL1Cache();
  const state = createWatchlistState();
  state.rows.set(`${USER_B}:30`, { user_id: USER_B, anime_id: 30, added_at: new Date().toISOString() });
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: (url, call) => routeWatchlistRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    // User A tries to delete user B's anime id.
    const res = await request(server.baseUrl, 'DELETE', '/api/watchlist/30', { token: TOKEN_A });
    assert.equal(res.status, 200); // idempotent success for A (nothing of A's was removed)
    // User B's row survives (the DELETE filter carried A's verified id only).
    assert.equal(state.rows.has(`${USER_B}:30`), true);
    const deleteCall = state.calls.find((c) => c.method === 'DELETE');
    assert.ok(String(deleteCall.url).includes(`user_id=eq.${USER_A}`));
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('invalid animeId -> 400 VALIDATION_ERROR without storage access', async () => {
  await resetL1Cache();
  const state = createWatchlistState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: (url, call) => routeWatchlistRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'POST', '/api/watchlist', {
      token: TOKEN_A,
      body: { animeId: 'not-an-id' },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(state.calls.length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('tampered session -> 401 AUTH_SESSION_EXPIRED; storage never touched', async () => {
  await resetL1Cache();
  const state = createWatchlistState();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }), // 'tampered-token' is unknown
    supabaseRest: (url, call) => routeWatchlistRest(state, url, call),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/watchlist', { token: 'tampered-token' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'AUTH_SESSION_EXPIRED');
    assert.equal(state.calls.length, 0);
  } finally {
    await server.stop();
    installed.restore();
  }
});

test('storage failure -> typed 502 PROVIDER_ERROR (never a raw 500)', async () => {
  await resetL1Cache();
  const installed = installApiMocks({
    supabaseAuth: authHandler({ [TOKEN_A]: USER_A }),
    supabaseRest: () => jsonResponse({ code: '42501', message: 'permission denied for table watchlist' }, 403),
  });
  const server = await startTestServer();
  try {
    const res = await request(server.baseUrl, 'GET', '/api/watchlist', { token: TOKEN_A });
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
