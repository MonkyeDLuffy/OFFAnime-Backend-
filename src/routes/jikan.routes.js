/**
 * Jikan (MyAnimeList) routes (LIVE since Phase 7).
 *
 *   GET /api/jikan/anime/:malId        -> Jikan anime details by MAL ID.
 *   GET /api/jikan/from-anilist/:id    -> details for an AniList ID, resolved
 *                                         to its MAL ID first via the identity
 *                                         layer, then fetched from Jikan.
 *
 * CRITICAL: `:malId` is a MyAnimeList ID and `:id` is an AniList ID. These are
 * different namespaces and must never be conflated (see identity layer).
 */

import { Router } from 'express';
import {
  jikanAnimeController,
  jikanFromAnilistController,
} from '../controllers/jikan.controller.js';

const router = Router();

router.get('/jikan/anime/:malId', jikanAnimeController);
router.get('/jikan/from-anilist/:id', jikanFromAnilistController);

export default router;
