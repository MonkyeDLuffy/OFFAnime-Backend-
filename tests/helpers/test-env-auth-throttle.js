/**
 * Test env for AUTH THROTTLE tests: Supabase Auth (anon) + a TEST-ONLY
 * service-role key + the DB-backed attempt limiter enabled.
 *
 * Import as the FIRST static import of a test file (env must be pinned before
 * config/env.js loads transitively). Thresholds mirror the PRODUCTION policy
 * for the login ACCOUNT layer (5 failures / 15-min window / 15-min lock) so
 * the endpoint tests exercise the shipped values; the per-IP login threshold
 * stays at the production default (20); the signup per-IP budget is reduced to
 * 3 purely to keep tests compact (the semantics are threshold-driven and are
 * identical at any value).
 */

import './test-env-auth.js';

process.env.LOG_LEVEL = 'error';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-not-a-real-credential';
process.env.AUTH_ATTEMPT_LIMITS_ENABLED = 'true';

// Login: production policy.
process.env.AUTH_LOGIN_MAX_FAILURES = '5';
process.env.AUTH_LOGIN_FAILURE_WINDOW_SECONDS = '900';
process.env.AUTH_LOGIN_LOCK_SECONDS = '900';
process.env.AUTH_LOGIN_IP_MAX_FAILURES = '20';

// Signup: production semantics, compact threshold.
process.env.AUTH_SIGNUP_IP_MAX_ATTEMPTS = '3';
process.env.AUTH_SIGNUP_IP_WINDOW_SECONDS = '3600';
process.env.AUTH_SIGNUP_IP_LOCK_SECONDS = '900';
process.env.AUTH_SIGNUP_DEDUPE_TTL_SECONDS = '600';
