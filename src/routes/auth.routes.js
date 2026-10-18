/**
 * User-authentication routes (Supabase Auth identity provider).
 *
 *   POST /api/auth/signup           create an account
 *   POST /api/auth/login            password grant -> user + session
 *   POST /api/auth/logout           revoke the presented session
 *   GET  /api/auth/me               current user (verified session required)
 *   POST /api/auth/refresh          rotate refresh token -> fresh session
 *   POST /api/auth/password-reset   request a password-reset email
 *   POST /api/auth/verify           exchange one-time email token -> session
 *   POST /api/auth/password-update  set a new password (session required)
 *   POST /api/auth/resend           resend confirmation/recovery email
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
  resendController,
} from '../controllers/auth.controller.js';
import { requireUser, csrfOriginGuard } from '../middleware/session.js';

const router = Router();

// Anonymous (credentials in body) - still API-key protected + CSRF origin guard.
router.post('/auth/signup', csrfOriginGuard(), signupController);
router.post('/auth/login', csrfOriginGuard(), loginController);
router.post('/auth/refresh', csrfOriginGuard(), refreshController);
router.post('/auth/password-reset', csrfOriginGuard(), passwordResetController);
router.post('/auth/resend', csrfOriginGuard(), resendController);
router.post('/auth/verify', csrfOriginGuard(), verifyController);

// Session-required.
router.get('/auth/me', requireUser(), meController);
router.post('/auth/logout', csrfOriginGuard(), logoutController);
router.post('/auth/password-update', requireUser(), csrfOriginGuard(), passwordUpdateController);

export default router;
