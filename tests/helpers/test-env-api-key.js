/**
 * Test env setup with an API-key secret CONFIGURED (development mode).
 * Import as the FIRST static import of a test file: ESM evaluates imports
 * depth-first in import order, so this module body runs BEFORE any application
 * module (config/env.js - loaded transitively by helpers/test-server.js).
 *
 * The secret is a TEST-ONLY value; a local .env can never leak in because
 * dotenv does not override pre-set variables.
 */

import './test-env.js';

process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
