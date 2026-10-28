/**
 * Test env setup. Import this as the FIRST static import of an endpoint test
 * file: ESM evaluates imported modules depth-first in import order, so this
 * module body runs BEFORE any application module (config/env.js) loads.
 */

process.env.LOG_LEVEL = 'error';

// API-key auth: a DEFAULT TEST-ONLY secret is configured so the fail-closed
// middleware (active in every environment) lets endpoint tests through.
// startTestServer() injects the matching Authorization header automatically.
// Tests that need a DIFFERENT secret (or none) set it in their own first-import
// helper (see tests/api-key-auth*.test.js). A local .env can never leak in:
// dotenv does not override pre-set variables.
process.env.BACKEND_API_SECRET = 'test-only-default-secret';

// Playback proxy is NOT configured in tests - proxy playback behavior is
// covered with injected fakes (config stays deterministic regardless of a
// local .env file).
process.env.MEGAPLAY_PROXY_URL = '';

// TMDB is NOT configured by default (a local .env with a real key must never
// leak into tests). Tests that need TMDB configured import test-env-tmdb.js
// instead, which sets a deterministic key AFTER this default.
process.env.TMDB_API_KEY = '';
