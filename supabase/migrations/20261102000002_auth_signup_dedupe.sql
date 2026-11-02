-- =============================================================================
-- Migration: signup duplicate-suppression markers (auth_signup_dedupe)
-- -----------------------------------------------------------------------------
-- Backs the "prevent duplicate signup requests from generating unnecessary
-- upstream calls" requirement (src/services/auth-throttle.service.js).
--
-- After a SUCCESSFUL signup the backend records a short-lived marker keyed by
-- the SHA-256 hash of the NORMALIZED email (no plaintext address is stored).
-- A repeated signup POST for the same address within the TTL responds 409
-- immediately, WITHOUT calling Supabase Auth again. Failed/rate-limited
-- signups never create a marker, so failures are never mistaken for success.
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if exists / create or replace).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- =============================================================================

create table if not exists public.auth_signup_dedupe (
  email_key  text        primary key,
  created_at timestamptz not null default now()
);

create index if not exists auth_signup_dedupe_created_at_idx
  on public.auth_signup_dedupe (created_at);

-- RLS + grants: server-side abuse data. No anon/authenticated access.
alter table public.auth_signup_dedupe enable row level security;

revoke all on public.auth_signup_dedupe from anon;
revoke all on public.auth_signup_dedupe from authenticated;
grant select, insert, update, delete on public.auth_signup_dedupe to service_role;

-- -----------------------------------------------------------------------------
-- cleanup_stale_signup_dedupe: optional hygiene (no worker required)
-- -----------------------------------------------------------------------------
-- Markers are only useful for a short window; run manually or on a rare
-- schedule. The default keeps one day of history.
create or replace function public.cleanup_stale_signup_dedupe(p_min_age_minutes integer default 1440)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from public.auth_signup_dedupe
   where created_at < now() - make_interval(mins => greatest(p_min_age_minutes, 1));
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.cleanup_stale_signup_dedupe(integer) from public;
revoke all on function public.cleanup_stale_signup_dedupe(integer) from anon;
revoke all on function public.cleanup_stale_signup_dedupe(integer) from authenticated;
grant execute on function public.cleanup_stale_signup_dedupe(integer) to service_role;

notify pgrst, 'reload schema';
