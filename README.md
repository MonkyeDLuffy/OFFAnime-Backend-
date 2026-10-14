# OffAnime Backend

Modular, cache-first, serverless-friendly backend for **OffAnime.cc**.

**Status: Phase 9 (integration, QA & deployment hardening) complete.**
All 15 frontend routes are LIVE and exercised by mocked endpoint tests;
AniList, Jikan, identity-resolution, TMDB visual-enrichment, the persistent
L2 cache, and the MegaPlay streaming resolver are fully implemented.

## Quick start

```bash
npm install
cp .env.example .env   # fill in values as later phases need them
npm run dev            # http://localhost:8080/api/health
npm test               # node:test suite (330 mocked tests - no live providers)
node scripts/api-smoke.js   # local smoke: app boots, main routes respond
```

## Why this architecture

The old backend concentrated routes, providers, business logic, caching,
streaming, ID conversion, and error handling in one giant `server.js`. This
project is the opposite: every module has one responsibility, and the layers are
strictly separated:

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

## Project structure

```text
├── src/
│   ├── app.js                     Express app factory (no listener - portable)
│   ├── server.js                  Node HTTP entry (the ONLY place that listens)
│   ├── config/
│   │   ├── env.js                 Validated env config (fail-fast, frozen)
│   │   └── constants.js           Stable constants (providers, ID types, TTLs)
│   ├── routes/                    All 15 frontend contract routes
│   ├── controllers/               HTTP-level handlers
│   ├── services/                  Business logic (all frontend services live)
│   ├── providers/
│   │   ├── http-client.js         Portable fetch wrapper (timeout, typed errors)
│   │   ├── base-provider.js       Shared provider behavior
│   │   ├── anilist/               AniList (primary identity) - LIVE
│   │   ├── jikan/                 Jikan (MAL-keyed extras) - LIVE
│   │   ├── tmdb/                  TMDB (visuals only) - LIVE
│   │   ├── megaplay/              MegaPlay (primary streaming) - LIVE
│   │   └── index.js               Provider registry
│   ├── cache/
│   │   ├── cache-store.js         Storage interface (fresh/stale contract)
│   │   ├── memory/memory-store.js L1 in-memory store (real, ephemeral)
│   │   ├── supabase/supabase-store.js  L2 persistent store (LIVE; L1-only until env vars set)
│   │   ├── cache-manager.js       Two-tier orchestration + stale-if-error
│   │   └── request-coalescer.js   De-duplicates concurrent identical requests
│   ├── identity/
│   │   ├── id-types.js            Pure ID validation + normalized identity
│   │   └── identity-resolver.js   AniList <-> MAL mapping (LIVE)
│   ├── streaming/
│   │   └── stream-resolver.js     MegaPlay resolution flow (LIVE)
│   ├── normalizers/
│   │   └── anime.normalizer.js    Canonical anime shape + provider mappers
│   ├── middleware/                requestId, requestLogger, notFound, errors
│   ├── errors/                    Typed error taxonomy (AppError + subclasses)
│   └── utils/                     logger, asyncHandler
├── tests/                         node:test suite
├── package.json
├── .env.example
└── README.md
```

## API contracts (frontend)

All routes are mounted under `/api`. Phase 7 status:

| Route | Status | Notes |
| --- | --- | --- |
| `GET /api/health` | **Live** - liveness probe | No provider/cache calls |
| `GET /api/home` | **Live** | AniList-backed sections (trending/popular/seasonal/topRated), cached |
| `GET /api/search` | **Live** | AniList primary search; `q`, `page`, `perPage`, `season`, `year`, `format`, `status`, `genre`, `sort` |
| `GET /api/details/:id` | **Live** | Full pipeline: AniList + Jikan enrichment + TMDB visuals, composite cache |
| `GET /api/smart/details/:id` | **Live** | Same canonical payload as `/details/:id`; shares the identical cache key |
| `GET /api/episodes/:id` | **Live** | Episode METADATA only (no MegaPlay, no stream URLs) |
| `GET /api/stream/resolve/:id` | **Live** | MegaPlay streaming; `?episode=1&language=sub\|dub`; AniList ID -> MegaPlay -> MAL fallback; playback via the configured proxy (`MEGAPLAY_PROXY_URL`) |
| `GET /api/jikan/anime/:malId` | **Live** | Jikan secondary namespace (`malId` only - never converted) |
| `GET /api/jikan/from-anilist/:id` | **Live** | AniList ID -> IdentityResolver -> MAL ID -> Jikan; unresolved mapping -> 404 |
| `GET /api/recommendations/:id` | **Live** | AniList recommendations (rating-sorted), cached |
| `GET /api/seasons/:id` | **Live** | AniList relations (sequels/prequels), cached |
| `GET /api/category/:type` | **Live** | Genre + special categories, validated types, `page`/`perPage` |
| `GET /api/top-search` | **Live** | Popularity-ranked AniList suggestions, cached |
| `GET /api/schedule` | **Live** | AniList airing schedule; `from`/`to` (epoch seconds), `page`; cached |
| `GET /api/tmdb/:id` | **Live** | TMDB visual enrichment for an AniList ID; unresolved match -> 200 |

`501` responses (reserved for any future unimplemented route) use the standard
error shape (below) with `code: "NOT_IMPLEMENTED"` - reserved routes never
return fake or empty data.

**CRITICAL:** on every AniList-based route (`/details`, `/smart/details`,
`/episodes`, `/recommendations`, `/seasons`, `/tmdb`, `/jikan/from-anilist`),
the `:id` path parameter is the **AniList ID** - never a MAL ID, never a TMDB
ID. Any AniList -> MAL mapping is performed by the identity layer.

### Response overview

- `/api/home` -> `{ trending: [...], popular: [...], seasonal: [...], topRated: [...] }`
  (each section an array of normalized anime cards; a failing section is
  omitted rather than emptying the whole page).
- `/api/search`, `/api/category/:type` -> `{ pageInfo: {...}, results: [...] }`
  (normalized anime cards).
- `/api/details/:id` (and `/smart/details/:id`) -> canonical anime shape
  (below) with namespaced `enrichment.jikan` / `enrichment.tmdb` data.
- `/api/episodes/:id` -> `{ id, anilistId, malId, totalEpisodes, pageInfo, episodes }`;
  `episodes`/`pageInfo` are `null` when no trusted MAL mapping exists (never
  fake episodes).
- `/api/recommendations/:id`, `/api/seasons/:id`, `/api/top-search` ->
  arrays of normalized entries with AniList IDs.
- `/api/schedule` -> `{ window: { from, to }, pageInfo, results: [...] }`
  (normalized airing entries; AniList airing times only).
- `/api/jikan/anime/:malId`, `/api/jikan/from-anilist/:id` -> normalized Jikan
  shape (`malId` only - never converted into `id`/`anilistId`).
- `/api/tmdb/:id` -> visual enrichment result
  (`{ resolved, tmdbId, mediaType, images, poster, reason }`); a missing
  confident match is `resolved: false` - never a failure, never fabricated
  images.

## API key protection

Every `/api/*` route **except `GET /api/health`** is protected by ONE centralized
middleware (`src/middleware/api-key-auth.js`), registered once in
`src/routes/index.js` before all feature routers - controllers never duplicate
credential checks.

**Public routes (no key required):**

- `GET /api/health` - intentional decision: deployment/uptime probes (Vercel,
  Cloudflare, monitoring) cannot carry secrets, and the endpoint leaks no
  sensitive data (static status payload only). CORS `OPTIONS` preflight
  requests are also never blocked (browsers cannot attach custom headers to a
  preflight; the middleware passes them through before any credential check).

**Protected routes:** everything else under `/api` (`/home`, `/search`,
`/top-search`, `/details`, `/smart/details`, `/episodes`, `/stream/resolve`,
`/jikan/*`, `/tmdb`, `/recommendations`, `/seasons`, `/category`, `/schedule`).

**Request header format** (either one; Bearer is preferred):

```text
Authorization: Bearer <BACKEND_API_SECRET>
x-api-key: <BACKEND_API_SECRET>
```

**Behavior:**

- Missing or invalid key -> `401` with the standard error shape
  (`{ "error": { "code": "UNAUTHORIZED_ERROR", "message": "..." } }`).
- Comparison is constant-time (SHA-256 digests + `timingSafeEqual`).
- The secret comes ONLY from the server-side env var `BACKEND_API_SECRET`
  (`src/config/env.js`). It is never hardcoded, never returned in a response,
  never logged, and never placed in URLs or query params.
- **Fail closed everywhere (dev included):** a missing `BACKEND_API_SECRET`
  rejects every protected request with `500` ("API authentication is not
  configured") in ALL environments - there is no development bypass. Local
  development must set a value in `.env`, exactly like production does on the
  platform dashboard.

### Environment configuration

Generate a long, cryptographically random secret (never reuse an example or a
real value in logs):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

- **Backend - local:** put the value in `.env` as `BACKEND_API_SECRET=...`
  (`.env` is gitignored; see `.env.example`).
- **Backend - Vercel:** Project Settings -> Environment Variables ->
  `BACKEND_API_SECRET` (all environments), then redeploy.
- **Backend - Cloudflare Pages:** Settings -> Variables and Secrets ->
  `BACKEND_API_SECRET` (encrypted), then redeploy. `process.env` is
  auto-populated from Pages variables (compat date >= 2025-04-01).

### Frontend: the key must NEVER live in the browser

A key placed in a browser-facing `.env` (e.g. `VITE_*`/`NEXT_PUBLIC_*`) is
**public** - it ships to every visitor. OffAnime's frontend is a separate,
statically-deployed site, so this backend repo cannot hide a private key on
its behalf:

- The frontend repo needs a **server-side proxy** (e.g. Next.js server route /
  Vercel Function / Pages Function) that keeps `BACKEND_API_SECRET` and the
  private backend base URL in ITS OWN server environment, adds
  `Authorization: Bearer <BACKEND_API_SECRET>` when calling this backend, and
  exposes only the public proxy URL to browser code.
- Browser code should know the public backend/proxy base URL only. The secret
  must never appear in client bundles, HTML, JS, URLs, or query params.
- If such a proxy is NOT built, browser access to protected endpoints will
  correctly fail with `401` - that is the protection working as designed.
- A proxy must be route-restricted (forward only the intended `/api/*` paths
  and methods), never an arbitrary-URL forwarder (no open proxy).

## Identity system (critical)

AniList IDs and MyAnimeList (MAL) IDs are **different namespaces**. They are
never silently converted into one another, and a MAL ID is never stored as an
`anilistId`. The normalized identity shape used everywhere:

```json
{ "id": 123, "anilistId": 123, "malId": 456 }
```

When a MAL ID is unknown: `{ "id": 123, "anilistId": 123, "malId": null }`.
`id` mirrors the AniList ID (the primary identity) and is never populated from a
MAL ID. All AniList <-> MAL mapping lives in `src/identity` - no other layer
converts between namespaces.

## Cache architecture

Two tiers, with L1 as a performance optimization only:

- **L1 - in-memory** (`memory/memory-store.js`): fast, per-instance, ephemeral.
  A cold start starts empty, and the backend remains fully correct with an
  empty L1.
- **L2 - Supabase** (`supabase/supabase-store.js`): persistent and shared
  across instances. Stub in Phase 1; the manager auto-runs L1-only until the
  Supabase env vars are configured and the store is implemented.

`CacheManager.getOrLoad(key, loader)` implements the resilience strategy:

```text
Fresh L1 -> return
Fresh L2 -> promote to L1, return
Load via provider (coalesced)
  success + valid   -> write L1 (+L2), return
  failure / invalid -> serve STALE (L1, then L2) if available
  nothing stale     -> only then propagate the error
```

**Hard rule:** provider failures and invalid/empty responses are NEVER cached as
if they were valid. A provider outage degrades to stale data, never to an empty
website. Cross-instance correctness comes from L2, never from process memory.

## Request coalescing

`RequestCoalescer` shares one in-flight promise per key, so N concurrent
identical requests trigger one provider call. It is an optimization, not a
correctness dependency: it only works within a single instance; cross-instance
de-duplication is L2's job.

## Error handling

Typed taxonomy in `src/errors` (all extend `AppError`):

`ValidationError` (400), `NotFoundError` (404), `NotImplementedError` (501),
`ProviderError` (502), `TimeoutError` (504), `RateLimitError` (429),
`CacheError` (500), `InternalError` (500).

Error responses use a stable machine-readable shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "..." } }
```

Provider failures are typed errors - services decide whether to serve stale
cache instead of erroring; the error handler only formats what has already
bubbled up. It never hides failures behind generic `[]` responses.

## Observability

Structured JSON logs to stdout (zero dependencies, no local files - serverless
platforms capture stdout). Every line has `ts`, `level`, `msg` plus context
(`requestId`, `provider`, `layer`, latency, status...), so provider failures,
cache hit/miss, and resolution failures are all traceable. Level-filtered via
`LOG_LEVEL`.

## Streaming (implemented flow, Phase 8)

`StreamResolver` (src/streaming/stream-resolver.js) implements:

```text
AniList ID  (:id on /api/stream/resolve/:id is ALWAYS an AniList ID)
  -> MegaPlay /stream/ani/{anilistId}/{ep}/{lang}   (primary path)
       usable stream -> return normalized stream
       genuine no-stream (404 / explicit no-stream / empty sources / malformed)
  -> IdentityResolver.resolveAniListToMal(anilistId)
  -> MegaPlay /stream/mal/{malId}/{ep}/{lang}       (fallback path)
       usable stream -> return normalized stream
  -> none -> NotFoundError (unresolved; NEVER a fabricated URL)
```

- Playback (Phase 10A): MegaPlay is NEVER played directly from the frontend.
  When the playback proxy is configured (`MEGAPLAY_PROXY_URL`), the response
  contains a frontend-safe playback URL built by the isolated
  `proxy-playback.js` module:
  `{MEGAPLAY_PROXY_URL}/watch/{resolvedId}?ep={episode}&lang={language}&idType={anilist|mal}`
  (AniList IDs use `idType=anilist`; MAL IDs use `idType=mal` - the resolved
  MAL ID from the IdentityResolver, never the AniList ID). The proxy host is
  never hardcoded in provider/business logic. When the proxy is NOT
  configured, the resolution/availability detection still runs, and playback
  requests fail with a clear typed configuration error
  (`501 NOT_IMPLEMENTED`, `proxyConfigured: false`) instead of exposing a
  direct MegaPlay URL.
- Every playback URL is built from the ALREADY-RESOLVED id/episode/language -
  no fabricated URLs, no title-derived URLs, no guessed provider IDs.
- Live-verified: MegaPlay serves a MISSING stream as HTTP 200 + an HTML
  "Error - MegaPlay" page carrying "Error Code: 410". The normalizer
  classifies such pages as a genuine no-stream (`reason: "not_found"`) - the
  MAL fallback is then attempted, and an error page is NEVER exposed as a
  playable stream. HTML pages without real player markup are never treated
  as playable streams.
- NO title search, no fuzzy matching, no Jikan title fallback, no random
  numeric ID conversion, no alternate streaming providers.
- Provider failures (timeout/429/500/network) remain typed errors and are
  NEVER cached; genuine no-stream results are cached briefly (`usable: false`,
  60s) and clearly distinguishable from a real stream.
- Valid streams use a conservative SHORT TTL (5 min), capped by explicit
  provider expiry metadata when present.
- Namespace-safe cache keys:
  `stream:megaplay:anilist:{id}:episode:{ep}:language:{lang}` and
  `stream:megaplay:mal:{id}:episode:{ep}:language:{lang}`.
- The response carries `{ resolved, provider, idType, anilistId, malId,
  episode, language, sources, expiresAt }`; `malId` comes ONLY from the
  IdentityResolver (or null) - the AniList ID is never reused as a MAL ID.

### Tests

```bash
npm test                              # full suite (330 tests, all mocked)
node scripts/api-smoke.js             # local smoke: app boots, routes respond
node scripts/anilist-smoke.js         # manual live smoke (real AniList)
node scripts/jikan-smoke.js 5114      # manual live smoke (real MAL ID)
node scripts/tmdb-smoke.js "Title"    # manual live smoke (requires TMDB_API_KEY)
node scripts/supabase-smoke.js        # manual live smoke (requires config + migration)
node scripts/megaplay-smoke.js 101922 1 sub   # manual live smoke (real MegaPlay)
```

## Deployment readiness (Vercel / Cloudflare)

- `src/app.js` is a **factory** with no listener side effects; `src/server.js`
  is the only listener. A serverless adapter imports `createApp()` (or reuses
  controllers/services directly) without touching Node-specific code.
- No local filesystem persistence, no local DBs, no long-running processes, no
  fixed IPs, no WebSockets. Stateless per request.
- Providers use global `fetch` + `AbortController` (portable across Node 18+,
  Vercel, and Cloudflare Workers - no `axios`, no `node:http` in the request
  path).
- Environment-variable driven and validated at startup with clear failures;
  secrets stay server-side and are redacted from diagnostics.
- Memory cache is explicitly non-essential to correctness (L2 + providers carry
  that), so cold starts and instance churn are safe.

## Environment variables

See `.env.example` for the full annotated list. New variables must be added to
the schema in `src/config/env.js` (the app fails fast with a clear message if a
required variable is missing). Never commit real secrets; `.env` is gitignored.

Key variables for API protection (see "API key protection" above):

- Backend (server-side only): `BACKEND_API_SECRET` - the credential every
  protected `/api/*` request must present. Fail closed in production when
  missing.
- Frontend server-side proxy runtime (only once the proxy exists):
  `BACKEND_API_SECRET` (same value) plus the private backend base URL.
- Frontend browser: the public backend/proxy base URL only - never the secret.

## Phase 2 — AniList

### Role

AniList is the **primary identity/source layer**: AniList ID, MAL ID (via
`idMal`), titles, description, poster/cover, format, status, episodes,
duration, season/year, genres, relations, and dates. Jikan adds richer details
and TMDB adds banners in later phases, keeping AniList call volume low.

### Provider architecture

```text
AniList API (GraphQL, single endpoint)
   ↓
AnilistProvider      src/providers/anilist/anilist.provider.js
                     (queries in anilist.queries.js, executed via the shared
                      Phase 1 HTTP client - no SDK, no second HTTP client)
   ↓                 raw AniList payloads
normalizeAnilist*    src/normalizers/anime.normalizer.js
   ↓                 canonical anime objects
Anime service        src/services/anime.service.js
                     (cacheManager.getOrLoad -> caches CANONICAL data;
                      failures are never cached; stale-if-error applies)
```

Provider methods (all raw-payload returning, stateless, request-scoped):

| Method | Purpose |
| --- | --- |
| `getAnimeById(anilistId)` | Full raw `Media` by AniList ID |
| `getAnimeByMalId(malId)` | Raw `Media` via AniList's `idMal` (identity phase uses this) |
| `searchAnime(query, options)` | Search + page/perPage/season/year/format/status/genre/sort |
| `getRelations(anilistId)` | Related anime |
| `getRecommendations(anilistId, opts)` | Recommended anime (rating-sorted) |
| `getSeasonalAnime(opts)` | Seasonal listing |
| `getAiringSchedule(opts)` | Airing schedule for an epoch window |

Every request POSTs a GraphQL document requesting **only the fields the app
needs**, carries a timeout (shared HTTP client), and maps failures onto typed
errors: `ValidationError` (bad ID), `NotFoundError` (missing media - HTTP 404
or `Media: null`), `TimeoutError`, `RateLimitError` (429), `ProviderError`
(other API/transport failures, including GraphQL `errors` in HTTP 200).
Failures are never swallowed and never cached; no retries (rate limits would
get worse - resilience is the cache layer's job via stale-if-error).

### Canonical anime shape

Produced by `normalizeAnilistAnime` (see `src/normalizers/anime.types.js`):

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

Defensive rules: missing optional fields become `null` / `[]` (never
`undefined`, never a throw); descriptions are HTML-cleaned via a small
dependency-free utility (`src/utils/html.js`) that strips tags, decodes
entities, and unwraps AniList `~!spoiler!~` markers while preserving text;
titles preserve all variants with a sensible `userPreferred` fallback;
`banner` is only AniList's genuine `bannerImage` (never a disguised poster);
partial dates stay honest (`"YYYY"`, `"YYYY-MM"`). A malformed payload itself
(missing id) throws `ProviderError`.

### ID rules (critical)

- AniList `id` and MAL `idMal` are different namespaces.
- `id === anilistId` always; `id` is never populated from a MAL ID.
- `malId` may be `null`; IDs are only taken from trusted provider payloads -
  never guessed in either direction.
- Full AniList ↔ MAL resolution belongs to the identity layer (later phase);
  the provider only exposes the raw `idMal` lookup.

### Tests

```bash
npm test                        # full suite (51 tests, all mocked - no live API)
node scripts/anilist-smoke.js   # manual live smoke test against real AniList
```

Unit tests mock HTTP via `tests/helpers/mock-fetch.js` (real `Response`
objects, AbortSignal-correct timeouts). Covered: normalizer (all defensive
cases, HTML cleanup, ID rules), provider (success/not-found/invalid/timeout/
429/failure/malformed), and the service flow (canonical caching, failures
never cached, stale-if-error, request coalescing).

### Later connection

`getAnimeDetails`/`searchAnime` in `src/services/anime.service.js` already run
through the Phase 1 cache manager (L1 memory now; L2 Supabase plugs in without
changes). The frontend routes `/api/details/:id` and `/api/search` will simply
call these services in a later phase.

## Phase 3 — Jikan

### Role

Jikan (MyAnimeList's API) is the **secondary metadata/enrichment source**: it
provides richer MAL metadata that the merge layer attaches to the canonical
anime WITHOUT touching AniList's primary identity. AniList remains the primary
identity/source layer. Jikan is keyed by **MAL IDs** - a `mal_id` is never
reinterpreted as an AniList ID.

### Provider architecture

```text
Jikan API (REST, v4)
   ↓
JikanProvider        src/providers/jikan/jikan.provider.js
                     (endpoints in jikan.queries.js, executed via the shared
                      Phase 1 HTTP client - no SDK, no second HTTP client)
   ↓                 raw Jikan payloads
normalizeJikan*      src/normalizers/anime.normalizer.js
   ↓                 stable secondary representation (jikan.types.js)
Jikan service        src/services/jikan.service.js
                     (cacheManager.getOrLoad -> caches NORMALIZED data)
mergeJikanIntoCanonical   src/normalizers/anime.merge.js (enrichment)
```

Provider methods (raw-payload returning, stateless, request-scoped):

| Method | Purpose |
| --- | --- |
| `getAnimeByMalId(malId, { full })` | Raw anime object via `/anime/{id}/full` (richer; `full: false` uses the basic endpoint) |
| `searchAnime(query, { page, limit })` | Raw search payload via `/anime?q=...` (limit capped at Jikan's max of 25) |

Error mapping (same taxonomy as AniList): invalid MAL ID/pagination ->
`ValidationError` (zero, negative, decimal, NaN, `"123abc"` are all rejected,
never coerced); unknown anime -> `NotFoundError`; 429 -> `RateLimitError`;
timeout -> `TimeoutError`; 5xx/network/malformed -> `ProviderError`. Failures
are never swallowed, never cached, never converted to `[]`. No automatic
retries; stale-if-error in the cache layer provides resilience.

### Normalized Jikan shape

Produced by `normalizeJikanAnime` (see `src/normalizers/jikan.types.js`):
`malId` (ONLY - no `id`, no `anilistId`), `title` (`default/english/japanese/
synonyms`), `type`, `sourceMaterial` (Jikan's adaptation source, renamed to
avoid colliding with provenance `source`), `episodes`, `status`, `airing`,
`aired` (`from`/`to`), `duration`, `rating`, `score` (MAL 0-10 scale),
`scoredBy/rank/popularity/members/favorites`, cleaned `synopsis`/`background`,
`season/year`, `genres/themes/demographics/studios/producers`, `images`
(`poster/large/small` - never a fake banner), `trailer`
(`youtubeId/url/embedUrl` or `null` - never fabricated), and provenance
`source: { anilist: false, jikan: true, tmdb: false }`.

Defensive rules: missing optional fields become `null`/`[]` (never
`undefined`, never a throw); malformed payloads lacking a valid `mal_id` throw
`ProviderError`; search pages missing their `data` array also throw so the
service never caches them as valid empty results.

### AniList-vs-Jikan precedence (explicit, documented)

`mergeJikanIntoCanonical` (src/normalizers/anime.merge.js) enforces:

- **AniList ALWAYS wins** (never overwritten): `id`, `anilistId`,
  `title.userPreferred`, `title.romaji`, description, poster, cover,
  **banner (NEVER from Jikan - no fake banners)**, format, status, episodes,
  genres/studios/synonyms lists (unless empty), relations, dates,
  `averageScore`/`popularity` (scales differ - AniList 0-100 vs MAL 0-10 - so
  Jikan's score is never merged into canonical scores).
- **Jikan may FILL only null/empty values**: `malId` (Jikan is MAL-keyed, so
  trusted), title english/native variants, description, poster/cover,
  status/episodes/format, season/seasonYear, empty lists.
- **Jikan-only details live namespaced** under `enrichment.jikan`
  (background, trailer, rating, rank, members, favorites, themes,
  demographics, producers, aired, sourceMaterial, score) so nothing can
  silently overwrite AniList data.

### Cache behavior

`getAnimeByMalId`/`searchAnime` in `src/services/jikan.service.js` use the
Phase 1 cache manager: normalized (never raw) data is cached, failures and
malformed responses are never cached, stale-if-error serves stale data when
Jikan is down, and concurrent identical requests coalesce into one call.

### Tests

```bash
npm test                          # full suite (100 tests, all mocked)
node scripts/jikan-smoke.js 5114  # manual live smoke test (real MAL ID required)
```

Covered: MAL ID validation (all invalid forms), provider success/errors (404,
429, timeout, 500, network, malformed), normalizer (complete/missing/partial
fields, identity safety: no `id === malId`, no `anilistId === malId`), merge
precedence rules (identity preserved, banner never faked, scores not merged
across scales, purity), and the cache/service flow (hit/miss, failures not
cached, stale-if-error, coalescing).

## Phase 4 — Identity Resolver

The critical infrastructure layer for the future MegaPlay streaming fallback:
reliably resolves `AniList ID <-> MAL ID` without ever confusing the namespaces.

### Namespace separation (critical)

- AniList ID and MAL ID are **different namespaces**. `id === anilistId` always.
- A MAL ID never becomes `id` or `anilistId` unless an **actual AniList
  provider response** confirms the relationship (AniList's `id` / `idMal`).
- Namespace determines meaning, NOT numeric equality: AniList 123 and MAL 123
  are two separate namespace values, never assumed to be related.

### Resolver architecture

```text
Controller / future service
   ↓
IdentityResolver        src/identity/identity-resolver.js
   ↓                    (types in id-types.js)
CacheManager.getOrLoad  (namespace-safe keys, coalescing, stale-if-error)
   ↓
AniListProvider         (the ONLY mapping authority: payload.id / payload.idMal)
   ↓
normalized IdentityResult -> cache (forward + reverse entries)
```

### Resolver methods

| Method | Purpose |
| --- | --- |
| `resolveAniListToMal(anilistId)` | Uses `AniListProvider.getAnimeById` -> `idMal` ONLY |
| `resolveMalToAniList(malId)` | Uses `AniListProvider.getAnimeByMalId` -> `id` ONLY |
| `resolve({ type, id })` | Generic dispatcher; `type` must be explicit (`"anilist"` \| `"mal"`) - a bare number is ambiguous and rejected |

### Identity result shape

```json
{ "anilistId": 123, "malId": 456, "source": "anilist", "confidence": "provider", "resolved": true }
```

Unresolved mapping (AniList succeeded but `idMal` is null - NOT a failure):

```json
{ "anilistId": 101, "malId": null, "source": null, "confidence": null, "resolved": false }
```

### Unresolved mappings vs provider failures

- **Valid unresolved** (provider succeeded, `idMal: null`): returned as
  `resolved: false` and cached with a conservative (shorter) TTL.
- **Provider failure** (timeout/429/500/network/malformed): NEVER cached as an
  unresolved mapping - typed errors propagate (stale-if-error still applies),
  so a transient outage can never poison the cache with `malId: null`.

### Cache behavior

- Namespace-safe keys: `identity:anilist-to-mal:{id}` and
  `identity:mal-to-anilist:{id}` (never a bare `identity:{id}`).
- NORMALIZED identity results are cached, never raw provider payloads.
- Resolving one direction populates the reverse cache entry (via the cache
  abstraction, never L1 internals).
- Concurrent identical lookups coalesce into one provider request via
  `cacheManager.getOrLoad`.

### Error semantics

Invalid IDs (0, negative, decimal, NaN, Infinity, `"123abc"`, empty) ->
`ValidationError`. Anime not found on AniList (either direction) ->
`NotFoundError`. Timeout/429 -> `TimeoutError`/`RateLimitError`. Other
failures -> `ProviderError`. "AniList anime exists but `idMal` is null" is a
successful unresolved mapping - never an error.

### No title-based/fuzzy mapping

Explicitly forbidden: title similarity, Jikan search, first-result matching,
numeric derivation. Mapping authority = AniList's actual relationship fields
ONLY. Jikan may retrieve MAL metadata after a MAL ID is known, but never
manufactures an AniList ID.

### Future MegaPlay use case (not implemented yet)

```text
MegaPlay(AniList 123) -> failure
   ↓
IdentityResolver.resolveAniListToMal(123) -> malId 456
   ↓
MegaPlay(MAL 456)
```

### Tests

`npm test` covers: both directions (success, unresolved, 404, timeout, 429,
500, network, malformed), validation (all invalid forms), namespace safety
(anilistId only from `payload.id`; equal numeric values stay separated;
mismatched `idMal` -> ProviderError), generic resolver input rules, cache
(hit/miss, unresolved policy, failures never cached, stale-if-error,
coalescing, reverse population), purity, and the MegaPlay fallback contract.

## Phase 5 — TMDB Visual Enrichment

> **TMDB enriches visuals. It does not establish anime identity.**

### Role

TMDB is an **optional** visual enrichment source (backdrops, banners, artwork).
AniList remains the primary identity/metadata source; Jikan the secondary MAL
source. TMDB must NEVER become the source of truth for AniList ID, MAL ID,
anime identity, canonical titles, or streaming/MegaPlay IDs - a `tmdbId` is a
completely separate namespace.

### Provider architecture

```text
Canonical Anime
   ↓
TMDB service           src/services/tmdb.service.js
   ↓                   (cacheManager.getOrLoad -> namespace-safe keys)
TmdbProvider           src/providers/tmdb/tmdb.provider.js
                       (endpoints + image URLs in tmdb.queries.js, shared
                        Phase 1 HTTP client - no second HTTP client)
   ↓                   raw TMDB payloads
normalize + match      src/normalizers/tmdb.normalizer.js + tmdb.matching.js
   ↓                   conservative matching -> visual enrichment result
mergeTmdbIntoCanonical src/normalizers/anime.merge.js (caller-side)
```

Provider methods (raw-payload returning, stateless, request-scoped):
`searchTv(query, opts)`, `getTvDetails(tmdbId)`, `searchMovie(query, opts)`,
`getMovieDetails(tmdbId)`.

**Authentication:** from environment configuration only (`TMDB_API_KEY`).
v4 read tokens (JWT-shaped) use a Bearer header; v3 keys use the `api_key`
query parameter. Credentials are never hardcoded, never logged, never exposed
in API responses. A missing credential fails clearly (`ProviderError`) - the
service treats it as a valid unresolved enrichment, so AniList/Jikan data
keeps working.

**URL construction:** centralized in `tmdb.queries.js`; image URLs are built
ONLY from actual TMDB paths (`https://image.tmdb.org/t/p/<size><path>`).
Missing paths -> `null`. Never fabricated, never a made-up domain, never a
disguised poster.

### Matching strategy (conservative, deterministic)

`selectBestMatch` accepts a candidate ONLY when it confidently matches:

1. **Title match REQUIRED** - normalized comparison (trim, case-fold,
   whitespace collapse, harmless punctuation; CJK preserved) across candidate
   title variants vs. known AniList/Jikan titles (priority: AniList
   userPreferred, English, Romaji, Native; then Jikan English, Japanese,
   synonyms). Primary-title matches are preferred over alternate matches.
2. **Year compatibility** - known-vs-known years must be within +/-1;
   unknown years never disqualify (never guessed).
3. **Media type compatibility** - tv vs movie (MOVIE format -> movie search;
   TV/TV_SHORT/OVA/ONA conservatively -> tv, validated).
4. **Popularity is ONLY a tie-breaker** among equally-ranked candidates -
   never identity proof.

No aggressive fuzzy matching, no similarity thresholds without validation, no
unbounded loops (max 2 title attempts, stopping at the first reliable title
that yields a confident match). If no candidate confidently matches: **valid
unresolved enrichment** - a missing banner is better than a banner belonging
to the wrong anime.

### Visual shape

```json
{
  "resolved": true,
  "tmdbId": 789,
  "mediaType": "tv",
  "images": { "backdrop": "https://image.tmdb.org/t/p/original/...", "banner": "..." },
  "poster": "https://image.tmdb.org/t/p/w500/..."
}
```

Unresolved: `{ "resolved": false, "tmdbId": null, ..., "reason": "no_confident_match" }`.

### Banner precedence (explicit)

```text
AniList genuine bannerImage  -> always wins (TMDB never overwrites it)
TMDB backdrop/banner         -> fills only when AniList banner is null
null                         -> otherwise
```

A poster is NEVER turned into a banner/backdrop. TMDB never touches
`id`/`anilistId`/`malId`, titles, description, format, status, episodes,
duration, season/year, genres, studios, relations, dates, AniList
scores/popularity, or Jikan enrichment. The `tmdbId` lives ONLY in the
namespaced `enrichment.tmdb: { tmdbId, mediaType }`.

### Cache & failure behavior

- Namespace-safe key: `tmdb:visual:anilist:{anilistId}` (never a bare id).
- Normalized enrichment cached, not raw API responses.
- Three distinct outcomes, never conflated: successful enrichment (cached,
  DAY TTL) / valid unresolved (cached with shorter TTL: `tmdb_not_configured`,
  `no_title_available`, `no_confident_match`) / provider failure (typed error
  propagates, NEVER cached as visual data; stale-if-error applies).
- Concurrent identical enrichments coalesce into one TMDB search.
- A TMDB failure never causes destructive fallback: merge only happens with
  resolved results, so existing AniList/Jikan data always stays intact.

### Tests

```bash
npm test                            # full suite (180 tests, all mocked)
node scripts/tmdb-smoke.js "One Punch Man"   # manual; requires TMDB_API_KEY
```

Covered: provider (search/details/404/429/timeout/500/network/malformed/empty
results/auth variants/missing credentials), validation, normalization (URLs
from actual paths only), matching (exact/case/whitespace/punctuation/year/
wrong-year/wrong-title/multiple/ambiguous/no-match), identity safety
(tmdbId never becomes anilistId/malId/id), merge precedence, purity, and the
cache/service flow.

## Phase 6 — Supabase L2 Cache + Schema

> **Supabase is the persistent/shared L2 cache. It does not replace L1 memory cache and it does not become a provider.**

### Role

L1 (in-memory) remains an ephemeral per-instance optimization; L2 (Supabase)
is the persistent cache that works across Vercel/Cloudflare serverless
instances. Provider failures are never stored in L2 as successful values.

### Cache flow

```text
Request -> L1 fresh -> return
L1 miss -> L2 fresh (Supabase) -> promote to L1 -> return
L2 miss/stale-not-usable -> provider loader
  -> successful normalized result -> write L2 (atomic upsert) -> write L1 -> return
provider failure -> stale L1/L2 (within stale_until) -> return stale
provider failure + no stale -> typed provider error
Supabase outage -> degrade L2 -> continue with L1/provider (never an outage)
```

### Schema + migration

Table `cache_entries` (see `supabase/migrations/20260913000000_create_cache_entries.sql`):

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | bigint identity | PK |
| `namespace` | text | Explicit namespace (anilist/jikan/tmdb/identity/...) |
| `cache_key` | text | Explicit key within the namespace |
| `value` | jsonb | Normalized application data (never raw provider responses, never secrets) |
| `ttl_seconds` | integer | Fresh TTL used when written |
| `created_at` / `updated_at` | timestamptz | Written timestamps (`created_at` preserved across upserts) |
| `expires_at` | timestamptz | Fresh until this instant |
| `stale_until` | timestamptz | Stale-if-error usable until this instant |

Unique index on `(namespace, cache_key)` enables **atomic upserts**
(PostgREST `Prefer: resolution=merge-duplicates`) - concurrent serverless
instances can populate the same key without a SELECT-then-INSERT race.
Indexes on `expires_at`/`stale_until` support cleanup lookups. RLS is enabled
with no policies (service-role bypasses it; public access denied). An optional
`cleanup_expired_cache_entries()` SQL function exists for rare manual use -
**no backend worker, cron, or setInterval is required** (expired rows are
handled lazily during reads).

**One-time migration step (manual):**

```bash
# Supabase Dashboard -> SQL Editor -> paste the migration file -> Run
# or, with the CLI:
supabase db push
```

### SupabaseStore

Conforms to the existing `CacheStore` interface (get/set/delete/clear) via a
thin PostgREST client (`supabase/supabase-client.js`) built on the shared
Phase 1 HTTP abstraction - no `@supabase/supabase-js`, no second HTTP client.

- **Namespace/key separation:** the full key is split at the FIRST colon into
  an explicit namespace + cache_key (`anilist:anime:123` -> namespace
  `anilist`, key `anime:123`; `jikan:anime:123` -> namespace `jikan`; a
  numeric ID equal across providers is a DIFFERENT row).
- **Full-entry contract:** the store returns fresh/stale/expired entries with
  expiry metadata; the CacheManager decides fresh vs stale-usable.
- **Server-side credentials:** the key is sent ONLY via headers (`apikey` +
  `Authorization: Bearer`), never in URLs, never logged, never exposed in
  responses, never hardcoded.
- **Stale window:** entries carry `staleUntil = expiresAt + stale window`
  (default 24h); the manager serves stale data only when the provider
  operation failed AND the entry is within `stale_until`.
- **Failure behavior:** Supabase failures surface as typed `CacheError`; the
  manager degrades to L1/provider. A Supabase outage never becomes an
  AniList/Jikan/TMDB outage, and a write failure never fails an otherwise
  successful provider response.

### Environment variables

```env
SUPABASE_URL=               # project URL (blank = L1-only operation)
SUPABASE_SERVICE_ROLE_KEY=  # SECRET, server-side only; preferred (bypasses RLS)
SUPABASE_ANON_KEY=          # SECRET, optional fallback (RLS must allow cache ops)
```

Missing configuration is never a provider failure: with both blank the backend
runs with L1-only caching and remains fully functional.

### Tests

```bash
npm test                            # full suite (209 tests, all mocked)
node scripts/supabase-smoke.js      # manual live test; requires config + migration
```

Covered: config (valid/missing/credential handling/no leakage), store
(get hit/miss/fresh/stale/expired, upsert payload, update, delete, malformed
rows/response, read/write/delete errors, timeout), CacheManager integration
(L1 hit, L2 hit + promotion, both miss, stale-if-error across L2, no stale
after `stale_until`, failures/invalid results never cached, Supabase outage
never destroys provider success, coalescing intact), and namespace safety
(`anilist:anime:123` vs `jikan:anime:123` vs `tmdb:visual:anilist:123` never
collide).

## Roadmap (later phases)

1. ~~AniList integration + normalizer~~ (done in Phase 2)
2. ~~Jikan integration + normalizer~~ (done in Phase 3)
3. ~~Phase 4 — Identity Resolver (AniList <-> MAL mapping, cached)~~ (done in Phase 4)
4. ~~Phase 5 — TMDB visual enrichment~~ (done in Phase 5)
5. ~~Phase 6 — Supabase L2 cache implementation + schema~~ (done in Phase 6)
6. ~~Phase 7 — Frontend API endpoints~~ (done in Phase 7)
7. ~~Phase 8 — MegaPlay streaming resolver + GET /api/stream/resolve/:id~~ (done in Phase 8)
8. ~~Phase 9 — Full backend integration, QA & deployment hardening~~ (done in Phase 9)

## Phase 7 — Frontend API Endpoints

> **The frontend routes are live. MegaPlay streaming went live in Phase 8.**

### Activated routes & orchestration

Every frontend route follows the same layered flow - controllers stay thin, no
provider logic in routes, no Supabase/raw-HTTP calls in controllers:

```text
GET /api/details/:id
        ↓
details controller (thin HTTP glue)
        ↓
anime.service.getFullDetails
        ↓
AniList primary data (cached, DAY TTL component)
        ↓
Jikan enrichment when a trusted MAL ID exists (skipped on failure)
        ↓
TMDB visual enrichment (skipped on failure/unresolved)
        ↓
canonical response (cached composite, MEDIUM TTL)
```

| Endpoint | Service | Providers |
| --- | --- | --- |
| `GET /api/home` | `home.service.getHomeFeed` | AniList (4 cached section searches) |
| `GET /api/search` | `anime.service.searchAnime` | AniList only (no per-result enrichment) |
| `GET /api/details/:id` | `anime.service.getFullDetails` | AniList -> Jikan -> TMDB |
| `GET /api/smart/details/:id` | `anime.service.getFullDetails` | Identical composite cache key - zero duplicate calls |
| `GET /api/episodes/:id` | `anime.service.getAnimeEpisodes` | AniList base + Jikan episode list |
| `GET /api/jikan/anime/:malId` | `jikan.service.getAnimeByMalId` | Jikan only |
| `GET /api/jikan/from-anilist/:id` | `jikan.controller` + `identityResolver` | AniList (idMal) -> Jikan |
| `GET /api/recommendations/:id` | `anime.service.getAnimeRecommendations` | AniList only |
| `GET /api/seasons/:id` | `anime.service.getAnimeSeasons` | AniList relations only |
| `GET /api/category/:type` | `category.service.getCategory` | AniList search (validated genre/special types) |
| `GET /api/top-search` | `top-search.service.getTopSearch` | AniList (popularity-ranked cached search) |
| `GET /api/schedule` | `schedule.service.getAiringSchedule` | AniList airing schedule only |
| `GET /api/tmdb/:id` | `tmdb.controller` + `tmdb.service.enrichWithTmdb` | AniList (titles) -> TMDB (visuals only) |

### ID namespace rules (enforced)

- On all AniList-based routes, `:id` is the **AniList ID**; on
  `/api/jikan/anime/:malId` it is a **MAL ID**. Namespaces are never conflated.
- MAL IDs come ONLY from trusted AniList `idMal` data or the identity layer -
  never guessed, never derived numerically.
- `/api/jikan/from-anilist/:id` resolves through the IdentityResolver; a
  missing mapping is a 404 (`NOT_FOUND`, `unresolved: true`) - no Jikan search
  by title, no fuzzy matching.
- TMDB identity (`tmdbId`, `mediaType`) lives ONLY in the namespaced
  enrichment - it never becomes canonical anime identity.

### Canonical response

The frontend-facing anime response is the Phase 2 canonical shape. Identity is
preserved exactly:

```json
{ "id": 123, "anilistId": 123, "malId": 456 }
```

`malId: null` only when the AniList mapping genuinely does not exist. A MAL ID
never appears in `id`. AniList remains authoritative for identity, titles,
description, format, status, episodes, duration, season/year, genres, studios,
relations, and scores/popularity. Jikan may enrich secondary fields (and lives
in `enrichment.jikan`); TMDB may enrich visuals only.

Banner precedence: AniList genuine `bannerImage` -> TMDB backdrop/banner (only
when AniList has none) -> `null`. A poster is never turned into a banner.

### Cache keys & TTL strategy

Namespace-safe, deterministic keys (fixed option property order, normalized
query parameters - no property-order or query-order collisions):

```text
anilist:anime:<id>                  (component cache, DAY)
api:details:anilist:<id>            (composite, MEDIUM)
anilist:search:<q>:<fixed-options>  (MEDIUM)
api:home:v1                         (MEDIUM)
anilist:recommendations:<id>        (DAY)
anilist:relations:<id>              (DAY)
jikan:anime:<id> / jikan:episodes:<id>:p<page>  (DAY / MEDIUM)
api:category via anilist:search     (MEDIUM)
api:schedule:<fromMs>:<toMs>:p<page>  (MEDIUM; default window quantized to UTC day boundaries)
tmdb:visual:anilist:<id>            (DAY resolved; MEDIUM unresolved)
```

Never cached: provider failures, malformed results, invalid requests. Empty
`results` arrays from genuine successful responses are valid and cached;
provider failures are NOT converted into empty responses. Stale-if-error serves
previous good data on outages.

### Resilience & performance

- A failing home section is omitted (warn-logged) rather than emptying the
  page; if EVERY section fails, the error propagates and stale-if-error on the
  home cache serves the previous good response.
- Jikan/TMDB enrichment failures never destroy valid AniList data - enrichment
  is skipped, AniList data stays intact.
- `/details` and `/smart/details` share one composite cache key, so there are
  zero duplicate provider calls between the two endpoints.
- List endpoints use AniList list/search data only; heavy Jikan/TMDB
  enrichment is reserved for detail-oriented endpoints. Search stays fast.
- Pagination bounds enforced server-side (`perPage` <= 50, `page` <= 500,
  query length <= 200) - no unbounded provider requests.

### Episodes (no streaming)

`GET /api/episodes/:id` provides episode METADATA only (Jikan episode list when
a trusted MAL mapping exists; `episodes: null` otherwise). No MegaPlay calls,
no stream URLs, no fabricated episodes - streaming is Phase 8's MegaPlay
resolver on its own route.

### Tests

```bash
npm test                        # full suite (256 tests, all mocked - no live providers)
```

Phase 7 adds 47 mocked endpoint tests (real Express app on an ephemeral port,
mocked fetch routed by provider host via `tests/helpers/test-server.js`),
covering: home (success/cache/section-failure/stale/no-destructive-empty),
search (query/pagination/filters/validation/cache/provider-error/empty),
details (canonical identity/Jikan/TMDB enrichment/missing MAL mapping/unresolved
TMDB/failure + stale), smart details (cache reuse, no duplicate calls),
episodes (metadata only, no MegaPlay), jikan routes (MAL identity, AniList ->
MAL resolution, missing mapping, no title substitution), recommendations,
seasons, category (valid/invalid/special/pagination), schedule (cached,
failure), top-search, tmdb (identity untouched, visual only, unresolved,
failure isolation), and the reserved 501 stream route.
