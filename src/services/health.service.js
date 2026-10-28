/**
 * Health service.
 *
 * Business logic for the health check. Returns a plain data object describing
 * the running service. It performs NO provider or cache calls, so it stays fast
 * and is immune to upstream outages.
 *
 * Being a pure data function (no Express req/res), this is portable: a
 * Cloudflare/edge adapter could reuse it directly.
 */

import { APP_NAME, APP_VERSION } from '../config/constants.js';
import { config } from '../config/env.js';

/**
 * Read process uptime in a runtime-safe way (returns null where unavailable,
 * e.g. non-Node runtimes).
 * @returns {number | null}
 */
function getUptimeSeconds() {
  if (typeof process !== 'undefined' && typeof process.uptime === 'function') {
    return Math.round(process.uptime());
  }
  return null;
}

/**
 * @typedef {Object} HealthStatus
 * @property {'ok'} status
 * @property {string} service
 * @property {string} version
 * @property {string} environment
 * @property {number | null} uptimeSeconds
 * @property {string} timestamp ISO 8601
 */

/**
 * Build the current health status.
 * @returns {Promise<HealthStatus>}
 */
export async function getHealthStatus() {
  return {
    status: 'ok',
    service: APP_NAME,
    version: APP_VERSION,
    environment: config.NODE_ENV,
    uptimeSeconds: getUptimeSeconds(),
    timestamp: new Date().toISOString(),
  };
}
