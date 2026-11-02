/**
 * Continue Watching service - per-user playback progress stored in Supabase.
 *
 * STORAGE: public.continue_watching (user_id uuid, anilist_id bigint = AniList
 * ID, mal_id, display snapshot, episode, position/duration seconds, language,
 * last_watched_at/created_at/updated_at; primary key (user_id, anilist_id))
 * with RLS policies keyed on auth.uid() (see
 * supabase/migrations/20261102000004_continue_watching.sql).
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
 * UPSERT / NO-DUPLICATES: saving is a SINGLE PostgREST insert with
 * `on_conflict=user_id,anilist_id` + `resolution=merge-duplicates`
 * (INSERT ... ON CONFLICT DO UPDATE). The created_at AND updated_at columns
 * are intentionally omitted from the payload: a first save lets their
 * defaults apply (DB clock), a conflicting save preserves the original
 * created_at while the DB trigger refreshes updated_at to now(). So
 * created_at === updated_at holds EXACTLY on a freshly created row - the
 * honest signal for the 201 (created) vs 200 (updated) status. There is no
 * anime-completed state: finishing one episode never removes or closes the
 * entry (position is merely clamped to the reported duration).
 *
 * CONTRACT (frontend):
 *   save   -> { saved: true, entry: {...row} }   201 first created / 200 updated
 *   list   -> { items: [...rows], count }        newest first
 *   remove -> { anilistId }                      idempotent
 *
 * The DISPLAY snapshot (titles/artwork) is provided by the caller (the
 * frontend already has it from the anime pages) and stored with the row so a
 * cross-device resume needs NO extra catalog request to render.
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
const LANGUAGES = new Set(['sub', 'dub']);
const TITLE_MAX_LENGTH = 256;
const URL_MAX_LENGTH = 2048;

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
 * Require a non-empty, bounded string (trimmed).
 * @param {unknown} value
 * @param {string} label
 * @param {number} [maxLength]
 * @returns {string}
 */
function requireString(value, label, maxLength) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > maxLength) {
    throw new ValidationError(`${label} is required`);
  }
  return trimmed;
}

/**
 * Optional string: empty/absent -> null; over-long -> invalid.
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxLength
 * @returns {string | null}
 */
function optionalString(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new ValidationError(`Invalid ${label}: too long`);
  }
  return trimmed;
}

/**
 * Require a finite non-negative number (position progress in seconds).
 * Accepts numbers and numeric strings.
 * @param {unknown} value
 * @returns {number}
 */
function requirePosition(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError('Invalid position: expected a non-negative number of seconds', { received: value });
  }
  return n;
}

/**
 * Optional duration: absent/empty -> null; otherwise a finite positive number.
 * @param {unknown} value
 * @returns {number | null}
 */
function optionalDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError('Invalid duration: expected a positive number of seconds', { received: value });
  }
  return n;
}

/**
 * Require the playback language ('sub' | 'dub').
 * @param {unknown} value
 * @returns {'sub' | 'dub'}
 */
function requireLanguage(value) {
  if (value !== 'sub' && value !== 'dub') {
    throw new ValidationError('language must be "sub" or "dub"', { received: value });
  }
  return value;
}

// --- row mapping -------------------------------------------------------------------

/**
 * Map a PostgREST row onto the camelCase API shape.
 * @param {Record<string, unknown>} row
 */
function toEntry(row) {
  return {
    anilistId: Number(row.anilist_id),
    malId: row.mal_id === null || row.mal_id === undefined ? null : Number(row.mal_id),
    title: String(row.title),
    titleEnglish: row.title_english ?? null,
    titleRomaji: row.title_romaji ?? null,
    posterUrl: String(row.poster_url),
    bannerUrl: row.banner_url ?? null,
    episode: Number(row.episode),
    positionSeconds: Number(row.position_seconds),
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : Number(row.duration_seconds),
    language: String(row.language),
    lastWatchedAt: String(row.last_watched_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// --- public API ---------------------------------------------------------------------

/**
 * Save (upsert) the authenticated user's playback progress for one anime.
 * Saves never create duplicates: the single-statement upsert targets
 * (user_id, anilist_id). `created` tells a fresh record apart from an
 * in-place update (created_at === updated_at only on a fresh row, both set
 * by the DB itself).
 *
 * @param {{ userId: string, accessToken: string, input: Record<string, unknown> }} params
 * @returns {Promise<{ saved: true, created: boolean, entry: object }>}
 */
export async function saveContinueWatching({ userId, accessToken, input }) {
  requireVerifiedUserId(userId);
  const body = input && typeof input === 'object' ? input : {};

  const anilistId = parseRequiredId(body.anilistId, 'anilistId');
  // MAL ID is optional and never used as row identity; absent/empty -> null,
  // present-but-invalid -> 400 (never silently dropped).
  const malId = body.malId === undefined || body.malId === null || body.malId === ''
    ? null
    : parseRequiredId(body.malId, 'malId');
  const title = requireString(body.title, 'title', TITLE_MAX_LENGTH);
  const posterUrl = requireString(body.posterUrl, 'posterUrl', URL_MAX_LENGTH);
  const titleEnglish = optionalString(body.titleEnglish, 'titleEnglish', TITLE_MAX_LENGTH);
  const titleRomaji = optionalString(body.titleRomaji, 'titleRomaji', TITLE_MAX_LENGTH);
  const bannerUrl = optionalString(body.bannerUrl, 'bannerUrl', URL_MAX_LENGTH);
  const episode = parseRequiredId(body.episode, 'episode');
  const language = requireLanguage(body.language);
  const durationSeconds = optionalDuration(body.duration);
  const positionSeconds = requirePosition(body.position);
  // Episode-completion handling: a finished episode's position stays within
  // its duration; the ENTRY remains (there is no anime-completed state).
  const position = durationSeconds !== null ? Math.min(positionSeconds, durationSeconds) : positionSeconds;

  // last_watched_at rides in the payload (fresh on every save). created_at
  // and updated_at are DB-managed: defaults on insert, preserved/refreshed
  // (by the touch trigger) on conflict.
  const now = new Date().toISOString();

  try {
    const rows = await userClient(accessToken).insert(
      CONTINUE_WATCHING_TABLE,
      // user_id is derived from the VERIFIED session only - never the body.
      {
        user_id: userId,
        anilist_id: anilistId,
        ...(malId !== null ? { mal_id: malId } : {}),
        title,
        ...(titleEnglish ? { title_english: titleEnglish } : {}),
        ...(titleRomaji ? { title_romaji: titleRomaji } : {}),
        poster_url: posterUrl,
        ...(bannerUrl ? { banner_url: bannerUrl } : {}),
        episode,
        position_seconds: position,
        ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
        language,
        last_watched_at: now,
        // created_at/updated_at intentionally omitted - DB defaults on insert,
        // created_at preserved + updated_at refreshed by trigger on conflict.
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
    const entry = toEntry(row);
    return { saved: true, created: entry.createdAt === entry.updatedAt, entry };
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
      columns: 'anilist_id,mal_id,title,title_english,title_romaji,poster_url,banner_url,'
        + 'episode,position_seconds,duration_seconds,language,last_watched_at,created_at,updated_at',
      order: 'last_watched_at.desc',
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
  const id = parseRequiredId(anilistId, 'anilistId');
  try {
    await userClient(accessToken).delete(CONTINUE_WATCHING_TABLE, { user_id: userId, anilist_id: id });
    return { anilistId: id };
  } catch (err) {
    throw wrapStorageError(err, 'remove');
  }
}
