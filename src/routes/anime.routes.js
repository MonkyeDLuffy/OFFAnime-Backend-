/**
 * Anime metadata routes (LIVE since Phase 7).
 *
 *   GET /api/details/:id           -> full details pipeline (AniList + Jikan +
 *                                     TMDB, shared composite cache).
 *   GET /api/smart/details/:id     -> same canonical payload (orchestration
 *                                     convenience endpoint; shares the cache).
 *   GET /api/episodes/:id          -> episode METADATA only (no streaming).
 *   GET /api/recommendations/:id   -> AniList recommendations.
 *   GET /api/seasons/:id           -> AniList relations (seasons/sequels).
 *   GET /api/category/:type        -> category listing (validated types).
 *
 * Convention: `:id` is the AniList ID (the primary identity). Any AniList->MAL
 * mapping needed by these endpoints is performed by the identity layer, never
 * by guessing inside the route/controller.
 */

import { Router } from 'express';
import {
  detailsController,
  smartDetailsController,
  episodesController,
  recommendationsController,
  seasonsController,
  categoryController,
} from '../controllers/anime.controller.js';

const router = Router();

router.get('/details/:id', detailsController);
router.get('/smart/details/:id', smartDetailsController);
router.get('/episodes/:id', episodesController);
router.get('/recommendations/:id', recommendationsController);
router.get('/seasons/:id', seasonsController);
router.get('/category/:type', categoryController);

export default router;
