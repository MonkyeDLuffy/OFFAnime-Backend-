/**
 * Route registration.
 *
 * Mounts every feature router under the shared API prefix. Routers are thin:
 * they only map HTTP method + path to a controller (or, for reserved routes,
 * to the `notImplemented` handler). They contain NO provider or business logic.
 *
 * All 15 frontend contract routes are registered here so the public API surface
 * is stable from day one. Only `/api/health` is functional in Phase 1; the rest
 * respond with an honest 501 until their phase lands.
 */

import { Router } from 'express';

import { API_PREFIX } from '../config/constants.js';
import { apiKeyAuth } from '../middleware/api-key-auth.js';
import healthRoutes from './health.routes.js';
import homeRoutes from './home.routes.js';
import searchRoutes from './search.routes.js';
import animeRoutes from './anime.routes.js';
import streamingRoutes from './streaming.routes.js';
import jikanRoutes from './jikan.routes.js';
import tmdbRoutes from './tmdb.routes.js';
import authRoutes from './auth.routes.js';

/**
 * Attach all routers to the app under {@link API_PREFIX}.
 * @param {import('express').Express} app
 */
export function registerRoutes(app) {
  const api = Router();

  // PUBLIC: /api/health is the only route registered BEFORE the API-key
  // middleware. Deployment health probes cannot carry secrets and the endpoint
  // leaks no sensitive data (see README "API key protection").
  api.use(healthRoutes); //    /health

  // PROTECTED: everything mounted below requires a valid API key
  // (Authorization: Bearer <BACKEND_API_SECRET>, or x-api-key). ONE central
  // registration - controllers never duplicate credential checks. OPTIONS
  // preflight requests pass through untouched (handled inside the middleware).
  //
  // /api/auth/* is included DELIBERATELY: login/signup must arrive through a
  // trusted server-side proxy that adds the API key (the browser never holds
  // the secret). User sessions (Authorization: Bearer <access_token> /
  // session cookie) are a SEPARATE layer enforced inside the auth routes
  // (requireUser) - they never substitute for the API key.
  api.use(apiKeyAuth());

  api.use(authRoutes); //      /auth/* (Supabase Auth; API key + per-route session policy)
  api.use(homeRoutes); //      /home, /schedule
  api.use(searchRoutes); //    /search, /top-search
  api.use(animeRoutes); //     /details, /smart/details, /episodes, /recommendations, /seasons, /category
  api.use(streamingRoutes); // /stream/resolve
  api.use(jikanRoutes); //     /jikan/*
  api.use(tmdbRoutes); //      /tmdb/:id

  app.use(API_PREFIX, api);
}
