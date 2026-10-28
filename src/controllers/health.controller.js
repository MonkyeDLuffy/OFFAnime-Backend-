/**
 * Health controller.
 *
 * HTTP glue for `GET /api/health`. Keeps the Express-specific concerns
 * (status code, JSON serialization) here and delegates the actual status
 * computation to the (portable) health service.
 */

import { asyncHandler } from '../utils/async-handler.js';
import { getHealthStatus } from '../services/health.service.js';

/**
 * GET /api/health
 * @type {import('express').RequestHandler}
 */
export const healthController = asyncHandler(async (_req, res) => {
  const status = await getHealthStatus();
  res.status(200).json(status);
});
