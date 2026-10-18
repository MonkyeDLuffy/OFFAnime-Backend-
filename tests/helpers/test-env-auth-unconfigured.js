/**
 * Test env for auth FAIL-CLOSED tests: API secret configured but Supabase
* Auth (SUPABASE_URL / SUPABASE_ANON_KEY) deliberately UNSET. Import as the
 * FIRST static import of a test file.
 */

import './test-env.js';

process.env.LOG_LEVEL = 'error';
process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
