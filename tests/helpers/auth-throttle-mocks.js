/**
 * Stateful in-memory emulation of the Supabase PostgREST surface used by
 * services/auth-throttle.service.js:
 *   - table  auth_attempt_limits   (GET read / DELETE clear)
 *   - RPC    register_auth_attempt (atomic register-and-decide)
 *   - table  auth_signup_dedupe    (GET lookup / POST marker write)
 *
 * The register semantics MIRROR the production SQL (20261102000001) exactly:
 *   - a new bucket starts at hits = 1,
 *   - an expired window resets the counter to 1,
 *   - a bucket with hits > max becomes locked for lock seconds,
 *   - attempts during an active lock are recorded but never extend it.
 *
 * The state also records every REST call so tests can assert that a locked
 * attempt never reaches the upstream provider.
 *
 * NOTE: the production atomicity comes from a per-bucket advisory lock inside
 * the SQL function; this JS mock is single-threaded, so increments are
 * naturally serialized.
 */

import { jsonResponse } from './mock-fetch.js';

/** @returns {{ limits: Map<string, {hits:number,windowStartedAt:number,lockedUntil:number|null}>, dedupe: Map<string, number>, rpcCalls: object[] }} */
export function createThrottleState() {
  return {
    /** bucket -> state */
    limits: new Map(),
    /** email_key -> createdAt (epoch ms) */
    dedupe: new Map(),
    /** every register_auth_attempt RPC, in order */
    rpcCalls: [],
  };
}

/** Strip the PostgREST `eq.` operator prefix from a filter value. */
function eq(value) {
  return typeof value === 'string' && value.startsWith('eq.') ? value.slice(3) : value;
}

/**
 * Route one Supabase REST request against the throttle mock state.
 * @param {ReturnType<typeof createThrottleState>} state
 * @param {string} url
 * @param {{ method?: string, init: { body?: unknown, headers?: Record<string, string> } }} call
 * @returns {Response}
 */
export function routeThrottleRest(state, url, call) {
  const parsed = new URL(url);
  const path = parsed.pathname;

  if (path.endsWith('/rpc/register_auth_attempt')) {
    const args = JSON.parse(String(call.init.body));
    const now = Date.now();
    state.rpcCalls.push({ bucket: args.p_bucket, args });

    const current = state.limits.get(args.p_bucket);
    if (current && current.lockedUntil !== null && current.lockedUntil > now) {
      // Active lock: record the hit time but do NOT extend the cooldown.
      return jsonResponse({
        hits: current.hits,
        locked: true,
        retry_after_seconds: Math.max(1, Math.ceil((current.lockedUntil - now) / 1000)),
      });
    }

    let hits;
    let windowStartedAt;
    let lockedUntil = null;
    if (!current) {
      hits = 1;
      windowStartedAt = now;
    } else {
      const expired = current.windowStartedAt <= now - args.p_window_seconds * 1000;
      hits = expired ? 1 : current.hits + 1;
      windowStartedAt = expired ? now : current.windowStartedAt;
      if (hits > args.p_max_hits) lockedUntil = now + args.p_lock_seconds * 1000;
    }
    state.limits.set(args.p_bucket, { hits, windowStartedAt, lockedUntil });
    return jsonResponse({
      hits,
      locked: lockedUntil !== null,
      retry_after_seconds: lockedUntil !== null ? args.p_lock_seconds : 0,
    });
  }

  if (path.endsWith('/auth_attempt_limits')) {
    const bucket = eq(parsed.searchParams.get('bucket'));
    if ((call.method ?? 'GET') === 'DELETE') {
      state.limits.delete(bucket);
      return new Response(null, { status: 204 });
    }
    const current = state.limits.get(bucket);
    const rows = current
      ? [{
        bucket,
        hits: current.hits,
        window_started_at: new Date(current.windowStartedAt).toISOString(),
        locked_until: current.lockedUntil === null ? null : new Date(current.lockedUntil).toISOString(),
      }]
      : [];
    return jsonResponse(rows, 200);
  }

  if (path.endsWith('/auth_signup_dedupe')) {
    if ((call.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(call.init.body));
      if (!state.dedupe.has(body.email_key)) state.dedupe.set(body.email_key, Date.now());
      return jsonResponse([{
        email_key: body.email_key,
        created_at: new Date(state.dedupe.get(body.email_key)).toISOString(),
      }], 201);
    }
    const key = eq(parsed.searchParams.get('email_key'));
    const createdAt = state.dedupe.get(key);
    return jsonResponse(createdAt === undefined ? [] : [{ created_at: new Date(createdAt).toISOString() }], 200);
  }

  throw new Error(`unexpected Supabase REST call in throttle mock: ${call.method ?? 'GET'} ${url}`);
}
