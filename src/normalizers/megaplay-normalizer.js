/**
 * MegaPlay response normalizer/parser.
 *
 * RESPONSE-SCHEMA NOTE (known uncertainty): the MegaPlay endpoint PATHS are a
 * documented provider contract, but no formal response JSON schema exists in
 * the repository. ALL response parsing is therefore isolated in THIS module so
 * it can be adjusted to the exact live schema later without touching
 * StreamResolver. Nothing here invents provider fields: only fields that can
 * be reliably identified from the actual response are normalized.
 *
 * Tolerant parsing rules:
 *   - JSON object with recognizable source containers/fields
 *     (`sources`/`source`/`streams`/`servers`/`url`/`file`/`link`...) ->
 *     extract ONLY valid absolute http(s) URLs, de-duplicated, preserving
 *     quality/type metadata when present.
 *   - JSON object with an explicit failure signal (`success: false` or a
 *     truthy `error` string) -> a genuine no-stream result (MAL fallback
 *     allowed; never cached as a successful stream).
 *   - JSON object with empty/absent sources -> genuine no-stream result.
 *   - Plain-text response that IS an absolute http(s) URL -> usable source
 *     (the URL actually returned by MegaPlay).
 *   - HTML error-page response (observed live: HTTP 200 + "Error - MegaPlay"
 *     / "Error Code: 410" for a missing stream) -> genuine no-stream result
 *     (MAL fallback allowed; never a playable stream).
 *   - HTML player-page response (contains actual player markup) -> the
 *     documented MegaPlay endpoint that MegaPlay just served IS the embed
 *     source (the exact URL from the documented contract - never a URL
 *     constructed from title/ids/episode).
 *   - Anything else (malformed/empty/unparseable) -> NOT usable.
 *
 * A result is `usable` ONLY when it contains at least one genuinely usable
 * streaming source. HTTP 200 alone is NEVER success.
 */

const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/** Top-level JSON keys that may contain stream sources (tolerated shapes). */
const SOURCE_CONTAINERS = ['sources', 'source', 'streams', 'stream', 'links', 'link', 'servers', 'url', 'file'];

/** Fields on a source object that may hold the actual stream URL. */
const SOURCE_URL_FIELDS = ['url', 'file', 'link', 'src', 'source'];

/** Fields on a source object that may hold quality metadata. */
const SOURCE_QUALITY_FIELDS = ['quality', 'label', 'resolution'];

/** Fields on a source object that may hold type/mime metadata. */
const SOURCE_TYPE_FIELDS = ['type', 'mimeType', 'mime_type', 'format'];

/** Fields that may hold the episode number the response refers to. */
const EPISODE_FIELDS = ['episode', 'episodeNum', 'episode_num', 'ep', 'number'];

/** Fields that may hold explicit expiry metadata for the stream. */
const EXPIRY_FIELDS = ['expiresAt', 'expires_at', 'expires', 'expiry'];

/**
 * @typedef {Object} MegaplaySource
 * @property {string} url       Absolute http(s) URL actually returned by
 *   MegaPlay (or the documented MegaPlay endpoint for a player-page response).
 * @property {string} [quality] Quality metadata when the response provides it.
 * @property {string} [type]    Type/mime metadata when the response provides it.
 */

/**
 * @typedef {Object} MegaplayStreamResult
 * @property {boolean} usable    True ONLY when a genuinely usable stream exists.
 * @property {MegaplaySource[]} sources  Valid sources ([] when not usable).
 * @property {'no_stream'|'empty'|'malformed'|'not_found'} [reason] Why the
 *   result is not usable (distinguishable from a provider failure).
 * @property {number|null} episode   Episode number from the response, if any.
 * @property {string|null} expiresAt Explicit expiry metadata, if provided.
 */

/** @param {unknown} value @returns {string|null} */
function asHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HTTP_URL_RE.test(trimmed) ? trimmed : null;
}

/** @param {Record<string, unknown>} item @param {string[]} fields */
function firstString(item, fields) {
  for (const f of fields) {
    if (typeof item[f] === 'string' && item[f].trim()) return item[f];
  }
  return null;
}

/** @param {string} text */
function isHtml(text) {
  return /<html[\s>]/i.test(text) || /<!doctype\s+html/i.test(text);
}

/**
 * MegaPlay serves its error pages as HTTP 200 + HTML (observed live: a missing
 * stream file returns a "Error - MegaPlay" page carrying "Error Code: 410").
 * Such a page is a genuine no-stream result - never a usable embed source.
 * @param {string} text
 */
function isMegaPlayErrorPage(text) {
  return /error\s*-\s*megaplay/i.test(text) || /error\s*code\s*:/i.test(text);
}

/**
 * Whether an HTML page actually contains player markup (a page that renders a
 * stream). Only a real player page may be exposed as an embed source; error
 * pages and unrelated HTML must never be treated as playable streams.
 * @param {string} text
 */
function isPlayerPage(text) {
  return (
    /<\s*(video|iframe|embed|object|source|audio)\b/i.test(text) ||
    /id\s*=\s*["']?player/i.test(text) ||
    /class\s*=\s*["'][^"']*\bplayer\b/i.test(text) ||
    /\.(m3u8|mp4)\b/i.test(text)
  );
}

/**
 * Extract a single valid source from an arbitrary container item, excluding
 * any item without a valid URL (never fabricated).
 * @param {unknown} item
 * @returns {MegaplaySource | null}
 */
function extractSource(item) {
  const stringUrl = asHttpUrl(item);
  if (stringUrl) return { url: stringUrl };
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = /** @type {Record<string, unknown>} */ (item);
  for (const field of SOURCE_URL_FIELDS) {
    const url = asHttpUrl(record[field]);
    if (url) {
      /** @type {MegaplaySource} */
      const source = { url };
      const quality = firstString(record, SOURCE_QUALITY_FIELDS);
      const type = firstString(record, SOURCE_TYPE_FIELDS);
      if (quality) source.quality = quality;
      if (type) source.type = type;
      return source;
    }
  }
  return null;
}

/**
 * Collect all valid sources from a parsed MegaPlay payload, de-duplicated by
 * URL (the same URL is never duplicated unnecessarily).
 * @param {unknown} data
 * @returns {MegaplaySource[]}
 */
function collectSources(data) {
  /** @type {MegaplaySource[]} */
  const out = [];
  const push = (/** @type {MegaplaySource | null} */ source) => {
    if (source && !out.some((existing) => existing.url === source.url)) out.push(source);
  };

  if (Array.isArray(data)) {
    for (const item of data) push(extractSource(item));
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  const record = /** @type {Record<string, unknown>} */ (data);

  for (const key of SOURCE_CONTAINERS) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) push(extractSource(item));
    } else if (value !== null && typeof value === 'object') {
      push(extractSource(value));
    } else {
      push(extractSource(value));
    }
  }
  return out;
}

/**
 * An explicit in-band failure signal in a 200 response (the provider itself
 * says the request produced no result) is a genuine no-stream result.
 * @param {Record<string, unknown>} record
 */
function isExplicitNoStream(record) {
  if (record.success === false) return true;
  return typeof record.error === 'string' && record.error.trim().length > 0;
}

/** @param {Record<string, unknown>} record */
function episodeOf(record) {
  for (const f of EPISODE_FIELDS) {
    const n = Number(record[f]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** @param {Record<string, unknown>} record */
function expiryOf(record) {
  return firstString(record, EXPIRY_FIELDS);
}

/** @param {'no_stream'|'empty'|'malformed'|'not_found'} reason @returns {MegaplayStreamResult} */
function noStream(reason) {
  return { usable: false, sources: [], reason, episode: null, expiresAt: null };
}

/**
 * Normalize a RAW MegaPlay response into a validated stream result.
 *
 * @param {{ data: unknown, url?: string }} [response] Raw payload from the
 *   MegaPlay provider (`data`) plus the exact documented MegaPlay URL used
 *   (`url`, needed to expose a player-page response as its embed source).
 * @returns {MegaplayStreamResult}
 */
export function normalizeMegaplayStreamResponse(response = {}) {
  const { data, url } = response ?? {};
  const requestedUrl = typeof url === 'string' && url ? url : null;

  // Malformed/empty payload: the HTTP client returns null for unparseable
  // JSON bodies. NEVER treated as a usable stream, never cached as one.
  if (data === null || data === undefined) return noStream('malformed');

  // Plain-text response bodies.
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return noStream('empty');
    // The body itself is an absolute URL actually returned by MegaPlay.
    if (HTTP_URL_RE.test(trimmed)) {
      return { usable: true, sources: [{ url: trimmed }], episode: null, expiresAt: null };
    }
    // MegaPlay error page (HTTP 200 + HTML, e.g. "Error Code: 410" for a
    // missing stream file): a genuine no-stream result. The MAL fallback is
    // allowed; never exposed as a playable stream, never cached as one.
    if (isHtml(trimmed) && isMegaPlayErrorPage(trimmed)) {
      return noStream('not_found');
    }
    // HTML player page (contains actual player markup): the documented
    // MegaPlay endpoint MegaPlay just served is the embed source. Only that
    // exact URL (from the documented contract) is exposed - never a
    // constructed/fabricated URL.
    if (isHtml(trimmed) && isPlayerPage(trimmed) && requestedUrl) {
      return {
        usable: true,
        sources: [{ url: requestedUrl, type: 'embed' }],
        episode: null,
        expiresAt: null,
      };
    }
    return noStream('malformed');
  }

  if (typeof data !== 'object') return noStream('malformed');
  const record = /** @type {Record<string, unknown>} */ (data);

  // The provider explicitly says there is no stream (MAL fallback allowed).
  if (isExplicitNoStream(record)) return noStream('no_stream');

  const sources = collectSources(record);
  // e.g. { "success": true, "sources": [] } is NOT a usable stream.
  if (sources.length === 0) return noStream('no_stream');

  return {
    usable: true,
    sources,
    episode: episodeOf(record),
    expiresAt: expiryOf(record),
  };
}

/**
 * Whether a normalized stream result is genuinely usable (and therefore
 * cacheable as a successful stream). Used as the CacheManager `isValid`
 * predicate: anything else (malformed/empty/no-stream) is never cached as a
 * successful stream.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUsableStreamResult(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.usable === true &&
      Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.every(
        (/** @type {any} */ s) => typeof s?.url === 'string' && HTTP_URL_RE.test(s.url),
      ),
  );
}
