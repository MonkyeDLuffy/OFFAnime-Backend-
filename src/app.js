/**
 * Express application factory (deployment-agnostic).
 *
 * This module builds and returns a fully-wired Express app but never starts an
 * HTTP listener. That separation is deliberate:
 *
 *   - `app.js`     -> portable app definition (routes, middleware, handlers).
 *   - `server.js`  -> Node/VPS/Vercel-node entry that calls `app.listen(...)`.
 *   - (future)     -> a Cloudflare/Vercel adapter can import `createApp()` and
 *                     wrap it, or reuse the same controllers/services directly.
 *
 * Keeping construction in a factory means no HTTP side effects happen at import
 * time, which is important for serverless cold starts and for testing (each
 * test can build a fresh app on an ephemeral port).
 */

import express from 'express';
import cors from 'cors';

import { config } from './config/env.js';
import { registerRoutes } from './routes/index.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { notFoundHandler } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';

/**
 * Build a configured Express application.
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();

  // Behind CDNs/load balancers (Vercel/Cloudflare) so client IPs and protocol
  // are read from proxy headers. Do not leak the framework fingerprint.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // CORS: the frontend (offanime.cc) is a separate origin calling this API.
  // Credentials (cookies for the user-session mode) require an EXPLICIT origin
  // allowlist - the spec forbids `Access-Control-Allow-Origin: *` together
  // with `Access-Control-Allow-Credentials: true`, so wildcard CORS keeps
  // credentials disabled (the token/Bearer flow does not need cookie CORS).
  // Production deployments that use cookie sessions MUST set CORS_ORIGIN to
  // the frontend origins.
  const corsOrigin = config.CORS_ORIGIN === '*'
    ? '*'
    : String(config.CORS_ORIGIN).split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: corsOrigin, credentials: corsOrigin !== '*' }));

  // JSON body parsing (bounded to avoid abuse). GET-only for now, but harmless.
  app.use(express.json({ limit: '1mb' }));

  // Observability: assign request id + per-request logger, then log completion.
  app.use(requestId());
  app.use(requestLogger());

  // All feature routes live under /api (see routes/index.js).
  registerRoutes(app);

  // 404 for anything unmatched, then the centralized error handler LAST.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
