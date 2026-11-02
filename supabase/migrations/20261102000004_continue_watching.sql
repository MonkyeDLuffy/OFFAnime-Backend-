-- =============================================================================
-- Migration: continue_watching (per-user playback progress)
-- -----------------------------------------------------------------------------
-- One row per (user, anime): the latest episode watched and optional playback
-- progress. Rows are UPSERTED (ON CONFLICT on the primary key), so a repeat
-- save updates the existing entry and never creates duplicates. There is no
-- anime-completed status: finishing an episode never closes the entry; the
-- entry disappears only when the user removes it.
--
-- SECURITY MODEL (identical to the watchlist baseline):
--   - RLS is enabled with policies keyed on auth.uid(): a user can only ever
--     see/insert/update/delete THEIR OWN rows.
--   - The backend FORWARDS the verified user's access token to PostgREST
--     (apikey: anon + Authorization: Bearer <user token>), so Postgres
--     evaluates RLS AS THAT USER. The service-role key is NEVER used for
--     user-owned data. The backend derives user_id ONLY from the verified
--     session - a client-supplied user id is ignored.
--
-- API:
--   POST   /api/user/continue-watching  save/update progress (upsert)
--   GET    /api/user/continue-watching  { items: [...], count } newest first
--   DELETE /api/user/continue-watching/:anilistId  remove one entry
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if exists / drop policy if exists).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- After applying, refresh the PostgREST schema cache (notify pgrst below).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: user_id + anilist_id is the identity (AniList ID = canonical anime
-- identity, same convention as watchlist and the rest of the API). progress is
-- optional: null when the player did not report it (omitted from the API
-- response), a number of seconds otherwise.
-- -----------------------------------------------------------------------------
create table if not exists public.continue_watching (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  anilist_id bigint      not null check (anilist_id > 0),
  episode    integer     not null check (episode > 0),
  progress   double precision check (progress is null or progress >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Uniqueness per (user, anime) AND the conflict target that makes the
  -- progress save a single-statement upsert (no read-before-write race).
  primary key (user_id, anilist_id)
);

-- Newest-watched-first listing per user (the Continue Watching read path).
create index if not exists continue_watching_user_updated_at_idx
  on public.continue_watching (user_id, updated_at desc);

-- -----------------------------------------------------------------------------
-- Row level security: ONLY the owner can read/write their rows
-- -----------------------------------------------------------------------------
alter table public.continue_watching enable row level security;

drop policy if exists "continue_watching_select_own" on public.continue_watching;
create policy "continue_watching_select_own"
  on public.continue_watching
  for select
  using (auth.uid() = user_id);

drop policy if exists "continue_watching_insert_own" on public.continue_watching;
create policy "continue_watching_insert_own"
  on public.continue_watching
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "continue_watching_update_own" on public.continue_watching;
create policy "continue_watching_update_own"
  on public.continue_watching
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "continue_watching_delete_own" on public.continue_watching;
create policy "continue_watching_delete_own"
  on public.continue_watching
  for delete
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- Grants: the `authenticated` role (a verified user token via PostgREST).
-- anon never accesses this table; the backend never uses service_role here.
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.continue_watching to authenticated;
revoke all on public.continue_watching from anon;

notify pgrst, 'reload schema';
