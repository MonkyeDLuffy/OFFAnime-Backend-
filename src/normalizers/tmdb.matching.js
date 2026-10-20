/**
 * TMDB matching - deterministic, conservative matching between an already-known
 * anime (trusted AniList/Jikan metadata) and TMDB search candidates.
 *
 * Core rule: TMDB search results are ENRICHMENT CANDIDATES, not identity
 * authority. A candidate is selected only when it confidently matches:
 *
 *   1. Title match is REQUIRED (normalized comparison across candidate title
 *      variants vs. known AniList/Jikan titles). Comparison operates on BOTH
 *      full titles AND season-stripped base titles, because AniList models
 *      sequels as separate entries ("... 2", "... 2nd Season", "... II") that
 *      share ONE TMDB TV series. Full-title matches are preferred over
 *      base-title matches.
 *   2. Year compatibility is media-type aware:
 *        - movie: known-vs-known years must be within +/-1 (a movie IS the
 *          entry; its release year must align).
 *        - tv: the candidate series must not have premiered AFTER the entry
 *          aired by more than a 1-year buffer. A later season legitimately
 *          airs years after its series premiere (AniList 2019 sequel entry ->
 *          TMDB series premiered 2015); an OLDER entry must never resolve to
 *          a series that premiered after it (1999 entry -> 2011 reboot).
 *   3. Media type compatibility (tv vs movie).
 *   4. Ranking: title tier (full > base), then title priority, then year
 *      proximity (distinguishes same-name reboots), then popularity. Year and
 *      popularity are never identity proof on their own.
 *
 * No aggressive fuzzy matching, no "similar enough" acceptance, no unbounded
 * loops. If no candidate confidently matches, the result is null - the caller
 * reports valid unresolved enrichment. A missing banner is better than a
 * banner belonging to the wrong anime.
 */

/** @typedef {import('./tmdb.types.js').TmdbCandidate} TmdbCandidate */
/** @typedef {import('./tmdb.types.js').TmdbSeason} TmdbSeason */

/**
 * How a candidate's title matched the known titles.
 *   - 'title':      full normalized title equality (strongest evidence).
 *   - 'title_base': equality after stripping season/sequel suffixes (the
 *                   entry is a season of the matched series).
 * @typedef {'title' | 'title_base'} TmdbMatchStrategy
 */

/**
 * A selected candidate plus how it matched.
 * @typedef {Object} TmdbMatch
 * @property {TmdbCandidate} candidate
 * @property {TmdbMatchStrategy} strategy
 */

/**
 * Season-suffix strip patterns (one trailing suffix per application). Ordered
 * from most specific to least; applied repeatedly (max 3 rounds) so chains
 * like "The Final Season Part 2" fully reduce to the franchise base title.
 */
const SEASON_SUFFIX_STRIP_PATTERNS = [
  /(?:[-–—:]\s*)?(?:the\s+)?final\s+season$/i,
  /(?:[-–—:]|\s)\s*the\s+final$/i,
  /(?:[-–—:]\s*)?\d{1,2}(?:st|nd|rd|th)\s+season$/i,
  /(?:[-–—:]\s*)?season\s+\d{1,2}$/i,
  /(?:[-–—:]\s*)?(?:second|third|fourth|fifth)\s+season$/i,
  /(?:[-–—:]\s*)?part\s+\d{1,2}$/i,
  /\s(?:XV|XIV|XIII|XII|XI|IX|VIII|VII|VI|IV|III|II|X|V)$/i,
  /\s\d{1,2}$/,
];

/**
 * Season-number extraction patterns (evidence for tmdbSeasonNumber). Ordered:
 * the first match on a title wins (e.g. "Season 2 Part 1" -> 2).
 */
const SEASON_NUMBER_PATTERNS = [
  /(\d{1,2})(?:st|nd|rd|th)\s+season/i,
  /season\s+(\d{1,2})/i,
  /(?:^|\s)part\s+(\d{1,2})(?:$|[\s:–—-])/i,
  /\s(XV|XIV|XIII|XII|XI|IX|VIII|VII|VI|IV|III|II|X|V)$/i,
  /\s(\d{1,2})$/,
];

/** Roman-numeral sequel suffix -> season number. */
const ROMAN_SEASON_NUMBERS = {
  II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9,
  X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15,
};

/**
 * Normalize a title for comparison (NOT for identity - only for matching):
 * trim, case-fold, collapse whitespace, remove harmless punctuation
 * differences, and strip trailing sequel punctuation ("...?", "...!",
 * "...!!" - sequels are often distinguished only by these, e.g.
 * "Kaguya-sama: Love is War?"). Deliberately NOT aggressive fuzzy matching
 * (no similarity scores, no edit distance) so unrelated anime can never
 * accidentally match.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTitleForComparison(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/['’`]/g, '') // apostrophe variants are harmless differences
    // Punctuation -> space, PRESERVING unicode letters/digits (CJK titles
    // like ワンパンマン must remain matchable).
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Trailing sequel punctuation ("love is war !" -> "love is war").
    .replace(/[!？?！]+$/u, '')
    .trim();
}

/**
 * Strip ONE trailing season/sequel suffix from a title ("... 2nd Season",
 * "... Season 2", "... II", "... Part 2", "... The Final"). Returns the
 * trimmed remainder, or the original title when nothing (safely) strips.
 * A remainder is required - a suffix is never allowed to consume the whole
 * title (guard: the anime "86" stays "86").
 * @param {unknown} value
 * @returns {string}
 */
export function stripSeasonSuffix(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  for (const pattern of SEASON_SUFFIX_STRIP_PATTERNS) {
    const stripped = trimmed.replace(pattern, '').trim();
    if (stripped !== '' && stripped !== trimmed) return stripped;
  }
  return trimmed;
}

/**
 * Fully reduce a title to its franchise base (up to 3 strip rounds, e.g.
 * "Attack on Titan The Final Season Part 2" -> "Attack on Titan").
 * @param {unknown} value
 * @returns {string}
 */
export function stripSeasonSuffixDeep(value) {
  let current = stripSeasonSuffix(value);
  for (let round = 0; round < 2; round += 1) {
    const next = stripSeasonSuffix(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Extract a SEASON NUMBER as title evidence ("... 2", "... 2nd Season",
 * "... Season 2", "... II", "... Part 2"). Returns null when the title carries
 * no season evidence. The number is EVIDENCE for tmdbSeasonNumber - always
 * validated against TMDB season metadata before being reported.
 * @param {unknown} value
 * @returns {number | null}
 */
export function extractTitleSeasonNumber(value) {
  if (typeof value !== 'string') return null;
  for (const pattern of SEASON_NUMBER_PATTERNS) {
    const match = value.match(pattern);
    if (!match) continue;
    if (pattern.source.startsWith('\\s(X')) {
      const roman = ROMAN_SEASON_NUMBERS[match[1].toUpperCase()];
      return roman ?? null;
    }
    const n = Number(match[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Derive the TMDB season number for an AniList entry from layered evidence.
 * AniList entry numbering is NOT assumed to equal TMDB season numbering:
 *
 *   1. Title evidence (e.g. "2nd Season", "Season 2", "II") is validated
 *      against TMDB season metadata: the season must exist and its air year
 *      must be compatible with the entry's year (unknown air years never
 *      disqualify).
 *   2. Year evidence: the season whose TMDB air year is closest to the
 *      entry's air year wins when uniquely closest within +/-1 (this corrects
 *      cours splits like "The Final Season Part 2" -> TMDB season 4). A tie
 *      defers to season 1 only when the entry year aligns with the series
 *      premiere; otherwise the season stays unresolved (honest null).
 *
 * @param {object} input
 * @param {TmdbSeason[] | unknown[]} [input.seasons] Normalized TMDB seasons.
 * @param {number | null} [input.titleSeasonNumber] Season number extracted
 *   from the entry's titles (null = no title evidence).
 * @param {number | null} [input.entryYear] AniList entry seasonYear.
 * @param {number | null} [input.seriesStartYear] TMDB series first-air year.
 * @returns {number | null}
 */
export function deriveTmdbSeasonNumber({ seasons, titleSeasonNumber = null, entryYear = null, seriesStartYear = null } = {}) {
  const numbered = (Array.isArray(seasons) ? seasons : [])
    .filter((s) => s && Number.isInteger(s.seasonNumber) && s.seasonNumber >= 1);
  if (numbered.length === 0) return null;

  // 1. Title evidence, validated against TMDB season metadata.
  if (titleSeasonNumber !== null) {
    const byTitle = numbered.find((s) => s.seasonNumber === titleSeasonNumber);
    if (byTitle) {
      const airYear = extractSeasonAirYear(byTitle.airDate);
      if (airYear === null || entryYear === null || Math.abs(airYear - entryYear) <= 1) {
        return titleSeasonNumber;
      }
    }
  }

  // 2. Year evidence: uniquely closest season air year wins.
  if (entryYear === null) return null;
  const scored = numbered
    .map((s) => ({ seasonNumber: s.seasonNumber, airYear: extractSeasonAirYear(s.airDate) }))
    .filter((s) => s.airYear !== null)
    .map((s) => ({ seasonNumber: s.seasonNumber, diff: Math.abs(s.airYear - entryYear) }))
    .sort((a, b) => a.diff - b.diff || a.seasonNumber - b.seasonNumber);
  if (scored.length === 0 || scored[0].diff > 1) return null;

  const best = scored[0];
  const tied = scored.filter((s) => s.diff === best.diff);
  if (tied.length === 1) return best.seasonNumber;
  // Tie (e.g. two cours airing the same year): only season 1 wins when the
  // entry year aligns with the series premiere.
  if (
    seriesStartYear !== null &&
    Math.abs(seriesStartYear - entryYear) <= 1 &&
    tied.some((s) => s.seasonNumber === 1)
  ) {
    return 1;
  }
  return null;
}

/** Year from a TMDB season air date ("YYYY-MM-DD"). */
function extractSeasonAirYear(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) && year > 0 ? year : null;
}

/**
 * Extract the known-title priority list from trusted metadata (AniList first,
 * then Jikan). Order: AniList userPreferred, English, Romaji, Native, AniList
 * synonyms; then Jikan English, Japanese, synonyms. Deduplicated, empties
 * removed.
 * @param {{ title?: unknown, synonyms?: unknown, enrichment?: unknown }} canonical
 * @returns {string[]}
 */
export function extractKnownTitles(canonical) {
  const title = canonical?.title && typeof canonical.title === 'object' ? canonical.title : {};
  const anilistSynonyms = Array.isArray(canonical?.synonyms) ? canonical.synonyms : [];
  const jikan = canonical?.enrichment?.jikan?.title && typeof canonical.enrichment.jikan.title === 'object'
    ? canonical.enrichment.jikan.title
    : {};

  const candidates = [
    title.userPreferred,
    title.english,
    title.romaji,
    title.native,
    ...anilistSynonyms,
    jikan.english,
    jikan.japanese,
    ...(Array.isArray(jikan.synonyms) ? jikan.synonyms : []),
  ];

  const seen = new Set();
  const result = [];
  for (const value of candidates) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const key = normalizeTitleForComparison(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value.trim());
  }
  return result;
}

/**
 * Deduplicate titles by their normalized comparison form (order-preserving).
 * @param {string[]} titles
 * @returns {string[]}
 */
function dedupeNormalized(titles) {
  const seen = new Set();
  const result = [];
  for (const title of titles) {
    const normalized = normalizeTitleForComparison(title);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(title);
  }
  return result;
}

/**
 * Select the best-matching TMDB candidate using the conservative strategy.
 *
 * Title comparison runs on BOTH full titles and season-stripped base titles
 * (AniList sequel entries share one TMDB series). Candidates are ranked by:
 *
 *   tier 0 - full-title match (any variant)      [strongest]
 *   tier 1 - base-title match CORROBORATED by a second title variant (e.g.
 *            the candidate's originalTitle also matches the known native
 *            title - distinguishes the true franchise series from unrelated
 *            same-named series in other languages)
 *   tier 2 - base-title match on a single variant
 *
 * Year rules are media-type aware (movies: +/-1; TV: a candidate must not
 * premiere after the entry aired by more than a 1-year buffer - later seasons
 * legitimately air years later). Within a tier: known-title priority, then
 * year proximity (distinguishes same-name reboots), then popularity.
 *
 * @param {TmdbCandidate[]} candidates
 * @param {object} trusted
 * @param {string[]} trusted.titles Known titles in priority order (from
 *   extractKnownTitles).
 * @param {number|null} [trusted.year] Trusted entry year (AniList seasonYear).
 * @param {'tv'|'movie'|null} [trusted.mediaType] Trusted media type when known.
 * @returns {TmdbMatch | null} The selected candidate + match strategy, or null
 *   when no candidate confidently matches (never forces a result).
 */
export function selectBestMatch(candidates, { titles, year = null, mediaType = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (!Array.isArray(titles) || titles.length === 0) return null;

  // Known titles: full forms (priority order) + season-stripped base forms.
  const knownFull = dedupeNormalized(titles).map((t) => t.trim());
  if (knownFull.length === 0) return null;
  const knownFullNormalized = knownFull.map((t) => normalizeTitleForComparison(t));
  const knownBaseNormalized = [];
  {
    const seen = new Set(knownFullNormalized);
    for (const title of knownFull) {
      const base = normalizeTitleForComparison(stripSeasonSuffixDeep(title));
      if (base && !seen.has(base)) {
        seen.add(base);
        knownBaseNormalized.push(base);
      }
    }
  }

  /** Lexicographic ascending comparison of two score tuples. */
  const beats = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };

  /** @type {TmdbMatch | null} */
  let best = null;
  let bestScore = null;

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    // 3. Media type compatibility.
    if (mediaType && candidate.mediaType && candidate.mediaType !== mediaType) {
      continue;
    }

    // Candidate title variants (per actual title field): full + stripped base.
    const variants = [candidate.title, candidate.originalTitle]
      .filter((t) => typeof t === 'string' && t.trim() !== '')
      .map((title) => {
        const full = normalizeTitleForComparison(title);
        const base = normalizeTitleForComparison(stripSeasonSuffixDeep(title));
        return { full, base };
      })
      .filter((v) => v.full !== '');
    if (variants.length === 0) continue;

    // 1. Title match (REQUIRED). Collect each variant's best hit.
    /** @type {{ tier: number, rank: number, corroborated: boolean } | null} */
    let titleScore = null;
    let matchedVariants = 0;
    for (const variant of variants) {
      let hit = null;
      const fullIdx = knownFullNormalized.indexOf(variant.full);
      if (fullIdx !== -1) hit = { tier: 0, rank: fullIdx };
      if (hit === null) {
        const baseAsKnownBase = knownBaseNormalized.indexOf(variant.base);
        const fullAsKnownBase = knownBaseNormalized.indexOf(variant.full);
        const baseAsKnownFull = knownFullNormalized.indexOf(variant.base);
        const baseHits = [
          baseAsKnownBase !== -1 && { tier: 2, rank: baseAsKnownBase },
          fullAsKnownBase !== -1 && { tier: 2, rank: fullAsKnownBase },
          baseAsKnownFull !== -1 && { tier: 2, rank: baseAsKnownFull },
        ].filter(Boolean);
        if (baseHits.length > 0) {
          hit = baseHits.reduce((a, b) => (b.rank < a.rank ? b : a));
        }
      }
      if (hit !== null) {
        matchedVariants += 1;
        if (titleScore === null || beats([hit.tier, hit.rank], [titleScore.tier, titleScore.rank])) {
          titleScore = { ...hit, corroborated: false };
        }
      }
    }
    if (titleScore === null) continue; // wrong title -> rejected, no acceptance

    // Corroboration: a SECOND independent title variant also matched. This
    // promotes a single-variant base match (tier 2) to a corroborated base
    // match (tier 1) - separating the true franchise series (latin title AND
    // Japanese original title both agree) from unrelated same-named series.
    if (matchedVariants >= 2 && titleScore.tier === 2) {
      titleScore.tier = 1;
    }

    // 2. Year compatibility (media-type aware; unknown years never disqualify).
    if (year !== null && candidate.year !== null) {
      if (mediaType === 'movie') {
        if (Math.abs(candidate.year - year) > 1) continue; // movie year must align
      } else if (candidate.year > year + 1) {
        // A TV series premiering AFTER the entry aired cannot be its match
        // (an older entry must never resolve to a later reboot/series).
        continue;
      }
    }

    // 4. Selection: title tier, then priority, then year proximity
    //    (distinguishes same-name reboots), then popularity as tie-breaker.
    const proximity = year !== null && candidate.year !== null
      ? Math.abs(candidate.year - year)
      : Number.POSITIVE_INFINITY;
    const score = [titleScore.tier, titleScore.rank, proximity, -(candidate.popularity ?? 0)];
    if (bestScore === null || beats(score, bestScore)) {
      best = {
        candidate,
        strategy: titleScore.tier === 0 ? 'title' : 'title_base',
      };
      bestScore = score;
    }
  }

  return best;
}
