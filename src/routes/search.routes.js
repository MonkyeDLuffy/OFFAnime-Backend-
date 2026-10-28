/**
 * Search routes (LIVE since Phase 7).
 *
 *   GET /api/search      -> anime search (AniList primary; filters validated).
 *   GET /api/top-search  -> popular/trending search suggestions (AniList data).
 */

import { Router } from 'express';
import { searchController, topSearchController } from '../controllers/search.controller.js';

const router = Router();

router.get('/search', searchController);
router.get('/top-search', topSearchController);

export default router;
