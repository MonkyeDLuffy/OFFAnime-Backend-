/**
 * Streaming controllers (thin HTTP glue - no provider logic).
 *   GET /api/stream/resolve/:id  - resolve a playable stream for an anime.
 *
 * CRITICAL: `:id` is the AniList ID (canonical identity). It is NEVER assumed
 * to be a MAL ID - numeric equality means nothing. The AniList -> MAL fallback
 * happens inside the StreamResolver through the IdentityResolver, never here.
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
import { parseRequiredId } from '../identity/id-types.js';
import { streamResolver } from '../streaming/stream-resolver.js';

/**
 * GET /api/stream/resolve/:id?ep=1&language=sub   (alias: ?episode=1)
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
