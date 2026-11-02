/**
 * Streaming routes (dual-server capable, legacy-compatible).
 *
 *   GET /api/stream/resolve/anilist/:id -> AniList-PRIMARY resolution.
 *   GET /api/stream/resolve/mal/:id     -> MAL-PRIMARY resolution.
 *   GET /api/stream/resolve/:id         -> LEGACY, AniList-primary (unchanged).
 *
 * The explicit /anilist/:id and /mal/:id routes are registered BEFORE the
 * legacy /:id route so Express never matches a namespaced path against the
 * catch-all legacy pattern (route-matching order matters here by design).
 *
 * `:id` belongs to the namespace of its route segment - an AniList ID on
 * /anilist and legacy, a MAL ID on /mal. A MAL ID is NEVER reinterpreted as an
 * AniList ID (and vice versa): numeric equality means nothing. Cross-namespace
 * fallback (AniList<->MAL) happens inside StreamResolver through the
 * IdentityResolver's DIRECTIONAL methods:
 *   - anilist route/legacy: MegaPlay by AniList ID (/stream/ani/{id}) ->
 *     on a genuine no-stream resolveAniListToMal -> MegaPlay by the RESOLVED
 *     MAL ID (/stream/mal/{malId}).
 *   - mal route: MegaPlay by MAL ID (/stream/mal/{id}) -> on a genuine
 *     no-stream resolveMalToAniList -> MegaPlay by the RESOLVED AniList ID
 *     (/stream/ani/{anilistId}).
 *
 * When neither direct lookup produced a usable stream, the request's PRIMARY
 * namespace stands (proxy playback Hungarian on the primary idType - see
 * stream-resolver.js). A direct MegaPlay 410/no-stream never proves playback
 * unavailable (the proxy is the browser-facing playback mechanism and handles
 * availability).
 *
 * Query parameters: ?ep=1&language=sub (the original documented ?episode=1
 * alias remains supported; `ep` precedence and validation are preserved by the
 * shared controllers). Provider failures remain typed errors. The response's
 * playbackUrl is ALWAYS the frontend-safe proxy watch URL; direct MegaPlay
 * URLs are NEVER exposed.
 */

import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import {
  streamResolveController,
  streamResolveAniListController,
  streamResolveMalController,
} from '../controllers/streaming.controller.js';

const router = Router();

// Explicit namespaces FIRST (never shadowed / captured by the legacy route).
router.get('/stream/resolve/anilist/:id', asyncHandler(streamResolveAniListController));
router.get('/stream/resolve/mal/:id', asyncHandler(streamResolveMalController));

// LEGACY route (unchanged contract): `:id` is the AniList ID.
router.get('/stream/resolve/:id', asyncHandler(streamResolveController));

export default router;
