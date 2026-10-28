/**
 * Search controllers (thin HTTP glue - no provider logic).
 *   GET /api/search
 *   GET /api/top-search
 */

import { asyncHandler } from '../utils/async-handler.js';
import { firstString, optionalInt } from '../utils/query.js';
import { searchAnime } from '../services/anime.service.js';
import { getTopSearch } from '../services/top-search.service.js';

/**
 * GET /api/search
 * Query params: q (optional), page, perPage, season, year, format, status,
 * genre, sort. All filter values are validated in the service (enums + bounds)
 * before any provider request.
 * @type {import('express').RequestHandler}
 */
export const searchController = asyncHandler(async (req, res) => {
  const page = await searchAnime(firstString(req.query.q, { label: 'q' }) ?? '', {
    page: optionalInt(req.query.page, { min: 1, max: 500, label: 'page' }),
    perPage: optionalInt(req.query.perPage, { min: 1, max: 50, label: 'perPage' }),
    season: firstString(req.query.season, { label: 'season' }),
    year: optionalInt(req.query.year, { min: 1960, max: 2200, label: 'year' }),
    format: firstString(req.query.format, { label: 'format' }),
    status: firstString(req.query.status, { label: 'status' }),
    genre: firstString(req.query.genre, { label: 'genre' }),
    sort: firstString(req.query.sort, { label: 'sort' }),
  });
  res.status(200).json(page);
});

/**
 * GET /api/top-search
 * @type {import('express').RequestHandler}
 */
export const topSearchController = asyncHandler(async (_req, res) => {
  res.status(200).json(await getTopSearch());
});
