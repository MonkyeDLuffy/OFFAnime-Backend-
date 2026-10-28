/**
 * Test env setup for API-key log-redaction tests: like test-env-api-key.js but
 * with LOG_LEVEL=debug so warn-level request logs (401s) are actually emitted
 * and can be captured. Import as the FIRST static import of a test file.
 */

import './test-env.js';

process.env.LOG_LEVEL = 'debug';
process.env.BACKEND_API_SECRET = 'test-only-secret-not-a-real-credential';
