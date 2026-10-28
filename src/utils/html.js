/**
 * Lightweight HTML/text cleaning utilities.
 *
 * Generic infrastructure (not AniList-specific): any provider whose
 * descriptions contain HTML/markup can use these. Deliberately dependency-free
 * - regex-based cleaning is sufficient for descriptions, and a full HTML parser
 * would be an unnecessary dependency for this use case.
 *
 * Cleaning order matters: structural tags are converted/stripped FIRST, then
 * entities are decoded. Decoding after stripping ensures encoded characters
 * (e.g. `<i>`) never reintroduce real tags.
 */

/** Common named HTML entities worth decoding in descriptions. */
const HTML_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
});

/** Convert a code point to a character, or '' if invalid (never throws). */
function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Decode named and numeric HTML entities into their characters.
 * @param {string} text
 * @returns {string}
 */
export function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Remove HTML tags while preserving readable text and line structure.
 * `<br>` and closing block tags become newlines; all other tags are dropped.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

/**
 * Clean a provider description into safe, readable plain text.
 *
 * Handles: HTML tags, HTML entities, and AniList-style spoiler markers
 * (`~!text!~` -> `text`, markers removed, content preserved).
 *
 * Returns null for empty/missing input (never fabricates a description).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function cleanDescription(raw) {
  if (typeof raw !== 'string') return null;

  let text = stripHtml(raw);
  text = decodeHtmlEntities(text);
  // AniList spoiler/strikethrough markers: unwrap, keep the text itself.
  text = text.replace(/~!/g, '').replace(/!~/g, '');
  // Collapse excessive blank lines left by block tags.
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  text = text.trim();

  return text === '' ? null : text;
}
