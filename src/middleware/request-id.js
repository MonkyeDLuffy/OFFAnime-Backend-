/**
 * Request ID middleware.
 *
 * Assigns a stable id to every request so logs across the whole request
 * lifecycle can be correlated. Honors an inbound `X-Request-Id` (useful when a
 * CDN/edge proxy already generated one) and otherwise mints a UUID.
 *
 * The id is attached to `req.id`, echoed back via the `X-Request-Id` response
 * header, and used to create a per-request child logger at `req.log`.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

/** @returns {import('express').RequestHandler} */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id = (typeof incoming === 'string' && incoming.trim()) || randomUUID();

    req.id = id;
    req.log = logger.child({ requestId: id });
    res.setHeader('X-Request-Id', id);

    next();
  };
}
