/**
 * Test env setup for auth POLICY tests: like test-env-auth.js but with an
 * EXPLICIT CORS_ORIGIN allowlist (required for cookie-mode CORS credentials
 * and the CSRF origin allowlist). Import as the FIRST static import.
 */

import './test-env.js';

process.env.LOG_LEVEL = 'error';
process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
process.env.SUPABASE_URL = 'https://auth-tests.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-not-a-real-credential';
process.env.CORS_ORIGIN = 'https://offanime.example,https://www.offanime.example';
