/**
 * Test env setup for details-pipeline performance tests: TMDB configured and a
 * SHORT enrichment deadline so bounded-deadline behavior is observable fast.
 * Import as the FIRST static import of a test file (ESM evaluates imports
 * depth-first in order, so this runs before config/env.js loads).
 */

process.env.LOG_LEVEL = 'error';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ENRICHMENT_TIMEOUT_MS = '300';
process.env.BACKEND_API_SECRET = 'test-only-default-secret';
