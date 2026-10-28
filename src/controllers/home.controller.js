/**
 * Home controller (thin HTTP glue - no provider logic).
 *   GET /api/home
 */

import { asyncHandler } from '../utils/async-handler.js';
import { getHomeFeed } from '../services/home.service.js';

/**
 * GET /api/home
 * @type {import('express').RequestHandler}
 */
export const homeController = asyncHandler(async (_req, res) => {
  res.status(200).json(await getHomeFeed());
});
