/**
 * Test env setup with a SHORT request timeout. Import as the FIRST static
 * import of a test file that exercises real provider timeouts (MegaPlay
 * provider tests): the tiny timeout keeps the timeout tests fast while every
 * mocked response still completes instantly.
 */

process.env.LOG_LEVEL = 'error';
process.env.REQUEST_TIMEOUT_MS = '200';
process.env.BACKEND_API_SECRET = 'test-only-default-secret';
