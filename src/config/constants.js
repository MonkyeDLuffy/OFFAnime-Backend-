/**
 * Application-wide constants.
 *
 * Only truly stable, cross-cutting values belong here. Anything configurable
 * at runtime belongs in `env.js` instead.
 */

/** Human-readable service name (used in logs and the health payload). */
export const APP_NAME = 'offanime-backend';

/**
 * Service version. Kept in sync with package.json manually to avoid importing
 * JSON at runtime (which keeps the module portable across runtimes).
 */
export const APP_VERSION = '1.0.0';

/** All frontend routes are mounted under this prefix. */
export const API_PREFIX = '/api';

/**
 * Canonical provider identifiers. Use these constants instead of raw strings
 * so provider names stay consistent across logs, cache keys, and the registry.
 */
export const PROVIDERS = Object.freeze({
  ANILIST: 'anilist',
  JIKAN: 'jikan',
  TMDB: 'tmdb',
  MEGAPLAY: 'megaplay',
  ANIZIP: 'anizip',
});

/**
 * ID namespaces handled by the identity layer.
 * Keeping AniList and MAL explicitly separated is a hard requirement:
 * a MAL ID must NEVER be silently reinterpreted as an AniList ID.
 */
export const ID_TYPES = Object.freeze({
  ANILIST: 'anilist',
  MAL: 'mal',
});

/**
 * Suggested TTL presets (seconds) for the cache layer. Services pick the
 * preset that matches how volatile the underlying data is.
 */
export const CACHE_TTL = Object.freeze({
  SHORT: 60, // 1 minute  - fast-changing feeds
  MEDIUM: 300, // 5 minutes - search / listings
  LONG: 3600, // 1 hour    - anime details
  DAY: 86_400, // 24 hours  - rarely-changing metadata
});

/**
 * Freshness classification returned by the cache layer. The cache manager uses
 * these to decide between returning immediately, revalidating, or serving
 * stale-if-error data.
 */
export const CACHE_STATE = Object.freeze({
  FRESH: 'fresh', // within TTL
  STALE: 'stale', // past TTL but retained for stale-if-error
  MISS: 'miss', // not present
});

/** Supported streaming languages (documented MegaPlay endpoint contract). */
export const STREAM_LANGUAGES = Object.freeze({
  SUB: 'sub',
  DUB: 'dub',
});

/**
 * User-authentication (Supabase Auth) constants.
 *
 * Session architecture: token-first (the JSON body of login/signup/refresh
 * carries access/refresh tokens for `Authorization: Bearer` use from ANY
 * frontend/domain), PLUS optional HttpOnly cookies for same-site deployments.
 * The cookies are host-only (no Domain attribute) and the refresh cookie is
 * path-scoped to the auth endpoints so it is never sent with data requests.
 */
export const AUTH_COOKIES = Object.freeze({
  ACCESS: 'offanime_session',
  REFRESH: 'offanime_refresh',
  REFRESH_PATH: '/api/auth',
});

/** Email one-time-token types accepted by POST /api/auth/verify. */
export const AUTH_VERIFY_TYPES = Object.freeze(['signup', 'recovery']);

/**
 * Streaming cache TTLs (seconds). Streaming data is MORE volatile than anime
 * metadata: MegaPlay stream URLs/sources can rotate or expire independently
 * of the metadata caches, so valid stream results use a conservative SHORT
 * TTL (never the DAY/long metadata TTLs). Valid no-stream/unresolved results
 * are cached even more briefly, with semantics clearly distinguishable from a
 * real stream (`usable: false`) and from provider failures (never cached).
 */
export const STREAM_CACHE_TTL = Object.freeze({
  STREAM: 300, // 5 minutes - valid stream results (conservative short TTL)
  NO_RESULT: 60, // 1 minute  - valid no-stream/unresolved lookup results
});

/** Streaming input bounds (stream-route validation). */
export const STREAM_LIMITS = Object.freeze({
  MAX_EPISODE: 2000,
});

/**
 * Validated AniList filter values (Phase 7 search/category endpoints).
 * Frontend input is validated against these lists so arbitrary values never
 * reach AniList (invalid enums would surface as provider errors).
 */
export const ANILIST_SEASONS = Object.freeze(['WINTER', 'SPRING', 'SUMMER', 'FALL']);
export const ANILIST_FORMATS = Object.freeze(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);
export const ANILIST_STATUSES = Object.freeze(['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS']);
export const ANILIST_SORTS = Object.freeze([
  'POPULARITY_DESC',
  'POPULARITY_ASC',
  'TRENDING_DESC',
  'TRENDING_ASC',
  'SCORE_DESC',
  'SCORE_ASC',
  'FAVOURITES_DESC',
  'START_DATE_DESC',
  'START_DATE_ASC',
  'UPDATED_AT_DESC',
  'TITLE_ROMAJI',
  'TITLE_ENGLISH',
]);

/** AniList's standard genre list (category endpoint validation). */
export const ANILIST_GENRES = Object.freeze([
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Horror',
  'Mahou Shoujo',
  'Mecha',
  'Music',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
]);

/** Search pagination bounds (AniList caps perPage at 50). */
export const SEARCH_LIMITS = Object.freeze({
  MAX_PER_PAGE: 50,
  MAX_PAGE: 500,
  MAX_QUERY_LENGTH: 200,
});
