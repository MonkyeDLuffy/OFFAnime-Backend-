/**
 * Continue Watching service - per-user playback progress stored in Supabase.
 *
 * STORAGE: public.continue_watching (user_id uuid, anilist_id bigint = AniList
 * ID, episode integer, progress double precision optional, created_at,
 * updated_at timestamptz; primary key (user_id, anilist_id)) with RLS policies
 * keyed on auth.uid() (see supabase/migrations/20261102000004_continue_watching.sql).
 *
 * IDENTITY SECURITY: the user id ALWAYS comes from the verified session
 * (req.user.id, attached by requireUser AFTER upstream token verification).
 * No user id is ever accepted from the request body/query - a caller cannot
 * read or modify another user's progress even by supplying a foreign id.
 *
 * RLS ENFORCEMENT: the backend forwards the VERIFIED user's access token to
 * PostgREST (apikey: anon + Authorization: Bearer <user token>), so Postgres
 * evaluates row-level security AS THAT USER. The service-role key is NEVER
 * used for user-owned data (it would bypass RLS).
 *
 * CONTRACT (frontend):
 *   POST body  -> { anilistId, episode, progress? }   (progress optional)
 *   save       -> { saved: true, entry: { anilistId, episode, progress?, updatedAt } }
 *   list       -> { items: [{ anilistId, episode, progress?, updatedAt }], count }  newest first
 *   remove     -> { anilistId }                        idempotent
 *
 * `progress` is optional and stored nullable: absent in the request means
 * null in the DB, which the API omits from responses. Display metadata
 * (titles, artwork) is NOT stored here - the frontend hydrates it through
 * the existing anime details/episode APIs.
 */

import { config } from '../config/env.js';
import { AppError, ProviderError, UnauthorizedError, ValidationError } from '../errors/index.js';
import { PostgrestClient } from '../supabase/rest-client.js';
import { parseRequiredId } from '../identity/id-types.js';

const CONTINUE_WATCHING_TABLE = 'continue_watching';

/**
 * PostgREST applies a server-side max-rows cap (Supabase default 1000) and
 * would silently truncate larger result sets; request exactly that bound so
 * the behavior is explicit and documented.
 */
export const CONTINUE_WATCHING_MAX_ROWS = 1000;

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
    throw new ProviderError('Continue Watching storage is not configured', { provider: 'supabase' });
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
  return new ProviderError('Continue Watching storage is temporarily unavailable', {
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

// --- input validation -----------------------------------------------------------

/**
 * Require a positive integer ID (AniList ID or episode number).
 * @param {unknown} value
 * @param {string} [label='id']
 * @returns {number}
 */
function requirePositiveId(value, label = 'id') {
  return parseRequiredId(value, label);
}

/**
 * Optional playback progress in seconds: absent/empty -> null; otherwise a
 * finite non-negative number.
 * @param {unknown} value
 * @returns {number | null}
 */
function optionalProgress(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError('Invalid progress: expected a non-negative number of seconds', { received: value });
  }
  return n;
}

// --- row mapping -------------------------------------------------------------------

/**
 * Map a PostgREST row onto the API shape. `progress` is omitted entirely when
 * null (optional field).
 * @param {Record<string, unknown>} row
 */
function toEntry(row) {
  const entry = {
    anilistId: Number(row.anilist_id),
    episode: Number(row.episode),
    updatedAt: String(row.updated_at),
  };
  if (row.progress !== null && row.progress !== undefined) {
    entry.progress = Number(row.progress);
  }
  return entry;
}

// --- public API ---------------------------------------------------------------------

/**
 * Save (upsert) the authenticated user's playback progress for one anime.
 * Saves never create duplicates: the single-statement upsert targets
 * (user_id, anilist_id). `updated_at` moves forward on every save.
 *
 * @param {{ userId: string, accessToken: string, input: Record<string, unknown> }} params
 * @returns {Promise<{ saved: true, entry: object }>}
 */
export async function saveContinueWatching({ userId, accessToken, input }) {
  requireVerifiedUserId(userId);
  const body = input && typeof input === 'object' ? input : {};

  const anilistId = requirePositiveId(body.anilistId, 'anilistId');
  const episode = requirePositiveId(body.episode, 'episode');
  const progress = optionalProgress(body.progress);

  // updated_at rides in the payload so it is refreshed on both insert and the
  // UPDATE arm of the upsert. created_at is intentionally omitted: DB default
  // on insert, preserved on conflict.
  const now = new Date().toISOString();

  try {
    const rows = await userClient(accessToken).insert(
      CONTINUE_WATCHING_TABLE,
      // user_id is derived from the VERIFIED session only - never the body.
      {
        user_id: userId,
        anilist_id: anilistId,
        episode,
        ...(progress !== null ? { progress } : {}),
        updated_at: now,
        // created_at intentionally omitted - default on insert, preserved on conflict.
      },
      {
        onConflict: 'user_id,anilist_id',
        prefer: 'return=representation,resolution=merge-duplicates',
      },
    );
    const row = rows[0];
    if (!row) {
      // merge-duplicates ALWAYS returns a representation for an owned row;
      // an empty payload means RLS hid it (ownership broke) - fail loudly.
      throw new ProviderError('Continue Watching progress was not stored', {
        provider: 'supabase',
        details: { operation: 'save' },
      });
    }
    return { saved: true, entry: toEntry(row) };
  } catch (err) {
    throw wrapStorageError(err, 'save');
  }
}

/**
 * List the authenticated user's Continue Watching entries, newest watch first.
 * @param {{ userId: string, accessToken: string }} params
 * @returns {Promise<{ items: Array<object>, count: number }>}
 */
export async function listContinueWatching({ userId, accessToken }) {
  requireVerifiedUserId(userId);
  try {
    const rows = await userClient(accessToken).select(CONTINUE_WATCHING_TABLE, {
      filters: { user_id: userId },
      columns: 'anilist_id,episode,progress,updated_at',
      order: 'updated_at.desc',
      limit: CONTINUE_WATCHING_MAX_ROWS,
    });
    const items = rows.map(toEntry);
    return { items, count: items.length };
  } catch (err) {
    throw wrapStorageError(err, 'list');
  }
}

/**
 * Idempotently remove one anime (AniList ID) from the authenticated user's
 * Continue Watching. Removing an absent entry is a no-op success.
 * @param {{ userId: string, accessToken: string, anilistId: unknown }} params
 * @returns {Promise<{ anilistId: number }>}
 */
export async function removeContinueWatching({ userId, accessToken, anilistId }) {
  requireVerifiedUserId(userId);
  const id = requirePositiveId(anilistId, 'anilistId');
  try {
    await userClient(accessToken).delete(CONTINUE_WATCHING_TABLE, { user_id: userId, anilist_id: id });
    return { anilistId: id };
  } catch (err) {
    throw wrapStorageError(err, 'remove');
  }
}
