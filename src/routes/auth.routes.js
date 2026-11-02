/**
 * User-authentication routes (Supabase Auth identity provider).
 *
 *   POST /api/auth/signup           create an account (immediately usable;
 *                                   email confirmation is disabled upstream)
 *   POST /api/auth/login            password grant -> user + session
 *   POST /api/auth/logout           revoke the presented session
 *   GET  /api/auth/me               current user (verified session required)
 *   POST /api/auth/refresh          rotate refresh token -> fresh session
 *   POST /api/auth/password-reset   request a password-reset email
 *   POST /api/auth/verify           exchange one-time email token -> session
 *   POST /api/auth/password-update  set a new password (session required)
 *   POST /api/auth/resend           RESERVED for a future email feature (501)
 *
 * POLICY (deliberate - see routes/index.js and README "Route protection"):
 *   - These routes sit BEHIND the central API-key middleware: callers must be
 *     a trusted server (the frontend's server-side proxy adds X-API-Key). The
 *     browser never receives the backend API key.
 *   - A user session (Authorization: Bearer <access_token> or session cookie)
 *     is REQUIRED only where stated (/me, /password-update; /logout and
 *     /refresh resolve their own tokens) - login/signup are anonymous.
 *   - State-changing requests that arrived with a session COOKIE are guarded
 *     by the CSRF origin check (see middleware/session.js).
 *   - Login failed-attempt limits + signup anti-abuse are enforced in the
 *     controllers via services/auth-throttle.service.js (DB-backed, shared
 *     across serverless instances).
 */

import { Router } from 'express';

import {
  signupController,
  loginController,
  logoutController,
  meController,
  refreshController,
  passwordResetController,
  verifyController,
  passwordUpdateController,
} from '../controllers/auth.controller.js';
import { requireUser, csrfOriginGuard } from '../middleware/session.js';
import { notImplemented } from '../middleware/not-implemented.js';

const router = Router();

// Anonymous (credentials in body) - still API-key protected + CSRF origin guard.
router.post('/auth/signup', csrfOriginGuard(), signupController);
router.post('/auth/login', csrfOriginGuard(), loginController);
router.post('/auth/refresh', csrfOriginGuard(), refreshController);
router.post('/auth/password-reset', csrfOriginGuard(), passwordResetController);
// RESERVED: email confirmation is disabled (no confirmation emails exist) and
// this endpoint must not be activated until a future email feature needs it.
// The route keeps its exact path and answers an honest 501.
router.post('/auth/resend', csrfOriginGuard(), notImplemented('auth.resend', {
  reason: 'reserved',
  detail: 'Email confirmation is disabled; this endpoint is reserved for a future email feature.',
}));
router.post('/auth/verify', csrfOriginGuard(), verifyController);

// Session-required.
router.get('/auth/me', requireUser(), meController);
router.post('/auth/logout', csrfOriginGuard(), logoutController);
router.post('/auth/password-update', requireUser(), csrfOriginGuard(), passwordUpdateController);

export default router;
