/**
 * Watchlist controllers (thin HTTP glue over watchlist.service).
 *
 *   GET    /api/watchlist            list the authenticated user's watchlist
 *   POST   /api/watchlist            add { animeId } (idempotent)
 *   DELETE /api/watchlist/:animeId   remove (idempotent)
 *
 * SECURITY:
 *   - requireUser() (route level) verifies the session UPSTREAM and attaches
 *     req.user (safe shape) + req.accessToken (raw verified token for the
 *     RLS-forwarded PostgREST call).
 *   - The user id used for storage ALWAYS comes from req.user.id; any userId
 *     present in the request body/query is ignored entirely.
 *   - :animeId is an AniList ID (the canonical anime API identity), validated
 *     by the service via the shared identity layer.
 *
 * RESPONSE SHAPES (frontend contract):
 *   GET    200 { items: [{ animeId, addedAt }], count }
 *   POST   201 { added: true,  animeId, addedAt }   (first time)
 *          200 { added: false, animeId, addedAt: null } (already saved)
 *   DELETE 200 { ok: true, animeId }
 */

import { asyncHandler } from '../utils/async-handler.js';
import { listWatchlist, addToWatchlist, removeFromWatchlist } from '../services/watchlist.service.js';

/**
 * GET /api/watchlist
 * @type {import('express').RequestHandler}
 */
export const watchlistListController = asyncHandler(async (req, res) => {
  res.status(200).json(await listWatchlist({
    userId: req.user.id,
    accessToken: req.accessToken,
  }));
});

/**
 * POST /api/watchlist - body: { animeId: <AniList ID> }
 * Idempotent: adding an existing entry returns 200 with added: false.
 * @type {import('express').RequestHandler}
 */
export const watchlistAddController = asyncHandler(async (req, res) => {
  const result = await addToWatchlist({
    userId: req.user.id,
    accessToken: req.accessToken,
    animeId: req.body?.animeId,
  });
  res.status(result.added ? 201 : 200).json(result);
});

/**
 * DELETE /api/watchlist/:animeId - idempotent (removing an absent entry is
 * still a success).
 * @type {import('express').RequestHandler}
 */
export const watchlistRemoveController = asyncHandler(async (req, res) => {
  const { animeId } = await removeFromWatchlist({
    userId: req.user.id,
    accessToken: req.accessToken,
    animeId: req.params.animeId,
  });
  res.status(200).json({ ok: true, animeId });
});
