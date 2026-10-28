-- =============================================================================
-- Migration: create the Supabase L2 cache table (cache_entries)
-- -----------------------------------------------------------------------------
-- One-time manual step (no supabase CLI required):
--   Supabase Dashboard -> SQL Editor -> paste this file -> Run
--   (or: supabase db push, if using the CLI)
--
-- This table is the persistent, shared L2 cache that works across serverless
-- instances. It is a cache layer ONLY - never a source of truth. Provider
-- failures are never stored here as successful values.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Cache table
-- -----------------------------------------------------------------------------
-- namespace      explicit namespace segment (e.g. anilist, jikan, tmdb,
--                identity, cache) - keeps provider namespaces isolated
-- cache_key      explicit key within the namespace (e.g. anime:123)
-- value          normalized application data (jsonb) - never raw provider
--                HTTP responses, never secrets
-- ttl_seconds    fresh TTL used when the entry was written
-- expires_at     fresh until this instant (timestamptz)
-- stale_until    stale-if-error usable until this instant (timestamptz);
--                stale data is served ONLY when the provider operation fails
-- created_at     preserved across upserts (default now() on insert)
-- updated_at     set by the application on every upsert
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
-- Uniqueness on the logical cache identity (namespace, cache_key)
-- -----------------------------------------------------------------------------
-- Enables ATOMIC upserts (PostgREST Prefer: resolution=merge-duplicates) so
-- concurrent serverless instances can populate the same key safely without a
-- SELECT-then-INSERT race. A numeric ID equal across providers does NOT mean
-- the entities are equal - the namespace column keeps them isolated.
create unique index if not exists cache_entries_namespace_cache_key_uidx
  on public.cache_entries (namespace, cache_key);

-- -----------------------------------------------------------------------------
-- Expiration / stale cleanup lookups
-- -----------------------------------------------------------------------------
create index if not exists cache_entries_expires_at_idx
  on public.cache_entries (expires_at);

create index if not exists cache_entries_stale_until_idx
  on public.cache_entries (stale_until);

-- -----------------------------------------------------------------------------
-- Row level security
-- -----------------------------------------------------------------------------
-- The backend writes/reads with the service-role key (which bypasses RLS and
-- stays server-side). Enabling RLS with NO policies means anonymous/public
-- access is denied by default.
alter table public.cache_entries enable row level security;

-- -----------------------------------------------------------------------------
-- Optional serverless-friendly cleanup (NOT required for correctness)
-- -----------------------------------------------------------------------------
-- Expired rows are handled lazily during reads; this function exists only for
-- an optional manual/rarely-scheduled SQL call. No backend worker, cron
-- daemon, setInterval(), or VPS process is required for basic cache
-- correctness.
create or replace function public.cleanup_expired_cache_entries()
returns integer
language plpgsql
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
