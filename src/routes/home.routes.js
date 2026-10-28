/**
 * Home / discovery feed routes (LIVE since Phase 7).
 *
 *   GET /api/home      -> aggregated homepage feed (AniList-backed sections
 *                         + derived Top 10 collection).
 *   GET /api/schedule  -> airing schedule (AniList).
 */

import { Router } from 'express';
import { homeController } from '../controllers/home.controller.js';
import { scheduleController } from '../controllers/schedule.controller.js';

const router = Router();

router.get('/home', homeController);
router.get('/schedule', scheduleController);

export default router;
