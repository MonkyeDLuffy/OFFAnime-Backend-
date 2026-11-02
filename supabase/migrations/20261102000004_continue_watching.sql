-- =============================================================================
-- Migration: continue_watching (per-user playback progress)
-- -----------------------------------------------------------------------------
-- One row per (user, anime): the LATEST episode + playback position. Rows are
-- UPSERTED (merge-duplicates on the primary key), so a repeat save updates the
-- existing entry and never creates duplicates. There is intentionally NO
-- "completed" status column: finishing a single episode or even the last
-- episode never marks an anime "completed" - an entry disappears only when the
-- user removes it (a completed episode is simply a position clamped to the
-- duration until the next save).
--
-- SECURITY MODEL (identical to the watchlist baseline):
--   - RLS is enabled with policies keyed on auth.uid(): a user can only ever
--     see/insert/update/delete THEIR OWN rows, even if a request tries to
--     supply a different user id.
--   - The backend FORWARDS the verified user's access token to PostgREST
--     (apikey: anon + Authorization: Bearer <user token>), so Postgres
--     evaluates RLS AS THAT USER. The service-role key is NEVER used for
--     user-owned data. The backend also derives user_id ONLY from the verified
--     session - a client-supplied user id is ignored. user_id is additionally
--     stored with a FK to auth.users and can never be out of sync with it.
--
-- API (backend, both data sets are fetched in parallel by the frontend after
-- login using the SAME verified session token):
--   POST   /api/user/continue-watching            save/update progress (upsert)
--   GET    /api/user/continue-watching            { items: [...], count } newest first
--   DELETE /api/user/continue-watching/:anilistId remove one entry (idempotent)
--
-- SAFE TO RUN MULTIPLE TIMES (idempotent: if exists / drop policy if exists).
-- Apply via: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table: one row per (user, anime) - the canonical anime identity is the
-- AniList ID (same convention as the existing anime/watchlist contract). The
-- MAL ID is kept when known, but it is NEVER the row identity and never used
-- alone to match a row.
-- -----------------------------------------------------------------------------
create table if not exists public.continue_watching (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  -- AniList ID (canonical anime identity). Bigint for headroom; positive.
  anilist_id  bigint      not null check (anilist_id > 0),
  -- Optional, when the frontend/provider knows it. Never used as identity.
  mal_id      bigint      check (mal_id is null or mal_id > 0),

  -- Display snapshot (the row is self-sufficient: no joins needed to render).
  title         text not null,
  title_english text,
  title_romaji  text,
  poster_url    text not null,
  banner_url    text,

  -- Progress.
  episode          integer         not null check (episode > 0),
  position_seconds double precision not null check (position_seconds >= 0),
  -- Null when the player did not report it.
  duration_seconds double precision check (duration_seconds is null or duration_seconds > 0),
  language         text            not null check (language in ('sub', 'dub')),

  -- Timestamps. created_at is only ever set on INSERT (the upsert payload
  -- omits it, so conflicts preserve the original). last_watched_at moves on
  -- every save; updated_at is maintained by the trigger below (DB clock -
  -- immune to backend clock skew and never stale on a conflicting update).
  last_watched_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Uniqueness per (user, anime) AND the conflict target that makes the
  -- progress save a single-statement upsert (no read-before-write race).
  primary key (user_id, anilist_id)
);

-- Bookkeeping trigger: updated_at = now() on every UPDATE (including the
-- UPDATE arm of the upsert's ON CONFLICT DO UPDATE), applied with the DB's
-- clock so created_at === updated_at holds EXACTLY on a fresh row and never
-- after a real update. The backend never sends updated_at in a save payload.
create or replace function continue_watching_touch_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists continue_watching_touch_updated_at_trg on public.continue_watching;
create trigger continue_watching_touch_updated_at_trg
  before update on public.continue_watching
  for each row execute function continue_watching_touch_updated_at();


-- Newest-first listing per user (the Continue Watching read path).
create index if not exists continue_watching_user_last_watched_idx
  on public.continue_watching (user_id, last_watched_at desc);

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

-- UPDATE is part of the upsert flow (merge-duplicates). Both USING and WITH
-- CHECK are the user's own id: a row can only progress while it stays theirs.
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
