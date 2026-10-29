/**
 * Streaming controllers (thin HTTP glue - no provider logic).
 *   GET /api/stream/resolve/anilist/:id  - resolve by AniList ID.
 *   GET /api/stream/resolve/mal/:id      - resolve by MAL ID.
 *   GET /api/stream/resolve/:id          - legacy; `:id` is ALWAYS an AniList ID.
 *
 * CRITICAL: AniList IDs and MAL IDs are different namespaces. `:id` is
 * interpreted according to the route it arrived on - never silently
 * reinterpreted as the other namespace. Namespace conversion happens only
 * inside the StreamResolver through the IdentityResolver, never here.
 *
 * Query parameters (established contract):
 *   ?ep=1&language=sub  - forwarded to the resolver, which validates them
 *   (positive bounded integer / documented sub|dub values). Unrecognized or
 *   invalid input never reaches the provider.
 *
 * The frontend sends the episode as `ep`; the original documented `episode`
 * alias remains supported for backward compatibility. When both are present,
 * `ep` wins. A SUPPLIED episode is never silently replaced (an absent one
 * still falls back to the documented default of 1 inside the resolver).
 */

import { asyncHandler } from '../utils/async-handler.js';
import { ID_TYPES } from '../config/constants.js';
import { parseRequiredId } from '../identity/id-types.js';
import { streamResolver } from '../streaming/stream-resolver.js';

/**
 * GET /api/stream/resolve/anilist/:id?ep=1&language=sub   (alias: ?episode=1)
 * Legacy GET /api/stream/resolve/:id?ep=1&language=sub also uses this handler.
 * `:id` is the AniList ID (canonical identity - NEVER assumed to be a MAL ID).
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
 * GET /api/stream/resolve/mal/:id?ep=1&language=sub   (alias: ?episode=1)
 * `:id` is the MAL ID (canonical identity for this route - NEVER assumed to be
 * an AniList ID). Resolution is MAL-first with an AniList fallback only when
 * the IdentityResolver confirms a mapping.
 * @type {import('express').RequestHandler}
 */
export const streamResolveMalController = asyncHandler(async (req, res) => {
  res.status(200).json(
    await streamResolver.resolveStream({
      idType: ID_TYPES.MAL,
      id: parseRequiredId(req.params.id, 'id'),
      episode: req.query.ep ?? req.query.episode,
      language: req.query.language,
    }),
  );
});
