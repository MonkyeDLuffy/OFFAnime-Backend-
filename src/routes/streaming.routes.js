/**
 * Streaming routes.
 *
 *   GET /api/stream/resolve/anilist/:id  -> resolve a playable stream by AniList ID.
 *   GET /api/stream/resolve/mal/:id      -> resolve a playable stream by MAL ID.
 *   GET /api/stream/resolve/:id          -> legacy route; `:id` is ALWAYS an AniList ID.
 *
 * `:id` is the numeric ID in the namespace named by the route. AniList IDs and
 * MAL IDs are different namespaces and are NEVER silently reinterpreted as one
 * another. The specific `/anilist/:id` and `/mal/:id` routes are registered
 * BEFORE the generic `/:id` route so Express matches them first.
 *
 * Resolution flow (AniList route - unchanged, backward compatible):
 *   MegaPlay /stream/ani/{anilistId}/{ep}/{lang}  (primary)
 *   -> genuine no-stream -> IdentityResolver.resolveAniListToMal(anilistId)
 *   -> MegaPlay /stream/mal/{malId}/{ep}/{lang}   (fallback)
 *   -> none -> PRIMARY (AniList) proxy playback URL anyway.
 *
 * Resolution flow (MAL route):
 *   MegaPlay /stream/mal/{malId}/{ep}/{lang}  (primary)
 *   -> genuine no-stream -> IdentityResolver.resolveMalToAniList(malId)
 *   -> MegaPlay /stream/ani/{anilistId}/{ep}/{lang}  (fallback)
 *   -> none -> PRIMARY (MAL) proxy playback URL anyway.
 *
 * Query parameters: ?ep=1&language=sub (the original documented ?episode=1
 * alias remains supported; validated in the resolver).
 * Provider failures remain typed errors. The response's playbackUrl is ALWAYS
 * the frontend-safe proxy watch URL; direct MegaPlay URLs are NEVER exposed.
 */

import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { streamResolveController, streamResolveMalController } from '../controllers/streaming.controller.js';

const router = Router();

// Specific namespaces FIRST so the generic /:id route cannot shadow them.
router.get('/stream/resolve/anilist/:id', asyncHandler(streamResolveController));
router.get('/stream/resolve/mal/:id', asyncHandler(streamResolveMalController));
router.get('/stream/resolve/:id', asyncHandler(streamResolveController));

export default router;
