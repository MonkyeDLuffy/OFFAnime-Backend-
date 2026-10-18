/**
 * GoTrue (Supabase Auth) response fixtures shared by the auth endpoint tests.
 * Shapes mirror the real GoTrue payloads (user object + session object, and
 * the JSON error body { code, error_code, msg }).
 */

/** The test-only anon key pinned by tests/helpers/test-env-auth.js. */
export const TEST_ANON_KEY = 'test-anon-key-not-a-real-credential';
/** The test-only backend API secret pinned by the test env helpers. */
export const TEST_API_SECRET = 'test-only-secret-not-a-real-credential';

/**
 * Raw GoTrue user object. Includes fields that must NEVER leak into API
 * responses (app_metadata, raw_user_meta_data) so tests can assert their
 * absence.
 * @param {{ id?: string, email?: string, confirmed?: boolean, extra?: object }} [options]
 */
export function gotrueUser({ id = '11111111-1111-4111-8111-111111111111', email = 'user@example.com', confirmed = true, extra = {} } = {}) {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: confirmed ? '2026-01-01T00:00:00.000Z' : null,
    phone: '',
    confirmed_at: confirmed ? '2026-01-01T00:00:00.000Z' : null,
    last_sign_in_at: '2026-10-01T00:00:00.000Z',
    app_metadata: { provider: 'email', providers: ['email'], roles: ['must-never-leak'] },
    user_metadata: { name: 'Test User', secret_note: 'user-controlled' },
    raw_user_meta_data: { name: 'Test User' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

/**
 * Raw GoTrue session object (password grant / signup-with-session / refresh).
 * @param {{ userId?: string, email?: string, accessToken?: string, refreshToken?: string }} [options]
 */
export function gotrueSession({ userId, email, accessToken = 'gt-access-token-abc123', refreshToken = 'gt-refresh-token-xyz789' } = {}) {
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refreshToken,
    user: gotrueUser({ id: userId, email }),
  };
}

/**
 * GoTrue JSON error body.
 * @param {number} code
 * @param {string} errorCode
 * @param {string} msg
 */
export function gotrueError(code, errorCode, msg) {
  return { status: code, json: { code, error_code: errorCode, msg } };
}

/**
 * Successful session JSON response.
 * @param {{ userId?: string, email?: string, accessToken?: string, refreshToken?: string, withSession?: boolean }} [options]
 */
export function gotrueSessionResponse(options = {}) {
  const { withSession = true, ...rest } = options;
  if (!withSession) {
    // Email confirmation required: GoTrue returns the user WITHOUT a session.
    return { status: 200, json: gotrueUser({ id: rest.userId, email: rest.email }) };
  }
  return { status: 200, json: gotrueSession(rest) };
}
