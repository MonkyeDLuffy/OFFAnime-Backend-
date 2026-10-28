/**
 * Jikan controllers (thin HTTP glue - no provider logic).
 *   GET /api/jikan/anime/:malId        - Jikan anime details by MAL ID.
 *   GET /api/jikan/from-anilist/:id    - AniList ID -> IdentityResolver -> MAL
 *                                        ID -> Jikan.
 *
 * CRITICAL: `:malId` is a MyAnimeList ID and `:id` is an AniList ID - different
 * namespaces, never conflated. No title-based identity substitution.
 */

import { asyncHandler } from '../utils/async-handler.js';
import { parseRequiredId } from '../identity/id-types.js';
import { identityResolver } from '../identity/identity-resolver.js';
import { NotFoundError } from '../errors/index.js';
import { getAnimeByMalId } from '../services/jikan.service.js';

/**
 * GET /api/jikan/anime/:malId
 * @type {import('express').RequestHandler}
 */
export const jikanAnimeController = asyncHandler(async (req, res) => {
  // Response preserves the Jikan SECONDARY namespace: malId only - never
  // converted into `id`/`anilistId`.
  res.status(200).json(await getAnimeByMalId(parseRequiredId(req.params.malId, 'malId')));
});

/**
 * GET /api/jikan/from-anilist/:id
 * Pipeline: AniList ID -> IdentityResolver -> MAL ID -> Jikan. No Jikan search
 * by title, no fuzzy matching. A missing mapping is a 404 (unresolved) per the
 * existing API error convention.
 * @type {import('express').RequestHandler}
 */
export const jikanFromAnilistController = asyncHandler(async (req, res) => {
  const anilistId = parseRequiredId(req.params.id, 'id');
  const identity = await identityResolver.resolveAniListToMal(anilistId);
  if (!identity.resolved || identity.malId === null) {
    throw new NotFoundError(`No MAL mapping exists for AniList ID ${anilistId}`, {
      anilistId,
      unresolved: true,
    });
  }
  res.status(200).json(await getAnimeByMalId(identity.malId));
});
