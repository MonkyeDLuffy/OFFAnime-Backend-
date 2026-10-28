/**
 * `notImplemented` route handler factory.
 *
 * Phase 1 registers every frontend contract route so the API surface is stable
 * and discoverable, but only `/api/health` has real logic. Every other contract
 * route is wired to this handler, which responds with a truthful `501 Not
 * Implemented` instead of returning fake/empty data.
 *
 * This satisfies two requirements at once:
 *   1. Preserve the exact frontend route paths.
 *   2. Never let unfinished routes pretend to work.
 *
 * Usage:
 *   router.get('/details/:id', notImplemented('anime.details', { phase: 2 }));
 *
 * @param {string} feature Short identifier for the planned feature.
 * @param {Record<string, unknown>} [meta] Optional context (e.g. target phase).
 * @returns {import('express').RequestHandler}
 */
import { NotImplementedError } from '../errors/index.js';

export function notImplemented(feature, meta = {}) {
  return (_req, _res, next) => {
    next(
      new NotImplementedError(`"${feature}" is not implemented yet (planned for a later phase).`, {
        feature,
        ...meta,
      }),
    );
  };
}
