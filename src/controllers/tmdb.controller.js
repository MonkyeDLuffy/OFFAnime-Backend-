/**
 * TMDB controller (thin HTTP glue - no provider logic).
 *   GET /api/tmdb/:id            (default: :id is the AniList ID)
 *   GET /api/tmdb/:id?type=mal   (:id is a MAL ID, resolved to AniList via
 *                                 the IdentityResolver - never guessed)
 *
 * Phase 5 rule respected: TMDB is VISUAL enrichment only. `:id` is NEVER
 * treated as a TMDB ID; TMDB identity is never turned into canonical anime
 * identity. A missing confident match is a 200 with the valid unresolved
 * enrichment representation (never fabricated images/videos).
 *
 * The response keeps the existing visual-enrichment contract and ADDS the
 * complete media assets (logo, backdrops, trailer, videos) when a confident
 * TMDB match exists. Media assets degrade gracefully (null/[]), never failing
 * the response.
 */

import { asyncHandler } from '../utils/async-handler.js';
import { parseRequiredId, parseIdentityType, ID_TYPES } from '../identity/id-types.js';
import { identityResolver } from '../identity/identity-resolver.js';
import { NotFoundError } from '../errors/index.js';
import { getAnimeDetails } from '../services/anime.service.js';
import { enrichWithTmdb, getTmdbMediaResponse } from '../services/tmdb.service.js';

/**
 * Resolve the route param into the canonical AniList ID. `anilist` (default)
 * uses the ID as-is; `mal` resolves through the IdentityResolver (AniList's
 * own id/idMal relationship - no numeric derivation, no title matching).
 * @param {string} rawId
 * @param {'anilist'|'mal'} idType
 * @returns {Promise<number>}
 */
async function resolveCanonicalAnilistId(rawId, idType) {
  const id = parseRequiredId(rawId, 'id');
  if (idType === ID_TYPES.ANILIST) return id;

  const identity = await identityResolver.resolveMalToAniList(id);
  if (!identity.resolved || identity.anilistId === null) {
    throw new NotFoundError(`No AniList anime exists for MAL ID ${id}`, {
      malId: id,
      unresolved: true,
    });
  }
  return identity.anilistId;
}

/**
 * GET /api/tmdb/:id
 * @type {import('express').RequestHandler}
 */
export const tmdbController = asyncHandler(async (req, res) => {
  // Optional explicit ID-type (?type=anilist|mal); a bare number stays
  // unambiguous by defaulting to the canonical AniList namespace.
  const idType = parseIdentityType(req.query.type ?? ID_TYPES.ANILIST);
  const anilistId = await resolveCanonicalAnilistId(req.params.id, idType);
  // AniList-only base (titles for matching; identity untouched).
  const canonical = await getAnimeDetails(anilistId);
  // Visual enrichment result (resolved OR valid unresolved - never a failure
  // response, never fabricated images) + additive media assets.
  const visual = await enrichWithTmdb(canonical);
  res.status(200).json(await getTmdbMediaResponse(visual));
});
