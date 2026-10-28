/**
 * Test env setup for AUTH endpoint tests: development mode with the TEST-ONLY
 * API secret AND Supabase Auth (GoTrue) configuration. The service-role key is
 * deliberately left UNSET - auth must work with the anon key alone (and tests
 * prove it is never sent). Import as the FIRST static import of a test file
 * (runs before config/env.js loads transitively via helpers/test-server.js).
 */

import './test-env.js';

process.env.LOG_LEVEL = 'error';
process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
process.env.SUPABASE_URL = 'https://auth-tests.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-not-a-real-credential';
