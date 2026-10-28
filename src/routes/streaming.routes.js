/**
 * Streaming routes.
 *
 *   GET /api/stream/resolve/:id  -> resolve a playable stream for an anime.
 *
 * `:id` is the AniList ID (canonical identity - NEVER assumed to be a MAL ID).
 * Resolution follows the documented flow: try MegaPlay with the AniList ID
 * (/stream/ani/{id}/{ep}/{lang}) -> on a genuine no-stream result resolve
 * AniList->MAL through the IdentityResolver -> try MegaPlay with the MAL ID
 * (/stream/mal/{malId}/{ep}/{lang}). When neither direct lookup produced a
 * usable stream, the PRIMARY (AniList) proxy playback URL is returned - a
 * direct MegaPlay 410/no-stream never proves playback unavailable (the proxy
 * is the browser-facing playback mechanism and handles availability).
 *
 * Query parameters: ?ep=1&language=sub (the original documented ?episode=1
 * alias remains supported; validated in the resolver).
 * Provider failures remain typed errors. The response's playbackUrl is ALWAYS
 * the frontend-safe proxy watch URL; direct MegaPlay URLs are NEVER exposed.
 */

import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { streamResolveController } from '../controllers/streaming.controller.js';

const router = Router();

router.get('/stream/resolve/:id', asyncHandler(streamResolveController));

export default router;
