/**
 * Test env setup for API-key FAIL-CLOSED verification: production mode with
 * NO secret configured. Import as the FIRST static import of a test file
 * (runs before config/env.js loads transitively via helpers/test-server.js).
 *
 * Empty string means "unset" for config/env.js, and dotenv never overrides
 * pre-set variables, so a local .env secret cannot leak into this file.
 */

import './test-env.js';

process.env.NODE_ENV = 'production';
process.env.BACKEND_API_SECRET = '';
