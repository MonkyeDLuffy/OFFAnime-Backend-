/**
 * Streaming controllers (thin HTTP glue - no provider logic).
 *
 * Three routes, one per streaming server the frontend can select:
 *   GET /api/stream/resolve/anilist/:id  - AniList-PRIMARY (Server 1).
 *   GET /api/stream/resolve/mal/:id      - MAL-PRIMARY (Server 2).
 *   GET /api/stream/resolve/:id          - LEGACY, AniList-primary (unchanged).
 *
 * CRITICAL identity rule: the `:id` parameter of each route belongs to ONE
 * namespace, decided by the ROUTE, never guessed from the value:
 *   - /anilist/:id and legacy /:id -> the id is ALWAYS an AniList ID.
 *   - /mal/:id                     -> the id is ALWAYS a MAL ID.
 * A MAL ID is NEVER reinterpreted as an AniList ID (and vice versa) - numeric
 * equality means nothing. Cross-namespace fallback happens inside the
 * StreamResolver through the IdentityResolver, never here.
 *
 * Query parameters (established contract): ?ep=1&language=sub (the original
 * documented ?episode=1 alias remains supported). Validation happens inside
 * the resolver (positive bounded integer / documented sub|dub values);
 * unrecognized or invalid input never reaches the provider.
 *
 * `ep` takes precedence over `episode` when both are supplied. A SUPPLIED
 * episode is never silently replaced (an absent one still falls back to the
 * documented default of 1 inside the resolver). Controllers forward
 * req.query.ep ?? req.query.episode verbatim - an invalid value is rejected as
 * a typed error, not silently substituted.
 */

import { asyncHandler } from '../utils/async-handler.js';
import { parseRequiredId } from '../identity/id-types.js';
import { streamResolver } from '../streaming/stream-resolver.js';

/**
 * GET /api/stream/resolve/:id?ep=1&language=sub   (alias: ?episode=1)
 * Legacy AniList-primary route: `:id` is ALWAYS an AniList ID.
 * @type {import('express').RequestHandler}
 */
export const streamResolveController = asyncHandler(async (req, res) => {
  res.status(200).json(
    await streamResolver.resolveStream({
      anilistId: parseRequiredId(req.params.id, 'id'),
      episode: req.query.ep ?? req.query.episode,
      language: req.query.language,
    }),
  );
});

/**
 * GET /api/stream/resolve/anilist/:id?ep=1&language=sub   (alias: ?episode=1)
 * AniList-PRIMARY (Server 1): MegaPlay is asked directly with the AniList ID.
 * @type {import('express').RequestHandler}
 */
export const streamResolveAniListController = asyncHandler(async (req, res) => {
  res.status(200).json(
    await streamResolver.resolveStreamByAniListId({
      anilistId: parseRequiredId(req.params.id, 'anilistId'),
      episode: req.query.ep ?? req.query.episode,
      language: req.query.language,
    }),
  );
});

/**
 * GET /api/stream/resolve/mal/:id?ep=1&language=sub   (alias: ?episode=1)
 * MAL-PRIMARY (Server 2): MegaPlay is asked directly with the MAL ID
 * (resolveByMalId). The id is NEVER passed to the AniList lookup; the
 * MAL->AniList fallback resolves the AniList ID through the IdentityResolver.
 * @type {import('express').RequestHandler}
 */
export const streamResolveMalController = asyncHandler(async (req, res) => {
  res.status(200).json(
    await streamResolver.resolveStreamByMalId({
      malId: parseRequiredId(req.params.id, 'malId'),
      episode: req.query.ep ?? req.query.episode,
      language: req.query.language,
    }),
  );
});
