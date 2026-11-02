/**
 * Watchlist service - persistent, account-backed watchlist stored in Supabase.
 *
 * STORAGE: public.watchlist (user_id uuid, anime_id bigint = AniList ID,
 * added_at timestamptz; primary key (user_id, anime_id)) with RLS policies
 * keyed on auth.uid() (see supabase/migrations/20261102000003_watchlist.sql).
 *
 * IDENTITY SECURITY: the user id ALWAYS comes from the verified session
 * (req.user.id, attached by requireUser AFTER upstream token verification).
 * No user id is ever accepted from the request body/query - a caller cannot
 * read or modify another user's watchlist even by supplying a foreign id.
 *
 * RLS ENFORCEMENT: the backend forwards the VERIFIED user's access token to
 * PostgREST (apikey: anon + Authorization: Bearer <user token>), so Postgres
 * evaluates row-level security AS THAT USER. The service-role key is NEVER
 * used for user-owned data (it would bypass RLS).
 *
 * CONTRACT (frontend):
 *   list   -> { items: [{ animeId, addedAt }], count }   (newest first)
 *   add    -> { added: true,  animeId, addedAt }         first time
 *          -> { added: false, animeId, addedAt: null }   already present
 *   remove -> { animeId }                                idempotent
 *
 * Only the ANILIST ID is stored (the canonical identity of the anime API) plus
 * the save timestamp. Titles/artwork are intentionally NOT duplicated here -
 * the frontend hydrates them through the existing anime endpoints so display
 * data is always current.
 */

import { config } from '../config/env.js';
import { AppError, ProviderError, UnauthorizedError } from '../errors/index.js';
import { PostgrestClient } from '../supabase/rest-client.js';
import { parseRequiredId } from '../identity/id-types.js';

const WATCHLIST_TABLE = 'watchlist';

/**
 * PostgREST applies a server-side max-rows cap (Supabase default 1000) and
 * would silently truncate larger result sets; request exactly that bound so
 * the behavior is explicit and documented.
 */
export const WATCHLIST_MAX_ROWS = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defensive guard: the id MUST be the verified-session UUID. This is not user
 * input validation - it protects against a programming error where a
 * controller forgot to run requireUser (fails closed).
 * @param {unknown} userId
 */
function requireVerifiedUserId(userId) {
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
    throw new UnauthorizedError('User authentication required');
  }
}

/**
 * Build a PostgREST client acting AS THE VERIFIED USER (RLS applies).
 * @param {string} accessToken
 * @returns {PostgrestClient}
 */
function userClient(accessToken) {
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    throw new ProviderError('Watchlist storage is not configured', { provider: 'supabase' });
  }
  return new PostgrestClient({
    url: config.SUPABASE_URL,
    apiKey: config.SUPABASE_ANON_KEY,
    accessToken,
  });
}

/**
 * Map infrastructure failures to a typed API error. Upstream status/code are
 * carried for diagnosis; credentials are never included.
 * @param {unknown} err
 * @param {string} operation
 * @returns {AppError}
 */
function wrapStorageError(err, operation) {
  if (err instanceof AppError) return err;
  const source = err && typeof err === 'object' ? err : {};
  return new ProviderError('Watchlist storage is temporarily unavailable', {
    provider: 'supabase',
    cause: err instanceof Error ? err : undefined,
    details: {
      operation,
      ...(source.upstreamStatus !== undefined ? { upstreamStatus: source.upstreamStatus } : {}),
      ...(source.upstreamCode !== undefined ? { upstreamCode: source.upstreamCode } : {}),
      ...(source.upstreamMessage !== undefined ? { upstreamMessage: source.upstreamMessage } : {}),
    },
  });
}

/**
 * List the authenticated user's watchlist, newest first.
 * @param {{ userId: string, accessToken: string }} params
 * @returns {Promise<{ items: Array<{ animeId: number, addedAt: string }>, count: number }>}
 */
export async function listWatchlist({ userId, accessToken }) {
  requireVerifiedUserId(userId);
  try {
    const rows = await userClient(accessToken).select(WATCHLIST_TABLE, {
      filters: { user_id: userId },
      columns: 'anime_id,added_at',
      order: 'added_at.desc',
      limit: WATCHLIST_MAX_ROWS,
    });
    const items = rows.map((row) => ({
      animeId: Number(row.anime_id),
      addedAt: String(row.added_at),
    }));
    return { items, count: items.length };
  } catch (err) {
    throw wrapStorageError(err, 'list');
  }
}

/**
 * Idempotently add an anime (AniList ID) to the authenticated user's
 * watchlist. A repeat add is a no-op success (`added: false`).
 * @param {{ userId: string, accessToken: string, animeId: unknown }} params
 * @returns {Promise<{ added: boolean, animeId: number, addedAt: string | null }>}
 */
export async function addToWatchlist({ userId, accessToken, animeId }) {
  requireVerifiedUserId(userId);
  const id = parseRequiredId(animeId, 'animeId');
  try {
    const rows = await userClient(accessToken).insert(
      WATCHLIST_TABLE,
      // user_id is derived from the VERIFIED session only - never the body.
      { user_id: userId, anime_id: id },
      {
        onConflict: 'user_id,anime_id',
        // ignore-duplicates = INSERT ... ON CONFLICT DO NOTHING: the add is
        // idempotent and never overwrites the original added_at.
        prefer: 'return=representation,resolution=ignore-duplicates',
      },
    );
    const row = rows[0];
    return {
      added: Boolean(row),
      animeId: id,
      addedAt: row ? String(row.added_at) : null,
    };
  } catch (err) {
    throw wrapStorageError(err, 'add');
  }
}

/**
 * Idempotently remove an anime from the authenticated user's watchlist.
 * Removing an absent entry is a no-op success.
 * @param {{ userId: string, accessToken: string, animeId: unknown }} params
 * @returns {Promise<{ animeId: number }>}
 */
export async function removeFromWatchlist({ userId, accessToken, animeId }) {
  requireVerifiedUserId(userId);
  const id = parseRequiredId(animeId, 'animeId');
  try {
    await userClient(accessToken).delete(WATCHLIST_TABLE, { user_id: userId, anime_id: id });
    return { animeId: id };
  } catch (err) {
    throw wrapStorageError(err, 'remove');
  }
}
