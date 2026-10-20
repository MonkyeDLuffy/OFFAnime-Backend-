/**
 * Test helper: boots the real Express app on an ephemeral port with a mocked
 * global fetch routed by provider host.
 *
 * Zero-dependency endpoint testing - no live AniList/Jikan/TMDB/Supabase.
 * - Requests to `graphql.anilist.co`   -> routeAnilist(body, call)
 * - Requests to `api.jikan.moe`        -> routeJikan(url, call)
 * - Requests to `api.themoviedb.org`   -> routeTmdb(url, call)
 * - Requests to `megaplay.buzz`        -> routeMegaplay(url, call) (Phase 8)
 * - Anything else                      -> hard failure (unexpected request).
 *
 * Supabase L2 stays unconfigured in tests (empty env vars), so the cache
 * manager runs L1-only - exactly like a serverless cold start.
 *
 * Usage:
 *   const mock = installApiMocks({ anilist, jikan, tmdb });
 *   const server = await startTestServer();
 *   try { ... } finally { await server.stop(); mock.restore(); }
 */

import { cacheManager } from '../../src/cache/cache-manager.js';

/**
 * Parse the AniList GraphQL body from a mock fetch call.
 * @param {{ url: string, init: RequestInit, method: string }} call
 * @returns {{ query: string, variables: Record<string, unknown> }}
 */
export function anilistRequestBody(call) {
  return JSON.parse(String(call.init.body ?? '{}'));
}

/**
 * Start the app on a random free port and return its base URL + a stop fn.
 *
 * While the server runs, the global fetch is wrapped so every LOCALHOST
 * request automatically carries the configured test API key
 * (`Authorization: Bearer <BACKEND_API_SECRET>`). Provider calls made BY the
 * app go to external hosts and are untouched. Existing endpoint tests therefore
 * keep calling plain `fetch(baseUrl + path)` while the fail-closed API-key
 * middleware is active; tests that verify REJECTION send requests without the
 * key via a raw fetch captured before this wrapper (or rely on it being
 * removed in `stop()`).
 *
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void> }>}
 */
export async function startTestServer() {
  const { createApp } = await import('../../src/app.js');
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const secret = process.env.BACKEND_API_SECRET;
  /** @type {(() => void) | null} */
  let unwrapFetch = null;
  if (secret) {
    const previous = globalThis.fetch;
    globalThis.fetch = (url, init = {}) => {
      const target = String(url);
      if (target.includes('127.0.0.1') || target.includes('localhost')) {
        init = {
          ...init,
          headers: { ...(init.headers ?? {}), Authorization: `Bearer ${secret}` },
        };
      }
      return previous(url, init);
    };
    unwrapFetch = () => {
      globalThis.fetch = previous;
    };
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      unwrapFetch?.();
      unwrapFetch = null;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Install a mock fetch routed by provider host. Every registered provider
 * host MUST have a handler; any other request fails the test loudly so no
 * unexpected network call slips through (e.g. accidental MegaPlay usage).
 *
 * @param {object} handlers
 * @param {(body: { query: string, variables: Record<string, unknown> }, call: object) => Promise<Response | object> | Response | object} [handlers.anilist]
 *   Return a real Response or a descriptor { status, json }.
 * @param {(url: string, call: object) => Promise<Response | object> | Response | object} [handlers.jikan]
 * @param {(url: string, call: object) => Promise<Response | object> | Response | object} [handlers.tmdb]
 * @param {(url: string, call: object) => Promise<Response | object> | Response | object} [handlers.megaplay]
 * @param {(url: string, call: object) => Promise<Response | object> | Response | object} [handlers.supabaseAuth]
 *   Supabase Auth (GoTrue) requests - routed by the `/auth/v1/` path segment
 *   regardless of project host.
 * @param {(url: string, call: object) => Promise<Response | object> | Response | object} [handlers.supabaseRest]
 *   Supabase PostgREST (L2 cache) requests - routed by the `/rest/v1/` path.
 * @returns {{ calls: Array<object>, restore: () => void }}
 */
export function installApiMocks({ anilist, jikan, tmdb, megaplay, anizip, supabaseAuth, supabaseRest } = {}) {
  const original = globalThis.fetch;
  /** @type {Array<object>} */
  const calls = [];

  const asResponse = async (result) => {
    if (result instanceof Response) return result;
    if (result && typeof result === 'object' && 'status' in result) {
      const body = result.body !== undefined ? result.body : JSON.stringify(result.json ?? {});
      return new Response(body, {
        status: result.status,
        headers: { 'content-type': result.contentType ?? 'application/json' },
      });
    }
    // Bare object -> a successful JSON response body.
    if (result && typeof result === 'object') {
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('mock handler must return a Response or object');
  };

  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, method: init.method ?? 'GET' };
    // Pass through the test's own HTTP requests to the local app server.
    if (call.url.includes('127.0.0.1') || call.url.includes('localhost')) {
      return original(url, init);
    }
    calls.push(call);

    if (call.url.includes('graphql.anilist.co')) {
      if (!anilist) throw new Error(`unexpected AniList request: ${call.url}`);
      return asResponse(await anilist(anilistRequestBody(call), call));
    }
    if (call.url.includes('api.jikan.moe')) {
      if (!jikan) throw new Error(`unexpected Jikan request: ${call.url}`);
      return asResponse(await jikan(call.url, call));
    }
    if (call.url.includes('api.themoviedb.org')) {
      if (!tmdb) throw new Error(`unexpected TMDB request: ${call.url}`);
      return asResponse(await tmdb(call.url, call));
    }
    if (call.url.includes('megaplay')) {
      if (!megaplay) throw new Error(`unexpected MegaPlay request: ${call.url}`);
      return asResponse(await megaplay(call.url, call));
    }
    if (call.url.includes('api.ani.zip')) {
      if (!anizip) throw new Error(`unexpected AniZip request: ${call.url}`);
      return asResponse(await anizip(call.url, call));
    }
    if (call.url.includes('/auth/v1/')) {
      if (!supabaseAuth) throw new Error(`unexpected Supabase Auth request: ${call.url}`);
      return asResponse(await supabaseAuth(call.url, call));
    }
    if (call.url.includes('/rest/v1/')) {
      if (!supabaseRest) throw new Error(`unexpected Supabase REST request: ${call.url}`);
      return asResponse(await supabaseRest(call.url, call));
    }
    throw new Error(`unexpected fetch to non-provider host: ${call.url}`);
  };

  return {
    calls,
    /** All AniList calls (parsed bodies included). */
    anilistCalls: () =>
      calls
        .filter((c) => c.url.includes('graphql.anilist.co'))
        .map((c) => ({ ...c, body: anilistRequestBody(c) })),
    /** All Jikan call URLs. */
    jikanCalls: () => calls.filter((c) => c.url.includes('api.jikan.moe')).map((c) => c.url),
    /** All TMDB call URLs. */
    tmdbCalls: () => calls.filter((c) => c.url.includes('api.themoviedb.org')).map((c) => c.url),
    /** All MegaPlay call URLs. */
    megaplayCalls: () => calls.filter((c) => c.url.includes('megaplay')),
    /** All AniZip call URLs. */
    anizipCalls: () => calls.filter((c) => c.url.includes('api.ani.zip')).map((c) => c.url),
    /** All Supabase Auth (GoTrue) calls. */
    supabaseAuthCalls: () => calls.filter((c) => c.url.includes('/auth/v1/')),
    /** All Supabase PostgREST (L2 cache) calls. */
    supabaseRestCalls: () => calls.filter((c) => c.url.includes('/rest/v1/')),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Clear the L1 memory cache between tests (module-level shared state). */
export function resetL1Cache() {
  return cacheManager.l1.clear();
}

/**
 * Expire an L1 cache entry WITHOUT deleting it (retained for stale-if-error).
 * Lets endpoint tests exercise the stale path without waiting out real TTLs.
 * @param {string} key
 */
export function expireL1Entry(key) {
  const entry = cacheManager.l1._map.get(key);
  if (!entry) throw new Error(`no L1 cache entry for key: ${key}`);
  cacheManager.l1._map.set(key, {
    ...entry,
    expiresAt: Date.now() - 1000,
  });
}

// --- fixtures -----------------------------------------------------------------

/**
 * Raw AniList Media fixture.
 * @param {{ id?: number, idMal?: number|null, title?: string, bannerImage?: string|null, coverImage?: string|null, format?: string, extra?: object }} [options]
 */
export function anilistMedia({ id = 123, idMal = 456, title = 'Test Anime', bannerImage = null, coverImage = null, format = 'TV', extra = {} } = {}) {
  return {
    id,
    idMal,
    title: { romaji: title, english: `${title} EN`, native: 'テスト', userPreferred: title },
    description: '<p>A <b>test</b> anime & more.</p>',
    coverImage: { extraLarge: coverImage, large: coverImage, medium: coverImage },
    bannerImage,
    type: 'ANIME',
    format,
    status: 'FINISHED',
    episodes: 12,
    duration: 24,
    season: 'WINTER',
    seasonYear: 2023,
    genres: ['Action', 'Adventure'],
    synonyms: [`${title} Alt`],
    startDate: { year: 2023, month: 1, day: 10 },
    endDate: { year: 2023, month: 3, day: 28 },
    averageScore: 85,
    popularity: 100000,
    studios: { nodes: [{ name: 'Test Studio' }] },
    ...extra,
  };
}

/**
 * Raw AniList Page (search/seasonal) fixture.
 * @param {object[]} [media] @param {object} [pageInfo]
 */
export function anilistPage(media = [], pageInfo = { total: media.length, currentPage: 1, lastPage: 1, hasNextPage: false, perPage: 20 }) {
  return { data: { Page: { pageInfo, media } } };
}

/**
 * Raw Jikan anime fixture ({ data: {...} } wrapper).
 * @param {{ malId?: number, title?: string, extra?: object }} [options]
 */
export function jikanAnime({ malId = 456, title = 'Test Anime', extra = {} } = {}) {
  return {
    data: {
      mal_id: malId,
      title,
      title_english: `${title} EN`,
      title_japanese: 'テスト',
      images: { jpg: { image_url: 'https://cdn.jikan.moe/img.jpg', large_image_url: 'https://cdn.jikan.moe/img_l.jpg', small_image_url: 'https://cdn.jikan.moe/img_s.jpg' }, webp: {} },
      synopsis: 'A test synopsis.',
      background: null,
      genres: [{ mal_id: 1, name: 'Action' }],
      studios: [{ mal_id: 5, name: 'Test Studio' }],
      producers: [],
      score: 8.5,
      rank: 100,
      members: 90000,
      favorites: 1000,
      aired: { from: '2023-01-10T00:00:00+00:00', to: '2023-03-28T00:00:00+00:00', prop: { from: { year: 2023, month: 1, day: 10 }, to: { year: 2023, month: 3, day: 28 } }, string: 'Jan 10, 2023 to Mar 28, 2023' },
      season: 'winter',
      year: 2023,
      type: 'TV',
      status: 'Finished Airing',
      episodes: 12,
      duration: '24 min per ep',
      ...extra,
    },
  };
}

/**
 * Raw Jikan episodes HTTP body ({ pagination, data: [...] }).
 * @param {object[]} [episodes] @param {object} [pageInfo]
 */
export function jikanEpisodes(episodes = [], pageInfo = { last_visible_page: 1, has_next_page: false, current_page: 1, items: { count: episodes.length, total: episodes.length, per_page: 100 } }) {
  return { status: 200, json: { pagination: pageInfo, data: episodes } };
}

/**
 * Raw Jikan episode entry.
 * @param {{ malId?: number, number?: number, title?: string }} [options]
 */
export function jikanEpisode({ malId = 456, number = 1, title = 'Episode 1' } = {}) {
  return { mal_id: malId, number, title, title_japanese: '第1話', title_romanji: 'Dai 1 Wa', aired: '2023-01-10T00:00:00+00:00', score: 8, filler: false, recap: false, forum_url: null, url: null };
}

/**
 * Raw TMDB search fixture ({ results: [...] }).
 * @param {object[]} [results]
 */
export function tmdbSearchResults(results = []) {
  return { status: 200, json: { page: 1, results, total_pages: 1, total_results: results.length } };
}

/**
 * Raw TMDB TV candidate.
 * @param {{ id?: number, name?: string, originalName?: string, firstAirDate?: string, backdropPath?: string|null, popularity?: number }} [options]
 */
export function tmdbTvCandidate({ id = 789, name = 'Test Anime', originalName = name, firstAirDate = '2023-01-10', backdropPath = '/backdrop.jpg', popularity = 50 } = {}) {
  return { id, name, original_name: originalName, first_air_date: firstAirDate, backdrop_path: backdropPath, poster_path: '/poster.jpg', popularity };
}

/**
 * Raw TMDB TV details fixture (seasons array included).
 * @param {object[]} [seasons]
 */
export function tmdbTvDetails(seasons = []) {
  return { status: 200, json: { id: 789, name: 'Test Anime', seasons } };
}

/**
 * Raw TMDB images metadata entry (backdrop).
 * @param {{ path?: string, width?: number, height?: number, language?: string|null, voteAverage?: number }} [options]
 */
export function tmdbBackdrop({ path = '/backdrop.jpg', width = 3840, height = 2160, language = null, voteAverage = 5.5 } = {}) {
  return { file_path: path, width, height, iso_639_1: language, vote_average: voteAverage, vote_count: 10, aspect_ratio: 1.777 };
}

/**
 * Raw TMDB images metadata entry (logo).
 * @param {{ path?: string, language?: string|null, voteAverage?: number }} [options]
 */
export function tmdbLogo({ path = '/logo.png', language = 'en', voteAverage = 5 } = {}) {
  return { file_path: path, iso_639_1: language, vote_average: voteAverage, vote_count: 3, width: 1000, height: 500 };
}

/**
 * Raw TMDB images metadata payload ({ id, backdrops, logos, posters }).
 * @param {{ id?: number, backdrops?: object[], logos?: object[] }} [options]
 */
export function tmdbImages({ id = 789, backdrops = [tmdbBackdrop()], logos = [tmdbLogo()] } = {}) {
  return { status: 200, json: { id, backdrops, logos, posters: [] } };
}

/**
 * Raw TMDB video entry (videos payload member).
 * @param {{ key?: string, name?: string, site?: string, type?: string, official?: boolean, publishedAt?: string }} [options]
 */
export function tmdbVideo({ key = 'abc123', name = 'Official Trailer', site = 'YouTube', type = 'Trailer', official = true, publishedAt = '2023-01-01T00:00:00.000Z' } = {}) {
  return { name, key, site, type, official, published_at: publishedAt, id: `video-${key}`, size: 1080, iso_639_1: 'en', iso_3166_1: 'US' };
}

/**
 * Raw TMDB videos payload ({ id, results }).
 * @param {{ id?: number, results?: object[] }} [options]
 */
export function tmdbVideos({ id = 789, results = [tmdbVideo()] } = {}) {
  return { status: 200, json: { id, results } };
}

/**
 * Raw TMDB season fixture ({ episodes: [...] }).
 * @param {number} seasonNumber
 * @param {object[]} [episodes]
 */
export function tmdbSeason(seasonNumber, episodes = []) {
  return { status: 200, json: { id: 789, season_number: seasonNumber, name: `Season ${seasonNumber}`, episodes } };
}

/**
 * Raw TMDB season episode entry.
 * @param {{ id?: number, seasonNumber?: number, number?: number, name?: string, overview?: string, airDate?: string, runtime?: number, stillPath?: string|null, voteAverage?: number, voteCount?: number, episodeType?: string, extra?: object }} [options]
 */
export function tmdbEpisode({ id, seasonNumber = 1, number = 1, name, overview, airDate, runtime, stillPath, voteAverage, voteCount, episodeType, extra = {} } = {}) {
  return {
    id,
    season_number: seasonNumber,
    episode_number: number,
    name: name ?? `Ep S${seasonNumber}E${number}`,
    overview: overview ?? `Overview for S${seasonNumber}E${number}`,
    air_date: airDate ?? '2023-01-10',
    runtime: runtime ?? 24,
    still_path: stillPath === undefined ? `/still-s${seasonNumber}-e${number}.jpg` : stillPath,
    vote_average: voteAverage ?? 7.5,
    vote_count: voteCount ?? 10,
    episode_type: episodeType ?? 'standard',
    ...extra,
  };
}

/**
 * TMDB season-number list fixture (TV details' seasons array).
 * @param {number[]} [seasonNumbers]
 */
export function tmdbSeasonsList(seasonNumbers = []) {
  return seasonNumbers.map((seasonNumber) => ({ season_number: seasonNumber, name: `Season ${seasonNumber}`, episode_count: 0 }));
}

// --- AniZip fixtures ----------------------------------------------------------

/**
 * Raw AniZip episode entry, shaped exactly like the live mappings response
 * (verified: anilist_id=21 One Piece, anilist_id=20 Naruto).
 * @param {{ episode?: number, title?: string, titleJa?: string|null, titleVariants?: object|null, image?: string|null, overview?: string|null, airDate?: string|null, airDateUtc?: string|null, runtime?: number|null, rating?: string|null, extra?: object }} [options]
 */
export function anizipEpisode({
  episode = 1,
  title = `Episode ${episode}`,
  titleJa = null,
  titleVariants,
  image = null,
  overview = null,
  airDate = null,
  airDateUtc = null,
  runtime = null,
  rating = null,
  extra = {},
} = {}) {
  return {
    tvdbShowId: 81797,
    tvdbId: 361880 + episode,
    seasonNumber: 1,
    episodeNumber: episode,
    absoluteEpisodeNumber: episode,
    title: {
      en: title,
      ...(titleJa !== null ? { ja: titleJa } : {}),
      'x-jat': `Romaji ${title}`,
      ...(titleVariants !== undefined ? titleVariants : {}),
    },
    airDate,
    airDateUtc,
    runtime,
    overview,
    image,
    episode: String(episode),
    anidbEid: 400 + episode,
    length: runtime,
    airdate: airDate,
    rating,
    summary: overview === null ? null : `${overview} (AniDB)`,
    ...extra,
  };
}

/**
 * Raw AniZip mappings payload ({ titles, episodes, episodeCount, specialCount,
 * images, mappings }) - `episodes` is an OBJECT keyed by episode number, with
 * prefixed keys (S1/O29) for specials, exactly like the live response.
 * @param {{ anilistId?: number, malId?: number, episodes?: Record<string, object>, specialCount?: number, extra?: object }} [options]
 */
export function anizipMappings({
  anilistId = 123,
  malId = 456,
  episodes = { '1': anizipEpisode({ episode: 1 }), '2': anizipEpisode({ episode: 2 }) },
  specialCount = 0,
  extra = {},
} = {}) {
  return {
    titles: { en: 'Test Anime', ja: 'テストアニメ', 'x-jat': 'Testo Anime' },
    episodes,
    episodeCount: Object.keys(episodes).filter((k) => /^\d+$/.test(k)).length,
    specialCount,
    images: [{ coverType: 'Poster', url: 'https://artworks.example/poster.jpg' }],
    mappings: { anilist_id: anilistId, mal_id: malId, type: 'TV' },
    ...extra,
  };
}

/**
 * AniZip "no mapping for this ID" response (live-verified: HTTP 404 + JSON
 * string "Not Found"). Use as `anizip: anizipNotFound` in tests that exercise
 * the fallback chain (AniZip cannot provide -> TMDB -> Jikan).
 * @returns {{ status: number, body: string, contentType: string }}
 */
export function anizipNotFound() {
  return { status: 404, body: '"Not Found"', contentType: 'application/json' };
}
