/**
 * Test env setup for auth tests that assert LOG BEHAVIOR (e.g. passwords and
 * tokens never reaching stdout/stderr): like test-env-auth.js but with
 * LOG_LEVEL=debug so request/provider log lines are actually emitted and can
 * be captured. Import as the FIRST static import of a test file.
 */

import './test-env.js';

process.env.LOG_LEVEL = 'debug';
process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
process.env.SUPABASE_URL = 'https://auth-tests.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-not-a-real-credential';
