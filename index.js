/**
 * Vercel deployment entrypoint (deployment adapter - contains NO business logic).
 *
 * Selection is EXPLICIT, not heuristic: vercel.json pins this file as the only
 * build entrypoint (`builds: [{ src: "index.js", use: "@vercel/node" }]`) and
 * rewrites every request path to it. Vercel's zero-config Express detection is
 * therefore disabled - empirically it prefers `src/app.js` (a valid import of
 * express but a default-export-less module) and fails at runtime with
 * "Invalid export found in module ... The default export must be a function
 * or server." Pinning the entrypoint removes that failure mode entirely.
 *
 * The Vercel Node runtime requires the entrypoint module to provide a default
 * export (function), an HTTP-method export, a `fetch` export, or an
 * `app.listen()` call at import time. This file satisfies that contract by
 * default-exporting the built Express app, which the runtime then invokes with
 * real Node req/res (no extra helpers are added because the app exposes
 * `.listen`). All `/api/*` routes are preserved by the framework's catch-all
 * route, which passes the original request path through to the app.
 *
 * The app is built ONCE per isolate via `createApp()` - which never opens a
 * listener - so no multiple servers are started during module import.
 * Environment variables come from the Vercel dashboard (src/config/env.js
 * reads `process.env`; the gitignored `.env` is absent on Vercel).
 */

import express from 'express';
import { createApp } from './src/app.js';

const app = createApp();

export default app;
