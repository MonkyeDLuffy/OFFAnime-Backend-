/**
 * ID types & pure identity helpers.
 *
 * THE critical invariant of this backend: AniList IDs and MyAnimeList (MAL) IDs
 * live in separate namespaces and must NEVER be silently reinterpreted as one
 * another. This module contains only pure, side-effect-free helpers for
 * validating IDs and constructing a normalized identity object. Any lookup that
 * requires a network call (AniList <-> MAL mapping) lives in identity-resolver.js.
 *
 * Normalized identity shape used across the backend:
 *   { id, anilistId, malId }
 * where `id` mirrors `anilistId` (AniList is the primary identity). When a MAL
 * ID is unknown, `malId` is null - it is never guessed or back-filled from the
 * AniList ID.
 */

import { ID_TYPES } from '../config/constants.js';
import { ValidationError } from '../errors/index.js';

export { ID_TYPES };

/**
 * Coerce an input into a positive integer ID, or return null if it is not a
 * valid ID. Accepts numbers and numeric strings; rejects everything else.
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Parse a required ID from untrusted input (e.g. a route param), throwing a
 * ValidationError when it is missing/invalid.
 * @param {unknown} value
 * @param {string} [label='id'] Used in the error message.
 * @returns {number}
 */
export function parseRequiredId(value, label = 'id') {
  const id = normalizeId(value);
  if (id === null) {
    throw new ValidationError(`Invalid ${label}: expected a positive integer`, { received: value });
  }
  return id;
}

/**
 * @typedef {Object} AnimeIdentity
 * @property {number | null} id        Primary id (mirrors anilistId).
 * @property {number | null} anilistId AniList ID, or null if unknown.
 * @property {number | null} malId     MyAnimeList ID, or null if unknown.
 */

/**
 * Build a normalized identity object WITHOUT guessing. At least one of the two
 * IDs must be provided. `id` mirrors the AniList ID (primary identity); it is
 * never populated from a MAL ID.
 *
 * @param {{ anilistId?: unknown, malId?: unknown }} input
 * @returns {AnimeIdentity}
 */
export function createAnimeIdentity({ anilistId, malId } = {}) {
  const normalizedAnilist = normalizeId(anilistId);
  const normalizedMal = normalizeId(malId);

  if (normalizedAnilist === null && normalizedMal === null) {
    throw new ValidationError('Cannot build an anime identity without an AniList ID or a MAL ID');
  }

  return {
    id: normalizedAnilist, // AniList is the primary identity; never a MAL ID.
    anilistId: normalizedAnilist,
    malId: normalizedMal,
  };
}

// --- identity result types (Phase 4) -----------------------------------------

/**
 * @typedef {'anilist'|'mal'} IdentityType
 * Restricted to the two ID namespaces handled by the identity layer. No other
 * provider types belong here in this phase.
 */

/**
 * @typedef {Object} IdentityResult
 * @property {number | null} anilistId  AniList ID (null only for malformed
 *   input paths; resolver results always carry one when resolvable).
 * @property {number | null} malId      MAL ID, or null when unresolved.
 * @property {'anilist' | null} source  Which provider relationship established
 *   the mapping; null when unresolved.
 * @property {'provider' | null} confidence  Always 'provider' when resolved -
 *   mappings only come from trusted provider fields, never from guesses.
 * @property {boolean} resolved         False means genuinely unresolved.
 */

/**
 * Validate an identity-type input for the generic resolver. Only 'anilist' and
 * 'mal' are accepted - the namespace must always be explicit.
 * @param {unknown} type
 * @returns {IdentityType}
 * @throws {ValidationError} for unknown/missing types.
 */
export function parseIdentityType(type) {
  if (type !== ID_TYPES.ANILIST && type !== ID_TYPES.MAL) {
    throw new ValidationError(
      'Unknown identity type: expected "anilist" or "mal" (a bare number is ambiguous and not accepted)',
      { received: type },
    );
  }
  return type;
}

/**
 * Build an explicit, normalized IdentityResult WITHOUT guessing.
 * - AniList ID and MAL ID remain separate namespaces; neither is derived from
 *   the other, and equal numeric values are not treated as evidence of a
 *   relationship (namespace determines meaning, not numeric equality).
 * - `resolved` is true only when an actual mapping exists (both IDs present).
 * - Unresolved results carry source/confidence null - never a guessed mapping.
 *
 * @param {{ anilistId?: unknown, malId?: unknown }} input
 * @returns {IdentityResult}
 * @throws {ValidationError} when neither ID is present.
 */
export function createIdentityResult({ anilistId, malId } = {}) {
  const normalizedAnilist = normalizeId(anilistId);
  const normalizedMal = normalizeId(malId);

  if (normalizedAnilist === null && normalizedMal === null) {
    throw new ValidationError('Cannot build an identity result without an AniList ID or a MAL ID');
  }

  const resolved = normalizedMal !== null && normalizedAnilist !== null;
  return {
    anilistId: normalizedAnilist,
    malId: normalizedMal,
    source: resolved ? 'anilist' : null,
    confidence: resolved ? 'provider' : null,
    resolved,
  };
}
