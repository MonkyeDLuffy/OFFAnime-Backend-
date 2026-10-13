/**
 * Test env setup for stream-resolve ENDPOINT tests: identical to test-env.js
 * but with the playback proxy CONFIGURED so /api/stream/resolve/:id returns
 * frontend-safe proxy watch URLs (production shape) instead of the typed
 * proxy-not-configured error. Import as the FIRST static import of a test
 * file: ESM evaluates imported modules depth-first in import order, so this
 * module body runs BEFORE any application module (config/env.js) loads.
 */

process.env.LOG_LEVEL = 'error';
process.env.MEGAPLAY_PROXY_URL = 'https://megaplayproxy.test';
