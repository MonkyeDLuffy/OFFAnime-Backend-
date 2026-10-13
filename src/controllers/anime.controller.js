/**
 * Anime controllers (thin HTTP glue - no provider logic).
 *   GET /api/details/:id           - full details pipeline (AniList + Jikan +
 *                                    TMDB, shared composite cache)
 *   GET /api/smart/details/:id     - same canonical payload (orchestration
 *                                    convenience endpoint; shares the cache)
 *   GET /api/episodes/:id          - episode METADATA only (no streaming)
 *   GET /api/recommendations/:id   - AniList recommendations
 *   GET /api/seasons/:id           - AniList relations
 *   GET /api/category/:type        - category listing
 *
 * `:id` is ALWAYS the AniList ID (the canonical identity) - never a MAL ID,
 * never a TMDB ID. IDs are validated in the services via the identity layer.
 */

import { asyncHandler } from '../utils/async-handler.js';
import { firstString, optionalInt } from '../utils/query.js';
import { getFullDetails, getAnimeRecommendations, getAnimeSeasons } from '../services/anime.service.js';
import { getAnimeEpisodes } from '../services/episode.service.js';
import { getCategory } from '../services/category.service.js';

/**
 * GET /api/details/:id
 * @type {import('express').RequestHandler}
 */
export const detailsController = asyncHandler(async (req, res) => {
  res.status(200).json(await getFullDetails(req.params.id));
});

/**
 * GET /api/smart/details/:id
 * Convenience/orchestration endpoint over the SAME canonical service as
 * /api/details/:id - it shares the identical composite cache key, so there
 * are zero duplicate provider calls between the two endpoints.
 * @type {import('express').RequestHandler}
 */
export const smartDetailsController = detailsController;

/**
 * GET /api/episodes/:id
 * Episode METADATA only (no MegaPlay, no stream URLs, no fabricated episodes).
 * @type {import('express').RequestHandler}
 */
export const episodesController = asyncHandler(async (req, res) => {
  const episodes = await getAnimeEpisodes(req.params.id, {
    page: optionalInt(req.query.page, { min: 1, label: 'page' }) ?? 1,
  });
  res.status(200).json(episodes);
});

/**
 * GET /api/recommendations/:id
 * @type {import('express').RequestHandler}
 */
export const recommendationsController = asyncHandler(async (req, res) => {
  res.status(200).json(await getAnimeRecommendations(req.params.id));
});

/**
 * GET /api/seasons/:id
 * @type {import('express').RequestHandler}
 */
export const seasonsController = asyncHandler(async (req, res) => {
  res.status(200).json(await getAnimeSeasons(req.params.id));
});

/**
 * GET /api/category/:type
 * @type {import('express').RequestHandler}
 */
export const categoryController = asyncHandler(async (req, res) => {
  const page = await getCategory(firstString(req.params.type, { maxLength: 50, label: 'category' }), {
    page: optionalInt(req.query.page, { min: 1, max: 500, label: 'page' }),
    perPage: optionalInt(req.query.perPage, { min: 1, max: 50, label: 'perPage' }),
  });
  res.status(200).json(page);
});
