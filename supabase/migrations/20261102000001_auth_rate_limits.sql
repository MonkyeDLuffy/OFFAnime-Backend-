-- =============================================================================
-- Migration: DB-backed auth attempt limiting (login lockout + IP layers)
-- -----------------------------------------------------------------------------
-- Backs src/services/auth-throttle.service.js. ATOMIC counters shared across
-- ALL serverless instances (in-memory counters are never the enforcement
-- mechanism): one row per bucket + one serialized RPC.
--
-- Bucket naming (opaque to the database):
--   login:email:<sha256>   failed logins per NORMALIZED account (hashed email)
--   login:ip:<ip>          failed logins per source IP (separate abuse layer)
--   signup:ip:<ip>         signup ATTEMPTS per source IP
--
-- Policy semantics enforced by register_auth_attempt (p_max_hits = N):
--   attempts 1..N register normally; attempt N+1 (hits > N) sets locked_until
--   and reports locked=true. Attempts DURING an active lock are recorded but
--   never extend the lock. An expired window resets the counter to 1.
--
-- The backend ALSO read-gates before calling GoTrue: a bucket with
-- hits >= N inside the (non-expired) window is blocked without registering a
-- new hit, so a locked account/IP receives a typed 429 with retry info.
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if exists / create or replace).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
create table if not exists public.auth_attempt_limits (
  bucket            text        primary key,
  hits              integer     not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz,
  last_hit_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists auth_attempt_limits_last_hit_idx
  on public.auth_attempt_limits (last_hit_at);

-- RLS + grants: server-side abuse data. No anon/authenticated access at all.
alter table public.auth_attempt_limits enable row level security;

revoke all on public.auth_attempt_limits from anon;
revoke all on public.auth_attempt_limits from authenticated;
grant select, insert, update, delete on public.auth_attempt_limits to service_role;

-- -----------------------------------------------------------------------------
-- register_auth_attempt: atomic register-and-decide
-- -----------------------------------------------------------------------------
-- Returns jsonb: { hits, locked, retry_after_seconds }.
create or replace function public.register_auth_attempt(
  p_bucket text,
  p_max_hits integer,
  p_window_seconds integer,
  p_lock_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_row public.auth_attempt_limits;
  v_expired boolean;
  v_hits integer;
  v_window_started timestamptz;
  v_locked_until timestamptz;
begin
  -- Serialize the read-modify-write PER BUCKET across every serverless
  -- instance. The advisory lock is transaction-scoped: one RPC call is one
  -- implicit transaction, so concurrent registers increment exactly and
  -- atomically instead of racing.
  perform pg_advisory_xact_lock(hashtext('offanime-auth-attempt:' || p_bucket));

  select * into v_row from public.auth_attempt_limits where bucket = p_bucket;

  -- Active lock: record the attempt time but do NOT extend the cooldown
  -- (repeated attempts must not be able to prolong a lock) and report busy.
  if v_row.bucket is not null
     and v_row.locked_until is not null
     and v_row.locked_until > v_now then
    update public.auth_attempt_limits
       set last_hit_at = v_now, updated_at = v_now
     where bucket = p_bucket;
    return jsonb_build_object(
      'hits', v_row.hits,
      'locked', true,
      'retry_after_seconds',
        greatest(1, ceil(extract(epoch from (v_row.locked_until - v_now)))::integer)
    );
  end if;

  -- First ever hit for this bucket.
  if v_row.bucket is null then
    insert into public.auth_attempt_limits
      (bucket, hits, window_started_at, locked_until, last_hit_at, updated_at)
    values
      (p_bucket, 1, v_now, null, v_now, v_now);
    return jsonb_build_object('hits', 1, 'locked', false, 'retry_after_seconds', 0);
  end if;

  -- Count this hit: expired window -> fresh counter, otherwise increment.
  v_expired := v_row.window_started_at <= v_now - make_interval(secs => p_window_seconds);
  v_hits := case when v_expired then 1 else v_row.hits + 1 end;
  v_window_started := case when v_expired then v_now else v_row.window_started_at end;
  -- Lock only AFTER the budget is spent: with p_max_hits = 5 the 5th hit
  -- registers normally (hits = 5); the 6th hit (hits = 6 > 5) triggers the
  -- lock-and-reject. A previous (now expired) lock is cleared on recovery.
  v_locked_until := case
    when v_hits > p_max_hits then v_now + make_interval(secs => p_lock_seconds)
    else null
  end;

  update public.auth_attempt_limits
     set hits = v_hits,
         window_started_at = v_window_started,
         locked_until = v_locked_until,
         last_hit_at = v_now,
         updated_at = v_now
   where bucket = p_bucket;

  return jsonb_build_object(
    'hits', v_hits,
    'locked', v_locked_until is not null,
    'retry_after_seconds', case when v_locked_until is not null then greatest(1, p_lock_seconds) else 0 end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- clear_auth_attempts: successful login resets the account counter
-- -----------------------------------------------------------------------------
create or replace function public.clear_auth_attempts(p_bucket text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('offanime-auth-attempt:' || p_bucket));
  delete from public.auth_attempt_limits where bucket = p_bucket;
end;
$$;

-- -----------------------------------------------------------------------------
-- cleanup_expired_attempt_limits: optional hygiene (no worker required)
-- -----------------------------------------------------------------------------
-- Deletes buckets that have not been touched recently and are not locked.
-- Run manually from the SQL editor or on a rare schedule.
create or replace function public.cleanup_expired_attempt_limits(p_keep_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.auth_attempt_limits
   where last_hit_at < now() - make_interval(hours => greatest(p_keep_hours, 1))
     and (locked_until is null or locked_until < now());
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- -----------------------------------------------------------------------------
-- Function privileges: service_role ONLY (never callable with an anon key)
-- -----------------------------------------------------------------------------
revoke all on function public.register_auth_attempt(text, integer, integer, integer) from public;
revoke all on function public.register_auth_attempt(text, integer, integer, integer) from anon;
revoke all on function public.register_auth_attempt(text, integer, integer, integer) from authenticated;
grant execute on function public.register_auth_attempt(text, integer, integer, integer) to service_role;

revoke all on function public.clear_auth_attempts(text) from public;
revoke all on function public.clear_auth_attempts(text) from anon;
revoke all on function public.clear_auth_attempts(text) from authenticated;
grant execute on function public.clear_auth_attempts(text) to service_role;

revoke all on function public.cleanup_expired_attempt_limits(integer) from public;
revoke all on function public.cleanup_expired_attempt_limits(integer) from anon;
revoke all on function public.cleanup_expired_attempt_limits(integer) from authenticated;
grant execute on function public.cleanup_expired_attempt_limits(integer) to service_role;

notify pgrst, 'reload schema';
