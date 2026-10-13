/**
 * Test env setup. Import this as the FIRST static import of an endpoint test
 * file: ESM evaluates imported modules depth-first in import order, so this
 * module body runs BEFORE any application module (config/env.js) loads.
 */

process.env.LOG_LEVEL = 'error';

// Playback proxy is NOT configured in tests - proxy playback behavior is
// covered with injected fakes (config stays deterministic regardless of a
// local .env file).
process.env.MEGAPLAY_PROXY_URL = '';

// TMDB is NOT configured by default (a local .env with a real key must never
// leak into tests). Tests that need TMDB configured import test-env-tmdb.js
// instead, which sets a deterministic key AFTER this default.
process.env.TMDB_API_KEY = '';
