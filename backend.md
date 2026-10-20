# OffAnime Backend — Complete Reference (`backend.md`)

> Everything you need to understand, run, deploy, and connect the OffAnime.cc
> backend to a frontend. This document consolidates the architecture, the full
> route catalog with their uses, configuration, security model, error
> contracts, and frontend integration examples.

---

## 1. Overview

**OffAnime Backend** is a modular, cache-first, serverless-friendly REST API
for **OffAnime.cc**. It aggregates anime metadata from multiple upstream
providers (AniList, Jikan/MyAnimeList, TMDB, AniZip), resolves playable
streams (MegaPlay), persists a shared cache in Supabase, and handles user
authentication via Supabase Auth (GoTrue).

- **Runtime:** Node.js >= 18 (also portable to Cloudflare Workers/Pages via
  `nodejs_compat`)
- **Framework:** Express 4 (ES modules, `"type": "module"`)
- **Dependencies:** `express`, `cors`, `dotenv` only — everything else is
  dependency-free (global `fetch` + `AbortController`)
- **Tests:** `node:test` suite (330+ mocked tests, no live provider calls)
- **Status:** All 15 frontend routes LIVE — metadata, search, streaming,
  auth.

### Provider roles

| Provider | Role | Keyed by |
| --- | --- | --- |
| **AniList** (GraphQL) | Primary identity + metadata source (titles, scores, relations, search, schedule) | AniList ID |
| **Jikan** (MyAnimeList v4) | Secondary metadata enrichment (background, trailer, MAL stats, episode lists) | MAL ID |
| **TMDB** | Visual enrichment only (backdrops/banners). Never identity. | tmdbId (internal) |
| **AniZip** | Episode metadata keyed directly by AniList ID | AniList ID |
| **MegaPlay** | Streaming sources (never exposed directly; playback goes through a proxy) | AniList ID → MAL ID fallback |
| **Supabase** | L2 persistent cache (`cache_entries` table) + user auth (GoTrue) | — |

### ID namespace rule (critical)

AniList IDs and MAL IDs are **different namespaces** and are never silently
converted. On every AniList-based route, `:id` is the **AniList ID**. The only
mapping authority is `src/identity/identity-resolver.js`. The canonical
identity shape used everywhere:

```json
{ "id": 123, "anilistId": 123, "malId": 456 }
```

`malId` may be `null`; `id` always mirrors the AniList ID.

---

## 2. Architecture

Strict layer separation — requests flow top-down:

```text
Frontend
   ↓
Route        (src/routes)         - endpoints only, no logic
   ↓
Controller   (src/controllers)    - HTTP glue: params, responses
   ↓
Service      (src/services)       - business logic
   ↓
Cache        (src/cache)          - L1 memory + L2 Supabase, coalescing
   ↓
Provider     (src/providers)      - external APIs, isolated
   ↓
Normalizer   (src/normalizers)    - provider payloads -> canonical shapes
   ↓
Cache update -> Controller -> Frontend
```

- `src/app.js` is a **factory** (`createApp()`) with no listener side effects —
  portable for serverless. `src/server.js` is the only place that listens.
- All feature routes mount under **`/api`** (`API_PREFIX` in constants).
- One centralized API-key middleware gates everything except `GET /api/health`.

### Project structure

```text
├── src/
│   ├── app.js                     Express app factory (no listener)
│   ├── server.js                  Node HTTP entry (the only listener)
│   ├── config/                    env.js (validated env) + constants.js
│   ├── routes/                    All routers (health, home, search, anime,
│   │                              streaming, jikan, tmdb, auth)
│   ├── controllers/               HTTP-level handlers
│   ├── services/                  Business logic
│   ├── providers/                 anilist/, jikan/, tmdb/, megaplay/, anizip
│   │                              + http-client.js, base-provider.js, index.js
│   ├── cache/                     L1 memory-store, L2 supabase-store,
│   │                              cache-manager, request-coalescer
│   ├── identity/                  id-types.js + identity-resolver.js
│   ├── streaming/                 stream-resolver.js, proxy-playback.js
│   ├── normalizers/               canonical shapes + provider mappers/merges
│   ├── middleware/                api-key-auth, session, request-id/logger,
│   │                              error-handler, not-found
│   ├── errors/                    Typed error taxonomy (AppError + subclasses)
│   └── utils/                     logger, asyncHandler, html, url-redact
├── supabase/migrations/           cache_entries + user_profiles RLS SQL
├── tests/                         node:test suite (all mocked)
├── scripts/                       smoke + benchmark scripts
├── index.js                       Vercel entry (wraps createApp)
├── functions/api/[[route]].js     Cloudflare Pages Function adapter
├── vercel.json / wrangler.toml    deployment configs
└── .env.example                   annotated env template
```

---

## 3. Running locally

```bash
npm install
cp .env.example .env      # then fill in values (BACKEND_API_SECRET is mandatory)
npm run dev               # node --watch src/server.js -> http://localhost:8080
npm start                 # production-style start
npm test                  # full mocked test suite
node scripts/api-smoke.js # local smoke: app boots, main routes respond
```

Health check: `GET http://localhost:8080/api/health` (public, no key).

### Environment variables

Copy `.env.example` → `.env`. All variables are validated at startup
(`src/config/env.js`); the app fails fast with a clear message listing every
problem. Key variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development \| production \| test` |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Node server bind (ignored on serverless) |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins, or `*`. **Required as explicit origins when using cookie sessions.** |
| `BACKEND_API_SECRET` | *(empty)* | **Secret.** Required credential for every protected `/api/*` route. Missing value FAILS CLOSED (500) in every env, dev included. |
| `ANILIST_API_URL` | `https://graphql.anilist.co` | AniList endpoint |
| `JIKAN_API_URL` | `https://api.jikan.moe/v4` | Jikan endpoint |
| `TMDB_API_URL` | `https://api.themoviedb.org/3` | TMDB endpoint |
| `MEGAPLAY_API_URL` | `https://megaplay.buzz` | MegaPlay endpoint |
| `ANIZIP_API_URL` | `https://api.ani.zip` | AniZip endpoint |
| `MEGAPLAY_PROXY_URL` | *(empty)* | Optional playback proxy host; when set, `/api/stream/resolve/:id` returns frontend-safe proxy watch URLs |
| `TMDB_API_KEY` | *(empty)* | Secret. TMDB v3 key or v4 read token |
| `SUPABASE_URL` | *(empty)* | Supabase project URL (blank = L1-only cache) |
| `SUPABASE_SERVICE_ROLE_KEY` | *(empty)* | Secret. L2 **cache only** (bypasses RLS). Never for auth, never in frontend. |
| `SUPABASE_ANON_KEY` | *(empty)* | Secret. Used for ALL GoTrue auth calls (+ cache fallback) |
| `AUTH_COOKIES_ENABLED` | `true` | Also set HttpOnly session cookies on login/signup/refresh |
| `AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS` | `2592000` | Refresh cookie Max-Age (30 days) |
| `CACHE_DEFAULT_TTL_SECONDS` | `300` | Default cache TTL |
| `REQUEST_TIMEOUT_MS` | `10000` | Outbound provider timeout |
| `ENRICHMENT_TIMEOUT_MS` | `5000` | Bounded deadline for optional Jikan/TMDB details enrichment |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## 4. Deployment

**Vercel** — `vercel.json` routes all traffic to `index.js` (`@vercel/node`),
which imports `createApp()`. Set env vars in Project Settings → Environment
Variables, then redeploy.

**Cloudflare Pages** — `wrangler.toml` (`nodejs_compat`, compat date
2025-09-01). The `functions/api/[[route]].js` Pages Function serves `/api/*`.
Set variables in Settings → Variables and Secrets. Local emulation:
`npx wrangler pages dev`.

No local filesystem persistence, no WebSockets, no long-running processes —
stateless per request, safe for cold starts. The in-memory L1 cache is an
optimization only; correctness never depends on it.

---

## 5. API authentication (how to call the API)

Every `/api/*` route **except `GET /api/health`** is protected by one
centralized middleware (`src/middleware/api-key-auth.js`).

**Header format** (either; Bearer preferred):

```text
Authorization: Bearer <BACKEND_API_SECRET>
x-api-key: <BACKEND_API_SECRET>
```

Both headers may be sent together (independent candidates; at least one must
match). This lets the frontend proxy forward its own `x-api-key` **alongside**
a user session token in `Authorization: Bearer` on `/api/auth/*` requests.

**Optional `?api_key=` query parameter** — manual browser testing only, on an
approved allowlist of GET paths only (`/home`, `/search`, `/top-search`,
`/schedule`, `/category/:type`, `/details/:id`, `/smart/details/:id`,
`/episodes/:id`, `/recommendations/:id`, `/seasons/:id`, `/jikan/anime/:malId`,
`/jikan/from-anilist/:id`, `/tmdb/:id`). NOT approved on `/stream/resolve`
or any non-GET method. Header + query must be identical when both present
(conflict → 401). Query keys leak into logs/history — never ship them in
client code.

**Behavior:**

- Missing/invalid key → `401 { "error": { "code": "UNAUTHORIZED_ERROR", ... } }`
- Constant-time comparison (SHA-256 + `timingSafeEqual`)
- CORS `OPTIONS` preflights always pass through
- Fail-closed everywhere: no `BACKEND_API_SECRET` → every protected request
  gets `500` (no dev bypass)
- The query value is stripped before controllers/services/cache ever see it

**The key must NEVER live in the browser.** A `VITE_*`/`NEXT_PUBLIC_*` var is
public by definition. The frontend needs a **server-side proxy** (Next.js
route handler / Vercel Function / Pages Function) that stores the secret and
calls this backend. See §10.

---

## 6. Route catalog (complete)

All routes are mounted under **`/api`**. Auth requirement: 🔓 public,
🔐 API-key required, 👤 user session required.

### Health

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/health` | 🔓 | Liveness/readiness probe. No provider/cache calls. `{ status: "ok", ... }` |

### Home & discovery

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/home` | 🔐 | Homepage feed: `{ trending, popular, seasonal, topRated, top10 }` — arrays of normalized anime cards (AniList-backed, cached). `top10` is the dedicated Top 10 collection (topRated SCORE_DESC ranking, deduplicated by AniList ID, capped at 10; no extra provider call). A failing section is omitted, not fatal (Top 10 follows its topRated ranking source). |
| GET | `/api/schedule` | 🔐 | Airing schedule (AniList). Query: `from`/`to` (epoch seconds), `page`. Response: `{ window: { from, to }, pageInfo, results }`. Cached. |

### Search

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/search` | 🔐 | AniList search. Query: `q` (required, ≤200 chars), `page` (≤500), `perPage` (≤50), `season` (`WINTER\|SPRING\|SUMMER\|FALL`), `year`, `format` (`TV\|TV_SHORT\|MOVIE\|SPECIAL\|OVA\|ONA\|MUSIC`), `status` (`FINISHED\|RELEASING\|NOT_YET_RELEASED\|CANCELLED\|HIATUS`), `genre`, `sort` (e.g. `POPULARITY_DESC`, `SCORE_DESC`, `TRENDING_DESC`, ...). Response: `{ pageInfo, results }`. |
| GET | `/api/top-search` | 🔐 | Popularity-ranked trending suggestions for search bars. Cached array of normalized entries. |

### Anime details & metadata

`:id` is always the **AniList ID**.

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/details/:id` | 🔐 | Full details pipeline: AniList core + Jikan enrichment (`enrichment.jikan`) + TMDB visuals (`enrichment.tmdb`). Composite cache shared with `/smart/details/:id`. |
| GET | `/api/smart/details/:id` | 🔐 | Identical canonical payload as `/details/:id`; shares the same cache key (zero duplicate provider calls). |
| GET | `/api/episodes/:id` | 🔐 | Episode **metadata only** (Jikan episode list + AniZip). No stream URLs. `{ id, anilistId, malId, totalEpisodes, pageInfo, episodes }` — `episodes`/`pageInfo` are `null` when no trusted MAL mapping exists. Query: `page`. |
| GET | `/api/recommendations/:id` | 🔐 | AniList recommendations, rating-sorted, cached. Array of normalized entries. |
| GET | `/api/seasons/:id` | 🔐 | AniList relations (sequels/prequels), cached. |
| GET | `/api/category/:type` | 🔐 | Category listing. Valid types: special (`trending`, `popular`, `top`, `top rated`, `airing`, `upcoming`) + AniList genres (Action, Adventure, Comedy, Drama, Ecchi, Fantasy, Horror, Mahou Shoujo, Mecha, Music, Mystery, Psychological, Romance, Sci-Fi, Slice of Life, Sports, Supernatural, Thriller). Query: `page`, `perPage`. Response: `{ pageInfo, results }`. |

### Streaming

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/stream/resolve/:id` | 🔐 | Resolve a playable stream. `:id` = AniList ID. Query: `ep=1` (alias `episode=1`; `ep` wins), `language=sub\|dub`. Flow: MegaPlay by AniList ID → IdentityResolver → MegaPlay by MAL ID → none = 404. Playback URL is ALWAYS the frontend-safe proxy watch URL (`{MEGAPLAY_PROXY_URL}/watch/{resolvedId}?ep=..&lang=..&idType=anilist\|mal`) — direct MegaPlay URLs are never exposed. Response: `{ resolved, provider, idType, anilistId, malId, episode, language, sources, expiresAt, playbackUrl }`. Proxy unconfigured → typed `501 NOT_IMPLEMENTED`. Query `?api_key` is NOT accepted here. |

### Jikan (MAL) namespace

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/jikan/anime/:malId` | 🔐 | Jikan anime details **by MAL ID** (never converted). Normalized Jikan shape. |
| GET | `/api/jikan/from-anilist/:id` | 🔐 | AniList ID → IdentityResolver → MAL ID → Jikan. Unresolved mapping → `404` (`unresolved: true`) — no title search, no fuzzy matching. |

### TMDB

| Method | Path | Auth | Use |
| --- | --- | --- | --- |
| GET | `/api/tmdb/:id` | 🔐 | TMDB visual enrichment + media assets for an AniList ID. `{ resolved, tmdbId, mediaType, images, poster, reason, logo, backdrops, trailer, videos }`. Logo = best transparent PNG (language/quality ranked); `backdrops` = ranked high-quality landscape entries (w1280/original URLs, dimensions); `trailer` = preferred official YouTube trailer (`{ name, key, site, type, official, url, embedUrl }`, `null` when none); `videos` = bounded trailer/teaser list. Media assets degrade to `null`/`[]` on upstream failure — never fail the request. No confident match → `200` with `resolved: false` and all media fields `null` (never an error, never fabricated). Optional `?type=mal` resolves a MAL ID via the IdentityResolver first (unknown MAL ID → `404`). |

### User authentication (Supabase Auth)

All auth routes require the **API key** (they arrive through the trusted
proxy) plus a **user session** where noted. Session = `Authorization: Bearer
<accessToken>` (from login/signup/refresh body) or the HttpOnly cookies.

| Method | Path | Session | Body / notes | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/signup` | none | `{ email, password }` (password 8–128 chars) | `201 { user, session \| null, emailConfirmationRequired? }` — also sets cookies |
| POST | `/api/auth/login` | none | `{ email, password }` | `200 { user, session: { accessToken, refreshToken, tokenType, expiresIn, expiresAt } }` |
| POST | `/api/auth/logout` | 👤 token | (empty body) | `200 { ok: true }` — revokes session upstream + clears cookies; idempotent |
| GET | `/api/auth/me` | 👤 required | — | `200 { user }` — token verified upstream (`GET /auth/v1/user`), never decoded locally |
| POST | `/api/auth/refresh` | refresh token | `{ refreshToken }` or refresh cookie | `200 { user, session }` — rotates the session |
| POST | `/api/auth/password-reset` | none | `{ email }` | `200 { ok: true }` — uniform response (no user enumeration) |
| POST | `/api/auth/verify` | none | `{ type: 'signup'\|'recovery', token \| tokenHash, email? }` | `200 { user, session }` — exchanges one-time email link token |
| POST | `/api/auth/password-update` | 👤 required | `{ password }` | `200 { user }` |
| POST | `/api/auth/resend` | none | `{ email, type?: 'signup'\|'recovery' }` | `200 { ok: true }` — resends confirmation/recovery email |

**Session architecture:**

1. **Tokens in the JSON body (primary, universal).** Works from any
   domain/proxy. Store tokens client-side (or let the proxy hold them) and
   send `Authorization: Bearer <accessToken>` on session endpoints. On
   `AUTH_SESSION_EXPIRED`, refresh ONCE and retry, then log out.
2. **HttpOnly cookies (optional, same-site deployments).** When
   `AUTH_COOKIES_ENABLED=true`: `offanime_session` (access token, `Path=/`,
   lifetime = upstream `expires_in`) and `offanime_refresh` (refresh token,
   `Path=/api/auth`, 30 days). HttpOnly + Secure (production) + SameSite=Lax.
   Requires `CORS_ORIGIN` to list explicit frontend origins (wildcard CORS
   cannot send credentials). Cross-site cookies (`*.vercel.app` ↔ other
   domain) are dropped by Safari/modern Chrome — the token flow still works.

**Security:** tokens verified UPSTREAM with Supabase (no spoofable local JWT
decode; revocation is immediate). CSRF: state-changing cookie-based requests
must have `Origin`/`Referer` matching `CORS_ORIGIN` (403 otherwise); Bearer
requests are immune and skip the check. Passwords/tokens are never logged.

---

## 7. Response & error contracts

### Canonical anime shape

Every anime object (cards, details, lists) follows this normalized shape:

```json
{
  "id": 1,
  "anilistId": 1,
  "malId": 1,
  "title": { "romaji": "...", "english": "...", "native": "...", "userPreferred": "..." },
  "description": "cleaned plain text",
  "images": { "poster": "https://...", "cover": "https://...", "banner": "https://..." },
  "type": "ANIME",
  "format": "TV",
  "status": "FINISHED",
  "episodes": 26,
  "duration": 24,
  "season": "SPRING",
  "seasonYear": 1998,
  "genres": ["Action"],
  "studios": ["Sunrise"],
  "synonyms": ["..."],
  "startDate": "1998-04-03",
  "endDate": "1999-04-24",
  "averageScore": 86,
  "popularity": 200000,
  "relations": [{ "relationType": "SEQUEL", "anilistId": 2, "malId": 2, "title": "...", "images": { "poster": "..." } }],
  "source": { "anilist": true, "jikan": false, "tmdb": false }
}
```

- Missing optional fields → `null` / `[]` (never `undefined`, never a throw).
- `enrichment.jikan` (background, trailer, MAL rating/rank/members, themes,
  demographics, producers, aired, sourceMaterial) and `enrichment.tmdb`
  (`{ tmdbId, mediaType }`) are namespaced and never overwrite AniList data.
- Banner precedence: AniList `bannerImage` → TMDB backdrop/banner (only when
  AniList has none) → `null`. A poster is never turned into a banner.

### Error shape (stable, machine-readable)

```json
{ "error": { "code": "NOT_FOUND", "message": "..." } }
```

| Code | HTTP | Class | Meaning |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | `ValidationError` | Bad ID / missing query / invalid filter |
| `UNAUTHORIZED_ERROR` | 401 | `UnauthorizedError` | Missing/invalid API key |
| `AUTH_INVALID_CREDENTIALS` | 401 | `InvalidCredentialsError` | Login rejected by Supabase |
| `AUTH_SESSION_EXPIRED` | 401 | `SessionExpiredError` | Refresh once and retry, then log out |
| `FORBIDDEN_ERROR` | 403 | `ForbiddenError` | CSRF/origin rejection |
| `AUTH_EMAIL_NOT_CONFIRMED` | 403 | `EmailNotConfirmedError` | Account exists, email unconfirmed |
| `NOT_FOUND` | 404 | `NotFoundError` | Resource / mapping / stream doesn't exist |
| `AUTH_EMAIL_TAKEN` | 409 | `EmailTakenError` | Signup with registered email |
| `RATE_LIMIT_ERROR` | 429 | `RateLimitError` | Upstream (or this API) rate limiting |
| `NOT_IMPLEMENTED` | 501 | `NotImplementedError` | Reserved route / playback proxy unconfigured |
| `PROVIDER_ERROR` | 502 | `ProviderError` | Upstream (AniList/Jikan/TMDB/MegaPlay/GoTrue) failure |
| `AUTH_PROVIDER_ERROR` | 502 | `AuthProviderError` | GoTrue down/unexpected |
| `TIMEOUT_ERROR` | 504 | `TimeoutError` | Upstream exceeded timeout |
| `CACHE_ERROR` | 500 | `CacheError` | Cache layer failure (degrades to provider) |
| `INTERNAL_ERROR` | 500 | `InternalError` | Unexpected failure |

Provider failures are **typed errors, never cached**; services serve
**stale-if-error** data from cache instead. A provider outage degrades to
stale data, never an empty website.

---

## 8. Caching

Two tiers with `CacheManager.getOrLoad(key, loader)`:

```text
Fresh L1 (in-memory)     -> return
Fresh L2 (Supabase)      -> promote to L1, return
Load via provider (coalesced)
  success + valid   -> write L1 (+L2), return
  failure / invalid -> serve STALE (L1, then L2) if within stale_until
  nothing stale     -> propagate the typed error
```

- TTL presets: SHORT 60s (streams/feeds), MEDIUM 300s (search/listings),
  LONG 1h (details), DAY 24h (metadata). Streams: valid 5 min, no-result 60s.
- Failures and malformed payloads are NEVER cached as valid values.
- `RequestCoalescer` shares one in-flight promise per key (N concurrent
  identical requests → 1 provider call).
- L2 = Supabase table `cache_entries` (namespace + cache_key unique, jsonb
  value, `expires_at`/`stale_until`), atomic upserts via PostgREST. Apply
  `supabase/migrations/*.sql` once in the Supabase SQL editor. Blank Supabase
  env → L1-only operation, fully functional.
- Namespace-safe keys: `anilist:anime:123` ≠ `jikan:anime:123` ≠
  `tmdb:visual:anilist:123`.

---

## 9. Observability

Structured JSON logs to stdout (zero dependencies): every line has `ts`,
`level`, `msg`, plus context (`requestId`, `provider`, `layer`, latency,
status). Each response carries an `x-request-id`. Filter with `LOG_LEVEL`.
Secrets, tokens, passwords, and API keys are redacted from logs and error
messages (`src/utils/url-redact.js`).

---

## 10. Connecting the frontend

### The architecture

```text
Browser (offanime.cc)
   │  fetch to PUBLIC base URL only — never holds any secret
   ▼
Frontend server-side proxy  (Next.js route handler / Vercel Function / Pages Function)
   │  adds  Authorization: Bearer <BACKEND_API_SECRET>   (kept server-side)
   │  forwards only whitelisted /api/* paths (never an open proxy)
   ▼
OffAnime Backend  (Vercel / Cloudflare)
   ▼
AniList · Jikan · TMDB · AniZip · MegaPlay · Supabase
```

Rules:

1. `BACKEND_API_SECRET` and the private backend base URL live ONLY in the
   proxy's server environment. Browser code knows the public proxy URL only.
2. The proxy must be **route-restricted** — forward only the intended `/api/*`
   paths and methods.
3. For cookie-based sessions, the proxy must pass `Cookie` / `Set-Cookie`
   headers through unchanged, and `CORS_ORIGIN` on the backend must list the
   frontend origins explicitly.
4. Auth requests go through the same proxy (it adds the API key). A user
   session token is never a substitute for the API key and vice versa.

### Example proxy (Node/Vercel Function)

```js
// /api/[...path].js — frontend proxy (server-side, has the secret)
const BACKEND_URL = process.env.OFFANIME_BACKEND_URL; // e.g. https://offanime-backend.vercel.app
const API_SECRET = process.env.BACKEND_API_SECRET;    // same value as backend env

const ALLOWED = /^\/(health|home|schedule|search|top-search|details|smart\/details|episodes|recommendations|seasons|category|stream\/resolve|jikan|tmdb|auth)(\/|$)/;

export default async function handler(req, res) {
  const path = req.url.replace(/^\/api/, '');
  if (!ALLOWED.test(path)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not allowed' } });

  const upstream = await fetch(`${BACKEND_URL}/api${path}`, {
    method: req.method,
    headers: {
      // Forward cookies (for /api/auth/* session endpoints)...
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      // ...pass through the user's Bearer token if present (never treated as the API key)...
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      // ...and identify the trusted proxy with the API key.
      'x-api-key': API_SECRET,
      'content-type': 'application/json',
    },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
  });

  res.status(upstream.status);
  const setCookie = upstream.headers.get('set-cookie');
  if (setCookie) res.setHeader('set-cookie', setCookie);
  res.json(await upstream.json());
}
```

### Example client (browser)

```js
const API = 'https://your-frontend.dev/api'; // the proxy, not the backend

// Public-shaped data calls (the proxy injects the API key)
const home = await fetch(`${API}/home`).then(r => r.json());
const details = await fetch(`${API}/details/21`).then(r => r.json());
const search = await fetch(`${API}/search?q=frieren&page=1&perPage=20`).then(r => r.json());
const episodes = await fetch(`${API}/episodes/21`).then(r => r.json());
const stream = await fetch(`${API}/stream/resolve/21?ep=1&language=sub`).then(r => r.json());
// play stream.playbackUrl in the player (frontend-safe proxy watch URL)

// Auth cycle (token flow — universal, works from any domain)
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).then(r => r.json());

// Store login.session.accessToken / refreshToken (memory or httpOnly cookie via proxy)
const me = await fetch(`${API}/auth/me`, {
  headers: { authorization: `Bearer ${login.session.accessToken}` },
}).then(r => r.json());

// Proactive refresh: token expires at login.session.expiresAt (epoch seconds).
// On 401 AUTH_SESSION_EXPIRED: refresh ONCE, retry, otherwise log out.
const refreshed = await fetch(`${API}/auth/refresh`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ refreshToken: login.session.refreshToken }),
}).then(r => r.json());
```

### CORS notes

- `CORS_ORIGIN=*` (default) → wildcard, credentials disabled. Fine for the
  token/Bearer flow through the proxy.
- Cookie sessions → set `CORS_ORIGIN=https://offanime.cc,https://www.offanime.cc`
  (explicit list enables `credentials: true`). Wildcard + credentials is
  forbidden by spec and intentionally not supported.

### Quick backend self-test (no frontend needed)

```bash
curl http://localhost:8080/api/health
curl -H "Authorization: Bearer $BACKEND_API_SECRET" http://localhost:8080/api/home
curl -H "x-api-key: $BACKEND_API_SECRET" "http://localhost:8080/api/details/21"
curl "http://localhost:8080/api/search?q=frieren&api_key=$BACKEND_API_SECRET"   # approved GET path
```

---

## 11. Testing & smoke scripts

```bash
npm test                               # full suite (330+ mocked tests)
node scripts/api-smoke.js              # local: app boots, main routes respond
node scripts/anilist-smoke.js          # live AniList
node scripts/jikan-smoke.js 5114       # live Jikan (real MAL ID)
node scripts/tmdb-smoke.js "Title"     # live TMDB (requires TMDB_API_KEY)
node scripts/supabase-smoke.js         # live Supabase (requires config + migration)
node scripts/megaplay-smoke.js 101922 1 sub  # live MegaPlay
node scripts/benchmark-details.js      # details pipeline benchmark
```

---

## 12. Key conventions to respect when extending

1. **IDs:** `:id` = AniList ID everywhere except `/api/jikan/anime/:malId`.
   Never guess IDs; only the IdentityResolver maps namespaces.
2. **Layers:** routes stay thin; no provider logic in controllers; no
   `process.env` outside `config/env.js` (add new vars to the schema +
   `.env.example`).
3. **Errors:** throw typed errors from `src/errors`; never convert failures to
   `[]` or fake data; never cache failures.
4. **Secrets:** server-side only, never logged, never in URLs (except the
   documented restricted `?api_key=` testing exception).
5. **Streaming:** direct MegaPlay URLs are never exposed; playback always goes
   through `MEGAPLAY_PROXY_URL`.
6. **Supabase keys:** anon key for auth; service-role key for the cache table
   only; forward the user's token for user-owned data so RLS applies.
