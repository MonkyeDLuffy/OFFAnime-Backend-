-- =============================================================================
-- Migration: watchlist (persistent, account-backed)
-- -----------------------------------------------------------------------------
-- One row per (user, anime). The anime identifier is the ANILIST ID - the
-- canonical identity of the existing anime API contract (never a MAL/TMDB id).
--
-- SECURITY MODEL (matches the profiles baseline):
--   - RLS is enabled with policies keyed on auth.uid(): a user can only ever
--     see/insert/delete THEIR OWN rows, even if a request tries to supply a
--     different user id.
--   - The backend FORWARDS the verified user's access token to PostgREST
--     (apikey: anon + Authorization: Bearer <user token>), so Postgres
--     evaluates RLS AS THAT USER. The service-role key is NEVER used for
--     user-owned data. The backend also derives user_id ONLY from the verified
--     session - a client-supplied user id is ignored.
--
-- API (backend):
--   GET    /api/watchlist            -> { items: [{ animeId, addedAt }], count }
--   POST   /api/watchlist {animeId}  -> 201 { added: true, ... } / 200 { added: false, ... }
--   DELETE /api/watchlist/:animeId   -> 200 { ok: true, animeId }
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if exists / drop policy if exists).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
create table if not exists public.watchlist (
  user_id  uuid        not null references auth.users (id) on delete cascade,
  -- AniList ID (canonical anime identity). Bigint for headroom; positive.
  anime_id bigint      not null check (anime_id > 0),
  added_at timestamptz not null default now(),
  -- Uniqueness per (user, anime) AND the index that makes the account-scoped
  -- list query O(log n). Doubles as the PostgREST upsert conflict target
  -- used for idempotent adds.
  primary key (user_id, anime_id)
);

-- Newest-first listing per user (the watchlist read path).
create index if not exists watchlist_user_added_at_idx
  on public.watchlist (user_id, added_at desc);

-- -----------------------------------------------------------------------------
-- Row level security: ONLY the owner can read/write their rows
-- -----------------------------------------------------------------------------
alter table public.watchlist enable row level security;

drop policy if exists "watchlist_select_own" on public.watchlist;
create policy "watchlist_select_own"
  on public.watchlist
  for select
  using (auth.uid() = user_id);

drop policy if exists "watchlist_insert_own" on public.watchlist;
create policy "watchlist_insert_own"
  on public.watchlist
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "watchlist_delete_own" on public.watchlist;
create policy "watchlist_delete_own"
  on public.watchlist
  for delete
  using (auth.uid() = user_id);

-- No update policy: entries are immutable (remove + re-add to change).

-- -----------------------------------------------------------------------------
-- Grants: the `authenticated` role (a verified user token via PostgREST).
-- anon never accesses this table; the backend never uses service_role here.
-- -----------------------------------------------------------------------------
grant select, insert, delete on public.watchlist to authenticated;
revoke update on public.watchlist from authenticated;
revoke all on public.watchlist from anon;

notify pgrst, 'reload schema';
