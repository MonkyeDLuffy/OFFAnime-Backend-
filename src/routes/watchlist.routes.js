/**
 * Watchlist routes (account-backed, persistent).
 *
 *   GET    /api/watchlist            authenticated user's watchlist
 *   POST   /api/watchlist            add an anime (AniList ID)
 *   DELETE /api/watchlist/:animeId   remove an anime (AniList ID)
 *
 * POLICY:
 *   - ALL operations require a VERIFIED user session (requireUser: access
 *     token via `Authorization: Bearer` or session cookie, verified upstream
 *     with Supabase Auth). Identity comes ONLY from the verified session.
 *   - These routes also sit behind the central API-key middleware (like all
 *     protected /api routes): the trusted server-side proxy adds X-API-Key.
 *   - State-changing requests that arrived with a session COOKIE are guarded
 *     by the CSRF origin check (same policy as /api/auth/*).
 *   - Query-parameter API keys are NOT accepted here (POST/DELETE, and this
 *     is user data - never a manual browser-testing endpoint).
 */

import { Router } from 'express';

import {
  watchlistListController,
  watchlistAddController,
  watchlistRemoveController,
} from '../controllers/watchlist.controller.js';
import { requireUser, csrfOriginGuard } from '../middleware/session.js';

const router = Router();

router.get('/watchlist', requireUser(), watchlistListController);
router.post('/watchlist', requireUser(), csrfOriginGuard(), watchlistAddController);
router.delete('/watchlist/:animeId', requireUser(), csrfOriginGuard(), watchlistRemoveController);

export default router;
