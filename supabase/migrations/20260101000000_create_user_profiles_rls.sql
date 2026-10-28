-- =============================================================================
-- Migration: user profiles table with row-level security (RLS baseline)
-- -----------------------------------------------------------------------------
-- One-time manual step (no supabase CLI required):
--   Supabase Dashboard -> SQL Editor -> paste this file -> Run
--   (or: supabase db push, if using the CLI)
--
-- PURPOSE
--   Baseline for user-owned data that is SEPARATE from Supabase Auth
--   credentials (auth.users). Profile/business data must never live in the
--   auth schema, and every user-owned table MUST enable RLS with policies
--   keyed on auth.uid() so one user can never read or modify another user's
--   rows by changing an ID in a request.
--
-- HOW THE BACKEND INTERACTS WITH THIS TABLE
--   The backend authenticates users through Supabase Auth (GoTrue) using the
--   PUBLIC anon key ONLY - never the service-role key. When a backend feature
--   needs user-owned rows, it MUST forward the user's access token to
--   PostgREST:
--       Authorization: Bearer <user access token>
--       apikey: <anon key>
--   PostgREST then evaluates RLS AS THAT USER (auth.uid() = the token's sub).
--   The backend MUST NOT query user-owned tables with the service-role key
--   (that bypasses RLS entirely and would let any caller read any user's data).
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if not exists / drop policy if exists).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Profiles: one row per user, keyed by the Supabase Auth user UUID.
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS is the security boundary. NEVER ship a user-owned table with RLS
-- disabled, and never disable it "temporarily".
alter table public.profiles enable row level security;

-- Users can read ONLY their own row (auth.uid() comes from the verified JWT).
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  using (auth.uid() = id);

-- Users can insert ONLY their own row (id must equal their own auth uid).
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  with check (auth.uid() = id);

-- Users can update ONLY their own row.
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No delete policy: profile rows follow the auth user via on delete cascade.
-- (Add an explicit policy only if self-service deletion is a product need.)

-- Keep updated_at fresh.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row
  execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- TEMPLATE for ANY future user-owned table (favorites, watch history, ...):
--
--   create table public.<table> (
--     id         bigint generated always as identity primary key,
--     user_id    uuid not null references auth.users (id) on delete cascade,
--     ...
--   );
--   alter table public.<table> enable row level security;
--   create policy "<table>_all_own" on public.<table>
--     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
--
-- RULES:
--   * every row carries user_id; every policy compares it to auth.uid().
--   * RLS enabled BEFORE the table accepts production data.
--   * the backend forwards the USER's access token for these queries
--     (anon key + Bearer) - the service-role key is for the L2 cache table
--     only (cache_entries has no user data and is not exposed via the API).
-- =============================================================================
