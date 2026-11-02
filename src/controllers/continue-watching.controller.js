/**
 * Continue Watching controllers (thin HTTP glue over continue-watching.service).
 *
 *   POST   /api/user/continue-watching             save/update progress (upsert)
 *   GET    /api/user/continue-watching             list (newest watch first)
 *   DELETE /api/user/continue-watching/:anilistId  remove (idempotent)
 *
 * SECURITY:
 *   - requireUser() (route level) verifies the session UPSTREAM and attaches
 *     req.user (safe shape) + req.accessToken (raw verified token for the
 *     RLS-forwarded PostgREST call).
 *   - The user id used for storage ALWAYS comes from req.user.id; any userId
 *     present in the request body/query is ignored entirely.
 *   - :anilistId is an AniList ID (the canonical anime identity), validated
 *     by the service via the shared identity layer.
 *
 * RESPONSE SHAPES (frontend contract):
 *   save   200 { saved: true, entry: { anilistId, episode, progress?, updatedAt } }
 *   list   200 { items: [{ anilistId, episode, progress?, updatedAt }], count }
 *   remove 200 { ok: true, anilistId }
 */

import { asyncHandler } from '../utils/async-handler.js';
import {
  listContinueWatching,
  saveContinueWatching,
  removeContinueWatching,
} from '../services/continue-watching.service.js';

/**
 * GET /api/user/continue-watching
 * @type {import('express').RequestHandler}
 */
export const continueWatchingListController = asyncHandler(async (req, res) => {
  res.status(200).json(await listContinueWatching({
    userId: req.user.id,
    accessToken: req.accessToken,
  }));
});

/**
 * POST /api/user/continue-watching - saves/updates progress. The upsert
 * targets (verified user, anilistId): a repeat save UPDATES the existing row
 * instead of creating a duplicate.
 * Request body: { anilistId, episode, progress? }  (progress optional)
 * @type {import('express').RequestHandler}
 */
export const continueWatchingSaveController = asyncHandler(async (req, res) => {
  const result = await saveContinueWatching({
    userId: req.user.id,
    accessToken: req.accessToken,
    input: req.body,
  });
  res.status(200).json(result);
});

/**
 * DELETE /api/user/continue-watching/:anilistId - idempotent (removing an
 * absent entry is still a success). Only affects Continue Watching, never
 * the user's watchlist.
 * @type {import('express').RequestHandler}
 */
export const continueWatchingRemoveController = asyncHandler(async (req, res) => {
  const { anilistId } = await removeContinueWatching({
    userId: req.user.id,
    accessToken: req.accessToken,
    anilistId: req.params.anilistId,
  });
  res.status(200).json({ ok: true, anilistId });
});
