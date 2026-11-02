/**
 * Test env for the PER-IP login-failure layer tests: same as the base throttle
 * env but with a small IP threshold (3) so the separate IP layer can be
 * exercised without 20+ requests.
 */

import './test-env-auth-throttle.js';

process.env.AUTH_LOGIN_IP_MAX_FAILURES = '3';
