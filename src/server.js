/**
 * Node HTTP server entry point (traditional / VPS / Vercel-node runtime).
 *
 * This is the ONLY place that opens a network listener. Serverless adapters
 * (Cloudflare Workers, edge functions) should NOT import this file; they import
 * `createApp()` from `app.js` and bridge requests themselves.
 *
 * The backend is stateless at the request level, so multiple instances of this
 * process can run behind a load balancer without coordination. Nothing here
 * assumes the process stays alive forever.
 */

import { createApp } from './app.js';
import { config, getRedactedConfig } from './config/env.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info('server.started', {
    host: config.HOST,
    port: config.PORT,
    env: config.NODE_ENV,
    pid: typeof process !== 'undefined' ? process.pid : undefined,
  });
  logger.debug('server.config', { config: getRedactedConfig() });
});

/**
 * Graceful shutdown: stop accepting new connections, then exit. Serverless
 * platforms send SIGTERM before reclaiming an instance.
 * @param {string} signal
 */
function shutdown(signal) {
  logger.info('server.shutdown', { signal });
  server.close(() => {
    logger.info('server.closed', {});
    process.exit(0);
  });
  // Safety net: force-exit if connections do not drain promptly.
  setTimeout(() => process.exit(1), 10_000).unref();
}

if (typeof process !== 'undefined') {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandledRejection', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaughtException', { err });
  });
}

export { app, server };
