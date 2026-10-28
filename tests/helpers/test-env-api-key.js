/**
 * Test env setup for API-key QUERY-PARAMETER auth tests: development mode with
 * a configured (test-only) secret. Import as the FIRST static import of a
 * test file (runs before config/env.js loads transitively via
 * helpers/test-server.js).
 */

import './test-env.js';

process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
