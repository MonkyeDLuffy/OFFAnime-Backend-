-- =============================================================================
-- Migration: HARDEN the Supabase L2 cache table (cache_entries)
-- -----------------------------------------------------------------------------
-- WHY (production fix - the "Supabase cache read/write failed" logs):
--   1. "Supabase cache write failed" - the backend upsert sends
--      Prefer: resolution=merge-duplicates with an explicit
--      on_conflict=namespace,cache_key conflict target. That REQUIRES a
--      unique constraint/index on (namespace, cache_key); without it Postgres
--      raises 42P10 ("there is no unique or exclusion constraint matching the
--      ON CONFLICT specification") and (without the explicit target) PostgREST
--      falls back to the surrogate `id` primary key, so the second write for
--      the same logical key raises 23505 duplicate key. This migration
--      guarantees the required unique index (and deduplicates any rows that
--      accumulated while it was missing).
--   2. "Supabase cache read failed" - RLS is enabled on cache_entries with NO
--      policies, so the ANON key cannot read/write it at all (401). The
--      backend's L2 store now REQUIRES SUPABASE_SERVICE_ROLE_KEY and runs
--      L1-only otherwise; this migration keeps RLS locked down and makes the
--      service_role grants explicit.
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if exists / if not exists).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table (fresh installs get the final shape; existing installs repaired)
-- -----------------------------------------------------------------------------
create table if not exists public.cache_entries (
  id           bigint generated always as identity primary key,
  namespace    text        not null,
  cache_key    text        not null,
  value        jsonb       not null,
  ttl_seconds  integer     not null default 300,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  stale_until  timestamptz not null
);

-- -----------------------------------------------------------------------------
-- 2. Repair partially-existing tables: add any missing columns
-- -----------------------------------------------------------------------------
alter table public.cache_entries add column if not exists namespace   text;
alter table public.cache_entries add column if not exists cache_key   text;
alter table public.cache_entries add column if not exists value       jsonb;
alter table public.cache_entries add column if not exists ttl_seconds integer default 300;
alter table public.cache_entries add column if not exists created_at  timestamptz default now();
alter table public.cache_entries add column if not exists updated_at  timestamptz default now();
alter table public.cache_entries add column if not exists expires_at  timestamptz;
alter table public.cache_entries add column if not exists stale_until timestamptz;

-- -----------------------------------------------------------------------------
-- 3. Backfill legacy rows, then enforce NOT NULL + defaults
-- -----------------------------------------------------------------------------
update public.cache_entries
   set ttl_seconds = coalesce(ttl_seconds, 300),
       expires_at  = coalesce(expires_at, created_at, now()),
       stale_until = coalesce(stale_until, coalesce(expires_at, created_at, now()) + interval '24 hours'),
       created_at  = coalesce(created_at, now()),
       updated_at  = coalesce(updated_at, coalesce(created_at, now())),
       namespace   = coalesce(namespace, 'default'),
       cache_key   = coalesce(cache_key, 'legacy:' || id::text),
       value       = coalesce(value, 'null'::jsonb)
 where ttl_seconds is null or expires_at is null or stale_until is null
    or created_at is null or updated_at is null
    or namespace is null or cache_key is null or value is null;

alter table public.cache_entries alter column namespace   set not null;
alter table public.cache_entries alter column cache_key   set not null;
alter table public.cache_entries alter column value       set not null;
alter table public.cache_entries alter column ttl_seconds set not null;
alter table public.cache_entries alter column ttl_seconds set default 300;
alter table public.cache_entries alter column expires_at  set not null;
alter table public.cache_entries alter column stale_until set not null;

-- -----------------------------------------------------------------------------
-- 4. Deduplicate logical keys (keep the newest row per (namespace, cache_key))
-- -----------------------------------------------------------------------------
with ranked as (
  select id,
         row_number() over (
           partition by namespace, cache_key
           order by updated_at desc, id desc
         ) as rn
  from public.cache_entries
)
delete from public.cache_entries
 where id in (select id from ranked where rn > 1);

-- -----------------------------------------------------------------------------
-- 5. THE REQUIRED UNIQUE INDEX for atomic upserts
-- -----------------------------------------------------------------------------
-- Backs the backend's `?on_conflict=namespace,cache_key` +
-- `Prefer: resolution=merge-duplicates` upsert (INSERT ... ON CONFLICT
-- (namespace, cache_key) DO UPDATE) used by every cache write. Missing this
-- index is a hard write failure (42P10), not a performance issue.
create unique index if not exists cache_entries_namespace_cache_key_uidx
  on public.cache_entries (namespace, cache_key);

-- -----------------------------------------------------------------------------
-- 6. Expiration / stale cleanup lookups
-- -----------------------------------------------------------------------------
create index if not exists cache_entries_expires_at_idx
  on public.cache_entries (expires_at);

create index if not exists cache_entries_stale_until_idx
  on public.cache_entries (stale_until);

-- -----------------------------------------------------------------------------
-- 7. Row level security + explicit grants
-- -----------------------------------------------------------------------------
-- The backend reads/writes with the service-role key (bypasses RLS, stays
-- server-side). RLS with NO policies denies anon/authenticated by default;
-- the explicit revoke makes that guarantee independent of injected grants.
alter table public.cache_entries enable row level security;

revoke all on public.cache_entries from anon;
revoke all on public.cache_entries from authenticated;
grant select, insert, update, delete on public.cache_entries to service_role;

-- -----------------------------------------------------------------------------
-- 8. Optional serverless-friendly cleanup (NOT required for correctness)
-- -----------------------------------------------------------------------------
-- Expired rows are handled lazily during reads; this function exists only for
-- an optional manual/rarely-scheduled SQL call.
create or replace function public.cleanup_expired_cache_entries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.cache_entries
  where stale_until < now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.cleanup_expired_cache_entries() from public;
revoke all on function public.cleanup_expired_cache_entries() from anon;
revoke all on function public.cleanup_expired_cache_entries() from authenticated;
grant execute on function public.cleanup_expired_cache_entries() to service_role;

-- -----------------------------------------------------------------------------
-- 9. Make PostgREST pick up the new constraint/index IMMEDIATELY
-- -----------------------------------------------------------------------------
-- Without this, upserts can behave as if the old schema were still cached
-- (transient 42P10 / wrong conflict target) until PostgREST refreshes.
notify pgrst, 'reload schema';
