/**
 * TMDB normalized type definitions (JSDoc only - no runtime code).
 *
 * TMDB is an OPTIONAL visual enrichment source. These shapes contain ONLY
 * `tmdbId` - deliberately NO `id`, NO `anilistId`, NO `malId`. A TMDB ID never
 * becomes an AniList ID or MAL ID; identity is never established by TMDB.
 *
 * @typedef {Object} TmdbCandidate
 * @property {number} tmdbId
 * @property {'tv'|'movie'} mediaType
 * @property {string|null} title         Display title (name/title).
 * @property {string|null} originalTitle Original-language title.
 * @property {number|null} year          First-air/release year.
 * @property {number|null} popularity    Tie-breaker signal ONLY - never
 *   identity proof.
 * @property {{ poster: string|null, backdrop: string|null }} images
 */

/**
 * A TMDB season (from TV details metadata), used for tmdbSeasonNumber
 * derivation and season-level artwork.
 *
 * @typedef {Object} TmdbSeason
 * @property {number} seasonNumber      TMDB season number (0 = specials).
 * @property {string|null} name         Season display name.
 * @property {string|null} airDate      Season air date ("YYYY-MM-DD").
 * @property {string|null} posterPath   Actual TMDB season poster path.
 * @property {string|null} poster       Season poster URL (w500), built ONLY
 *                                      from the actual poster path.
 * @property {number|null} episodeCount Season episode count.
 */

/**
 * The visual enrichment result produced by the TMDB service.
 *
 * @typedef {Object} TmdbVisualResult
 * @property {boolean} resolved          False = valid unresolved enrichment
 *   (no confident match / TMDB unavailable) - never a provider failure.
 * @property {number|null} tmdbId        Matched TMDB series/movie ID. Multiple
 *   AniList season entries MAY legitimately resolve to the same tmdbId (one
 *   TMDB series holds several AniList seasons).
 * @property {'tv'|'movie'|null} mediaType
 * @property {{ backdrop: string|null, banner: string|null } | null} images
 *   Backdrop/banner are built ONLY from actual TMDB backdrop paths.
 * @property {string|null} poster        Built only from the actual poster path.
 * @property {number|null} tmdbSeasonNumber  The TMDB season corresponding to
 *   the AniList entry, ONLY when confidently derived from title/year evidence
 *   validated against TMDB season metadata (null = series-level match, season
 *   unresolved - never guessed).
 * @property {TmdbSeason | null} season  Metadata of the matched season.
 * @property {string | null} matchedTitle    The TMDB title that matched.
 * @property {'title'|'title_base'|null} matchStrategy  How the title matched
 *   ('title' = full equality; 'title_base' = season-stripped equality).
 * @property {string | null} reason      Why unresolved (resolved: null).
 */

/**
 * A TMDB logo (title logo artwork). URLs are built ONLY from the actual
 * `file_path` via the centralized image-URL helper - never fabricated.
 *
 * @typedef {Object} TmdbLogo
 * @property {string} path             Actual TMDB file path ("/abc.png").
 * @property {string} url              Usable logo URL (w500 - lightweight).
 * @property {string} urlOriginal      Full-resolution logo URL ("original").
 * @property {string|null} language    ISO 639-1 language of the logo (null =
 *                                     languageless/textless artwork).
 * @property {string|null} extension   File extension ("png", "svg", ...).
 * @property {number|null} voteAverage TMDB community rating for the image.
 */

/**
 * A TMDB backdrop (landscape artwork). URLs are built ONLY from the actual
 * `file_path` - never a stretched poster, never fabricated.
 *
 * @typedef {Object} TmdbBackdrop
 * @property {string} path             Actual TMDB file path.
 * @property {string} url              High-quality hero-size URL (w1280).
 * @property {string} urlOriginal      Full-resolution URL ("original").
 * @property {number|null} width       Intrinsic pixel width.
 * @property {number|null} height      Intrinsic pixel height.
 * @property {string|null} language    ISO 639-1 language (null common).
 * @property {number|null} voteAverage TMDB community rating for the image.
 */

/**
 * A TMDB video (trailer/teaser metadata). `url`/`embedUrl` are built ONLY for
 * YouTube keys via the documented URL scheme - never invented for other sites.
 *
 * @typedef {Object} TmdbVideo
 * @property {string} name             Video title.
 * @property {string} key              Provider video key (e.g. YouTube id).
 * @property {string} site             Video provider ("YouTube", ...).
 * @property {string} type             Video type ("Trailer", "Teaser", ...).
 * @property {boolean|null} official   TMDB official flag when provided.
 * @property {string|null} publishedAt ISO publish timestamp when provided.
 * @property {string|null} url         Watch URL (YouTube only, else null).
 * @property {string|null} embedUrl    Embed URL (YouTube only, else null).
 */

/**
 * The cached TMDB media-asset result for one resolved TMDB entry (per-tmdbId,
 * mediaType-namespaced). `complete: false` means an upstream images/videos leg
 * failed - the successful legs are still returned, and the result is cached
 * with a conservative short TTL (never presented as fully fresh data).
 *
 * @typedef {Object} TmdbMediaAssets
 * @property {boolean} complete        True only when both upstream legs succeeded.
 * @property {number} tmdbId
 * @property {'tv'|'movie'} mediaType
 * @property {TmdbLogo | null} logo    Best logo, or null when none available.
 * @property {TmdbBackdrop[]} backdrops  Ranked, dimension-annotated backdrops.
 * @property {TmdbVideo | null} trailer  Best official trailer, or null.
 * @property {TmdbVideo[]} videos      Bounded candidate trailers/teasers.
 * @property {string|null} reason      Which upstream legs are unavailable.
 */

export {};
