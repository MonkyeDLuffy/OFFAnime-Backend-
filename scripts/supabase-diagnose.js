/**
 * Supabase production diagnostic - pinpoint the EXACT failing operation and
 * upstream error response for the L2 cache and the auth-limiter tables.
 *
 * This script exists because production logs showed only the wrapper messages
 * ("Supabase cache read failed" / "Supabase cache write failed") without the
 * PostgREST error body. It probes each operation directly and prints the raw
 * HTTP status + PostgREST/Postgres error code + message, then maps common
 * codes to the exact remediation (missing migration, missing unique index,
 * wrong key/RLS, etc.).
 *
 * Zero dependencies; uses the SAME credentials/env the server uses.
 *
 * Usage (locally with .env, or in a Vercel shell with the production env):
 *   node scripts/supabase-diagnose.js
 *
 * No credential value is ever printed - only its presence and key FAMILY
 * (legacy JWT vs new sb_secret_/sb_publishable_).
 */

import { config } from '../src/config/env.js';

const baseUrl = String(config.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceKey = config.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = config.SUPABASE_ANON_KEY;

/** Classify a key without revealing it. */
function keyKind(key) {
  if (!key) return 'MISSING';
  if (key.startsWith('sb_secret_')) return 'new secret key (sb_secret_...)';
  if (key.startsWith('sb_publishable_')) return 'new publishable key (sb_publishable_...)';
  if (key.startsWith('eyJ')) return 'legacy JWT key (anon/service_role)';
  return 'unrecognized format';
}

/**
 * @param {string} path
 * @param {{ method?: string, apiKey?: string, bearer?: string, body?: unknown, prefer?: string }} [options]
 */
async function rest(path, { method = 'GET', apiKey, bearer, body, prefer } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(apiKey ? { apikey: apiKey } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, ok: response.ok, data };
  } catch (err) {
    return { status: 0, ok: false, data: `transport failure: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timeout);
  }
}

const failures = [];

/** @param {string} label @param {{status:number, ok:boolean, data:unknown}} result */
function report(label, result) {
  const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  const line = `${result.ok ? 'OK  ' : 'FAIL'} ${label}: HTTP ${result.status} ${truncate(body, 220)}`;
  console.log(line);
  if (!result.ok) failures.push({ label, result });
}

/** @param {{status:number, data:unknown}} result */
function hint(result) {
  const code = result.data && typeof result.data === 'object' ? result.data.code : undefined;
  if (code === '42P01') return 'table missing -> apply the matching file in supabase/migrations/ via SQL Editor';
  if (code === '42P10') return 'missing unique (namespace, cache_key) index -> apply supabase/migrations/20261102000000_fix_cache_entries.sql';
  if (code === '23505') return 'duplicate key -> backend must send on_conflict=namespace,cache_key (deploy current code) AND the unique index must exist (migration 20261102000000)';
  if (code === '42501' || result.status === 401 || result.status === 403) {
    return 'permission denied -> SUPABASE_SERVICE_ROLE_KEY is wrong/missing or RLS blocks this role. The L2 cache and limiter tables REQUIRE the service-role key.';
  }
  if (result.status === 404) return 'endpoint/table not found -> verify SUPABASE_URL points at the right project and the migration was applied';
  if (result.status === 0) return 'network/transport failure -> verify SUPABASE_URL is reachable and correct';
  return 'inspect the reported HTTP status/body above';
}

/** @param {string} value @param {number} max */
function truncate(value, max) {
  if (typeof value !== 'string') return String(value);
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

async function main() {
  console.log('=== SUPABASE PRODUCTION DIAGNOSTIC ===');
  console.log(`SUPABASE_URL                     : ${baseUrl || 'MISSING'}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY        : ${keyKind(serviceKey)}`);
  console.log(`SUPABASE_ANON_KEY                : ${keyKind(anonKey)}`);
  console.log(`AUTH_GOTRUE_SECRET_KEY           : ${keyKind(config.AUTH_GOTRUE_SECRET_KEY)}`);
  console.log('');

  if (!baseUrl) {
    console.error('ABORT: SUPABASE_URL is not configured - the L2 cache cannot work at all.');
    process.exit(1);
  }
  if (!serviceKey) {
    console.error('ABORT: SUPABASE_SERVICE_ROLE_KEY is not configured - the L2 cache and the auth limiter run DISABLED (clean L1-only fallback, but no cross-instance protection).');
    process.exit(1);
  }

  // --- GoTrue reachability -----------------------------------------------------
  const health = await rest('/auth/v1/health', { apiKey: serviceKey });
  report('auth health', health);

  // --- cache_entries: READ ------------------------------------------------------
  report(
    'cache_entries READ (service role)',
    await rest('/rest/v1/cache_entries?select=namespace&limit=1', { apiKey: serviceKey }),
  );

  // --- cache_entries: WRITE (exact production upsert, twice) --------------------
  const probeKey = `probe:${Date.now()}`;
  const now = Date.now();
  const probeRow = {
    namespace: 'diagnose',
    cache_key: probeKey,
    value: { diagnostic: true },
    ttl_seconds: 60,
    expires_at: new Date(now + 60_000).toISOString(),
    stale_until: new Date(now + 86_400_000).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  report(
    'cache_entries WRITE #1 (on_conflict=namespace,cache_key, merge-duplicates)',
    await rest('/rest/v1/cache_entries?on_conflict=namespace,cache_key', {
      method: 'POST',
      apiKey: serviceKey,
      body: probeRow,
      prefer: 'resolution=merge-duplicates,return=minimal',
    }),
  );
  report(
    'cache_entries WRITE #2 (same key - exercises the ON CONFLICT merge path)',
    await rest('/rest/v1/cache_entries?on_conflict=namespace,cache_key', {
      method: 'POST',
      apiKey: serviceKey,
      body: { ...probeRow, value: { diagnostic: true, second: true }, updated_at: new Date().toISOString() },
      prefer: 'resolution=merge-duplicates,return=minimal',
    }),
  );
  report(
    'cache_entries READ BACK (probe row)',
    await rest(
      `/rest/v1/cache_entries?namespace=eq.diagnose&cache_key=eq.${encodeURIComponent(probeKey)}&select=namespace,cache_key`,
      { apiKey: serviceKey },
    ),
  );
  await rest(
    `/rest/v1/cache_entries?namespace=eq.diagnose&cache_key=eq.${encodeURIComponent(probeKey)}`,
    { method: 'DELETE', apiKey: serviceKey },
  );

  // --- auth_attempt_limits -------------------------------------------------------
  report(
    'auth_attempt_limits READ',
    await rest('/rest/v1/auth_attempt_limits?select=bucket&limit=1', { apiKey: serviceKey }),
  );
  const rpcProbe = await rest('/rest/v1/rpc/register_auth_attempt', {
    method: 'POST',
    apiKey: serviceKey,
    body: { p_bucket: 'diagnose:probe', p_max_hits: 5, p_window_seconds: 900, p_lock_seconds: 900 },
  });
  report('auth_attempt_limits RPC register_auth_attempt', rpcProbe);
  await rest('/rest/v1/auth_attempt_limits?bucket=eq.diagnose%3Aprobe', { method: 'DELETE', apiKey: serviceKey });

  // --- auth_signup_dedupe --------------------------------------------------------
  report(
    'auth_signup_dedupe READ',
    await rest('/rest/v1/auth_signup_dedupe?select=email_key&limit=1', { apiKey: serviceKey }),
  );

  // --- watchlist (anon key, as the RLS-forwarded user flow would) ----------------
  report(
    'watchlist READ (anon key - RLS should return [] without a user token)',
    await rest('/rest/v1/watchlist?select=anime_id&limit=1', { apiKey: anonKey }),
  );

  // --- verdict -------------------------------------------------------------------
  console.log('');
  if (failures.length === 0) {
    console.log('ALL PROBES PASSED. L2 cache + limiter tables are reachable with the configured credentials.');
    process.exit(0);
  }

  console.log(`FAILURES: ${failures.length}`);
  for (const failure of failures) {
    console.log(`- ${failure.label}`);
    console.log(`  cause : HTTP ${failure.result.status} ${truncate(JSON.stringify(failure.result.data), 300)}`);
    console.log(`  fix   : ${hint(failure.result)}`);
  }
  process.exit(1);
}

await main();
