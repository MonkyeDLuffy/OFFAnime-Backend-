/**
 * Schedule controller (thin HTTP glue - no provider logic).
 *   GET /api/schedule
 */

import { asyncHandler } from '../utils/async-handler.js';
import { optionalInt } from '../utils/query.js';
import { getAiringSchedule } from '../services/schedule.service.js';

/**
 * GET /api/schedule
 * Query params: from / to (epoch seconds, optional), page (optional).
 * @type {import('express').RequestHandler}
 */
export const scheduleController = asyncHandler(async (req, res) => {
  const schedule = await getAiringSchedule({
    from: optionalInt(req.query.from, { min: 0, label: 'from' }),
    to: optionalInt(req.query.to, { min: 0, label: 'to' }),
    page: optionalInt(req.query.page, { min: 1, label: 'page' }),
  });
  res.status(200).json(schedule);
});
