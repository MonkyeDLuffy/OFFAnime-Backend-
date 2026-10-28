/**
 * Health route.
 *
 *   GET /api/health  -> liveness/readiness probe.
 *
 * This is the only functional route in Phase 1. It confirms the process is up
 * and able to serve requests; it performs NO provider or cache calls so it
 * stays fast and cannot be broken by an upstream outage.
 */

import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';

const router = Router();

router.get('/health', healthController);

export default router;
