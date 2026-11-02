/**
 * Continue Watching routes (account-backed, persistent playback progress).
 *
 *   POST   /api/user/continue-watching             save/update progress (upsert)
 *   GET    /api/user/continue-watching             list (newest watch first)
 *   DELETE /api/user/continue-watching/:anilistId  remove an entry (AniList ID)
 *
 * POLICY:
 *   - ALL operations require a VERIFIED user session (requireUser: access
 *     token via `Authorization: Bearer` or session cookie, verified upstream
 *     with Supabase Auth). Identity comes ONLY from the verified session -
 *     exactly like /api/watchlist, so both user-data sets are fetched with
 *     the SAME session after login.
 *   - These routes also sit behind the central API-key middleware (like all
 *     protected /api routes): the trusted server-side proxy adds X-API-Key.
 *   - State-changing requests that arrived with a session COOKIE are guarded
 *     by the CSRF origin check (same policy as /api/auth/* and watchlist).
 *   - Query-parameter API keys are NOT accepted here (POST/DELETE, and this
 *     is user data - never a manual browser-testing endpoint).
 */

import { Router } from 'express';

import {
  continueWatchingListController,
  continueWatchingSaveController,
  continueWatchingRemoveController,
} from '../controllers/continue-watching.controller.js';
import { requireUser, csrfOriginGuard } from '../middleware/session.js';

const router = Router();

router.get('/user/continue-watching', requireUser(), continueWatchingListController);
router.post('/user/continue-watching', requireUser(), csrfOriginGuard(), continueWatchingSaveController);
router.delete('/user/continue-watching/:anilistId', requireUser(), csrfOriginGuard(), continueWatchingRemoveController);

export default router;
