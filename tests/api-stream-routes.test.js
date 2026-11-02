/**
 * HTTP-level tests: the THREE streaming routes.
 *
 *   GET /api/stream/resolve/anilist/:id  (AniList-PRIMARY, Server 1)
 *   GET /api/stream/resolve/mal/:id      (MAL-PRIMARY, Server 2)
 *   GET /api/stream/resolve/:id          (LEGACY, AniList-primary - unchanged)
 *
 * Covered: route registration (explicit routes respond, legacy still works),
 * route ORDER (the explicit routes are never captured by the legacy pattern -
 * proven through the MegaPlay call kinds: the MAL route must hit
 * /stream/mal/..., the AniList route /stream/ani/...), typed validation errors
 * for invalid ids on every route, MAL-PRIMARY resolution end-to-end through
 * the real app stack (MegaPlay providea-method-first: the requested MAL ID is
 * never sent to the AniList endpoint), identity fallback in BOTH directions,
 * both-providers-no-stream -> primary stands, missing AniList mapping handled
 * gracefully, typed provider failures through HTTP (429/500), query-parameter
 * contract ((ep vs episode precedence, sub/dub, invalid values rejected)),
 * query-only (?api_key) auth remains REJECTED on streaming routes
 * (header-only policy), and frontend-safety (proxy playback URLs only, direct
 * MegaPlay URLs never exposed). Fully mocked - no live providers.
 */

import './helpers/test-env-proxy.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, installApiMocks, resetL1Cache } from './helpers/test-server.js';

const PROXY_BASE = 'https://megaplayproxy.test';

// Deliberately ASYMMETRIC ids (AniList 16498 <-> MAL 21): numerically different
// so any numeric-equality slip shows up immediately.
const ANILIST_ID = 16498;
const MAL_ID = 21;

/** Captured BEFORE any test replaces globalThis.fetch: the raw fetch without
 * startTestServer's auto-injecting auth-header wrapper. */
const rawFetch = globalThis.fetch.bind(globalThis);
const SECRET = process.env.BACKEND_API_SECRET ?? 'test-only-default-secret';

/** Raw MegaPlay "Error - MegaPlay" page (genuine no-stream, HTTP 200). */
const MEGAPLAY_ERROR_PAGE =
  '<!DOCTYPE html><html lang="en"><head><title>Error - MegaPlay</title></head>' +
  '<body><div class="error-container">We can\'t find the file you are looking for.' +
  'Error Code: 410</div></body></html>';

/** MegaPlay stream JSON for a specific episode/language. */
function megaplayStreamJson(ep, lang) {
  return {
    success: true,
    sources: [{ url: `https://cdn.example/ep-${ep}-${lang}.mp4`, quality: '1080p' }],
  };
}

/** MegaPlay mock: usable stream for every documented /stream/{kind}/{id}/{ep}/{lang} URL. */
function megaplayAllStreams() {
  return (url) => {
    const match = String(url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
    if (!match) return { status: 200, json: { success: false } };
    const [, , ep, lang] = match;
    return { status: 200, json: megaplayStreamJson(Number(ep), lang) };
  };
}

/** AniList mock whose Media carries the ASYMMETRIC mapping (works for BOTH
 * identity directions: id = AniList ID, idMal = MAL ID). */
function anilistIdentityMapping() {
  return () => ({ data: { Media: { id: ANILIST_ID, idMal: MAL_ID } } });
}

/** Extract {kind, id, ep, lang} from a recorded MegaPlay call URL. */
function megaplayPathOf(call) {
  const match = String(call.url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
  assert.ok(match, `unexpected MegaPlay URL: ${call.url}`);
  return { kind: match[1], id: Number(match[2]), ep: Number(match[3]), lang: match[4] };
}

/** Every playback-bearing URL in the response must be the frontend-safe proxy
 * watch URL - never a direct MegaPlay URL. */
function assertProxyOnly(body, { id, idType, ep = 1, language = 'sub' } = {}) {
  const playback = `${PROXY_BASE}/watch/${id}?ep=${ep}&lang=${language}&idType=${idType}`;
  assert.equal(body.playbackUrl, playback);
  const json = JSON.stringify(body);
  assert.ok(!json.includes('megaplay.buzz'), 'response must never include a direct MegaPlay URL');
  assert.ok(!json.includes('cdn.example'), 'response must never include provider source URLs');
  for (const source of body.sources) {
    assert.equal(source.type, 'proxy');
  }
}

async function withServer(handlers, run) {
  await resetL1Cache();
  const mock = installApiMocks(handlers);
  const server = await startTestServer();
  try {
    await run(server, mock);
  } finally {
    await server.stop();
    mock.restore();
  }
}

function streamJson(res) {
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  return res.json();
}

// --- registration ------------------------------------------------------------

test('GET /api/stream/resolve/anilist/:id is registered and resolves AniList-PRIMARY (direct MegaPlay ani lookup)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    const body = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub`),
    );
    assert.equal(body.resolved, true);
    assert.equal(body.provider, 'megaplay');
    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, null); // identity was not needed - never guessed
    assert.equal(body.episode, 1);
    assert.equal(body.language, 'sub');
    assertProxyOnly(body, { id: ANILIST_ID, idType: 'anilist' });

    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(paths, [{ kind: 'ani', id: ANILIST_ID, ep: 1, lang: 'sub' }]);
  });
});

test('GET /api/stream/resolve/mal/:id is registered and resolves MAL-PRIMARY (direct MegaPlay mal lookup - NOT the AniList resolver)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    const body = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1&language=sub`),
    );
    assert.equal(body.resolved, true);
    assert.equal(body.provider, 'megaplay');
    assert.equal(body.idType, 'mal'); // the PRIMARY identity of THIS route
    assert.equal(body.malId, MAL_ID); // mirrors the requested MAL ID
    assert.equal(body.anilistId, null); // identity was not needed - never guessed
    assert.equal(body.episode, 1);
    assert.equal(body.language, 'sub');
    assertProxyOnly(body, { id: MAL_ID, idType: 'mal' });

    const paths = mock.megaplayCalls().map(megaplayPathOf);
    // The MAL ID went to the MAL provider method ONLY - never to /stream/ani/.
    assert.deepEqual(paths, [{ kind: 'mal', id: MAL_ID, ep: 1, lang: 'sub' }]);
    assert.equal(mock.anilistCalls().length, 0); // no AniList GraphQL call either
  });
});

test('Explicit routes are NOT captured by the legacy route (route order: provider call kinds prove the correct controllers ran)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    const aniBody = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}`),
    );
    assert.equal(aniBody.idType, 'anilist');

    const malBody = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}`),
    );
    assert.equal(malBody.idType, 'mal');
    assert.equal(malBody.malId, MAL_ID);

    // If the legacy route had captured /mal/21, this call would have been
    // /stream/ani/21 (the id treated as an AniList ID) instead of /stream/mal/21.
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(
      paths.map((p) => `${p.kind}/${p.id}`),
      [`ani/${ANILIST_ID}`, `mal/${MAL_ID}`],
    );
  });
});

test('The legacy route remains functional and unchanged (AniList-ONLY contract)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    const body = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=2&language=dub`),
    );
    assert.equal(body.resolved, true);
    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, null);
    assert.equal(body.episode, 2);
    assert.equal(body.language, 'dub');
    assertProxyOnly(body, { id: ANILIST_ID, idType: 'anilist', ep: 2, language: 'dub' });

    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(paths, [{ kind: 'ani', id: ANILIST_ID, ep: 2, lang: 'dub' }]);
  });
});

// --- validation --------------------------------------------------------------

test('Invalid IDs return typed validation errors on ALL three routes (before any provider call)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    for (const path of [
      `/api/stream/resolve/anilist/abc`,
      `/api/stream/resolve/anilist/0`,
      `/api/stream/resolve/anilist/-1`,
      `/api/stream/resolve/anilist/1.5`,
      `/api/stream/resolve/mal/abc`,
      `/api/stream/resolve/mal/0`,
      `/api/stream/resolve/mal/-4`,
      `/api/stream/resolve/abc`,
      `/api/stream/resolve/-7`,
    ]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      assert.equal(res.status, 400, `expected 400 for ${path}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR', `expected VALIDATION_ERROR for ${path}`);
    }
    assert.equal(mock.megaplayCalls().length, 0);
    assert.equal(mock.anilistCalls().length, 0);
  });
});

// --- query contract ----------------------------------------------------------

test('Query contract on BOTH explicit routes: ep honored, ?episode= alias works, ep takes precedence when both are supplied', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    // ep on the anilist route
    const ani4 = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=4`),
    );
    assert.equal(ani4.episode, 4);
    assert.ok(ani4.playbackUrl.includes('ep=4&'));

    // episode alias on the mal route
    const mal5 = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?episode=5`),
    );
    assert.equal(mal5.episode, 5);
    assert.ok(mal5.playbackUrl.includes('ep=5&'));

    // ep PRECEDENCE: both supplied -> ep wins (never silently re-resolved)
    const aniBoth = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=6&episode=2`),
    );
    assert.equal(aniBoth.episode, 6);
    assert.ok(aniBoth.playbackUrl.includes('ep=6&'));

    const malBoth = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=7&episode=2`),
    );
    assert.equal(malBoth.episode, 7);
    assert.ok(malBoth.playbackUrl.includes('ep=7&'));

    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(
      paths.map((p) => `${p.kind}/${p.ep}`),
      ['ani/4', 'mal/5', 'ani/6', 'mal/7'],
    );
  });
});

test('Query contract: no episode parameter defaults to 1 on both explicit routes', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    const ani = await streamJson(await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}`));
    const mal = await streamJson(await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}`));
    assert.equal(ani.episode, 1);
    assert.equal(mal.episode, 1);
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(
      paths.map((p) => `${p.kind}/${p.ep}`),
      ['ani/1', 'mal/1'],
    );
  });
});

test('Query contract: language=sub and language=dub reach the provider and the playback URLs on explicit routes', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server) => {
    const aniDub = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=3&language=dub`),
    );
    assert.equal(aniDub.language, 'dub');
    assert.equal(aniDub.playbackUrl, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=3&lang=dub&idType=anilist`);
    assert.equal(aniDub.streams.sub.url, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=3&lang=sub&idType=anilist`);
    assert.equal(aniDub.streams.dub.url, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=3&lang=dub&idType=anilist`);

    const malSub = await streamJson(
      await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?language=sub`),
    );
    assert.equal(malSub.language, 'sub');
    assert.equal(malSub.playbackUrl, `${PROXY_BASE}/watch/${MAL_ID}?ep=1&lang=sub&idType=mal`);
  });
});

test('Query contract: invalid episode is rejected on explicit routes and NEVER silently replaced (even when ?episode= is also present)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    for (const path of [
      `/api/stream/resolve/anilist/${ANILIST_ID}?ep=abc`,
      `/api/stream/resolve/anilist/${ANILIST_ID}?ep=0`,
      `/api/stream/resolve/anilist/${ANILIST_ID}?ep=abc&episode=3`, // invalid ep NOT replaced by episode=3
      `/api/stream/resolve/mal/${MAL_ID}?ep=-2`,
      `/api/stream/resolve/mal/${MAL_ID}?ep=2.5`,
      `/api/stream/resolve/mal/${MAL_ID}?ep=4&ep=9`, // repeated param (array) rejected
    ]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      assert.equal(res.status, 400, `expected 400 for ${path}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR', `expected VALIDATION_ERROR for ${path}`);
    }

    // Invalid language rejected on both explicit routes.
    for (const path of [
      `/api/stream/resolve/anilist/${ANILIST_ID}?language=xyz`,
      `/api/stream/resolve/mal/${MAL_ID}?language=eng`,
    ]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      assert.equal(res.status, 400, `expected 400 for ${path}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    }

    assert.equal(mock.megaplayCalls().length, 0);
  });
});

// --- MAL-primary resolution through HTTP -------------------------------------

test('MAL route: genuine MAL no-stream -> IdentityResolver -> AniList fallback succeeds (idType=anilist with the RESOLVED AniList ID)', async () => {
  await withServer(
    {
      anilist: anilistIdentityMapping(),
      megaplay: (url) => {
        const match = String(url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
        if (match && match[1] === 'ani') {
          const [, , ep, lang] = match;
          return { status: 200, json: megaplayStreamJson(Number(ep), lang) };
        }
        // Genuine no-stream on the MAL endpoint -> AniList fallback.
        return { status: 200, body: MEGAPLAY_ERROR_PAGE, contentType: 'text/html' };
      },
    },
    async (server, mock) => {
      const body = await streamJson(
        await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=2&language=sub`),
      );
      assert.equal(body.resolved, true);
      assert.equal(body.idType, 'anilist'); // the fallback namespace WON
      assert.equal(body.anilistId, ANILIST_ID); // the RESOLVED AniList ID
      assert.equal(body.malId, MAL_ID); // the requested MAL ID stays as metadata
      assertProxyOnly(body, { id: ANILIST_ID, idType: 'anilist', ep: 2 });

      const paths = mock.megaplayCalls().map(megaplayPathOf);
      assert.deepEqual(
        paths.map((p) => `${p.kind}/${p.id}/${p.ep}`),
        [`mal/${MAL_ID}/2`, `ani/${ANILIST_ID}/2`], // correct ids AND episode
      );
      assert.equal(mock.anilistCalls().length, 1); // one identity lookup
    },
  );
});

test('MAL route: MegaPlay HTTP 404 on the MAL endpoint triggers the fallback (never a transport reclassification)', async () => {
  await withServer(
    {
      anilist: anilistIdentityMapping(),
      megaplay: (url) => {
        if (String(url).includes('/stream/mal/')) return { status: 404, json: {} };
        return megaplayAllStreams()(url);
      },
    },
    async (server, mock) => {
      const body = await streamJson(await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}`));
      assert.equal(body.resolved, true);
      assert.equal(body.idType, 'anilist');
      // The ANILIST endpoint (not the 404ing MAL one) provided the stream.
      assert.equal(mpCallsKinds(mock), 'mal,ani');
      assertProxyOnly(body, { id: ANILIST_ID, idType: 'anilist' });
      const paths = mock.megaplayCalls().map(megaplayPathOf);
      assert.deepEqual(
        paths.map((p) => `${p.kind}/${p.id}`),
        [`mal/${MAL_ID}`, `ani/${ANILIST_ID}`],
      );
    },
  );
});

test('MAL route: BOTH providers no-stream -> the PRIMARY (mal) proxy playback URL stands (proxy handles availability)', async () => {
  await withServer(
    {
      anilist: anilistIdentityMapping(),
      megaplay: () => ({ status: 200, body: MEGAPLAY_ERROR_PAGE, contentType: 'text/html' }),
    },
    async (server, mock) => {
      const body = await streamJson(await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}`));
      assert.equal(body.resolved, true); // NOT an error: the proxy decides availability
      assert.equal(body.idType, 'mal'); // the PRIMARY namespace stands
      assert.equal(body.malId, MAL_ID);
      assert.equal(body.anilistId, ANILIST_ID); // AniList-confirmed mapping, metadata only
      assertProxyOnly(body, { id: MAL_ID, idType: 'mal' });

      // Both namespaces were checked, each with its OWN id.
      const paths = mock.megaplayCalls().map(megaplayPathOf);
      assert.deepEqual(
        paths.map((p) => `${p.kind}/${p.id}`),
        [`mal/${MAL_ID}`, `ani/${ANILIST_ID}`],
      );
    },
  );
});

test('MAL route: no AniList mapping exists (identity NotFoundError) -> graceful PRIMARY (mal) response, AniList endpoint never attempted', async () => {
  await withServer(
    {
      // AniList answers "Media: null" -> NotFoundError from the identity layer
      // ("no AniList Media maps to this MAL ID"). A missing mapping, handled
      // gracefully - NOT a request-level 404.
      anilist: () => ({ data: { Media: null } }),
      megaplay: () => ({ status: 200, body: MEGAPLAY_ERROR_PAGE, contentType: 'text/html' }),
    },
    async (server, mock) => {
      const body = await streamJson(await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}`));
      assert.equal(body.resolved, true);
      assert.equal(body.idType, 'mal'); // the PRIMARY (mal) namespace stands
      assert.equal(body.malId, MAL_ID);
      assert.equal(body.anilistId, null); // no mapping - never guessed
      assertProxyOnly(body, { id: MAL_ID, idType: 'mal' });

      // Only the MAL lookup happened - the fallback was skipped, not attempted.
      const paths = mock.megaplayCalls().map(megaplayPathOf);
      assert.deepEqual(
        paths.map((p) => `${p.kind}/${p.id}`),
        [`mal/${MAL_ID}`],
      );
      assert.equal(mpCallsKinds(mock), 'mal');
    },
  );
});

test('Provider failures stay correctly typed through HTTP: MegaPlay 500 -> 502 PROVIDER_ERROR, MegaPlay 429 -> 429 RATE_LIMIT_ERROR', async () => {
  await withServer(
    { megaplay: () => ({ status: 500, json: {} }) },
    async (server, mock) => {
      const res = await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error.code, 'PROVIDER_ERROR'); // never reinterpreted as "no stream"
      assert.equal(mock.anilistCalls().length, 0); // an outage triggers NO identity fallback
    },
  );

  await withServer({ megaplay: () => ({ status: 429, json: {} }) }, async (server) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}`);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, 'RATE_LIMIT_ERROR');
  });
});

// --- authentication ----------------------------------------------------------

test('Query-only authentication (?api_key=) remains REJECTED on BOTH new streaming routes (header-only policy unchanged)', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server, mock) => {
    for (const path of [
      `/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub&api_key=${SECRET}`,
      `/api/stream/resolve/mal/${MAL_ID}?ep=1&language=sub&api_key=${SECRET}`,
    ]) {
      const res = await rawFetch(`${server.baseUrl}${path}`); // NO header credential
      assert.equal(res.status, 401, `expected 401 for query-only auth on ${path}`);
      assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
    }
    // A valid header credential keeps working on the new routes (frontend
    // server-side proxy flow) - proved by their successful resolution above and
    // here through the raw client with an explicit header:
    const withHeader = await rawFetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1`, {
      headers: { 'X-API-Key': SECRET },
    });
    assert.equal(withHeader.status, 200);
    assert.equal((await withHeader.json()).idType, 'mal');
    assert.ok(mock.megaplayCalls().length >= 1);
  });
});

// --- frontend compatibility --------------------------------------------------

test('Response contract stays frontend-safe on ALL three routes: proxy playback URLs only, established field set, iframe-ready playbackUrl', async () => {
  await withServer({ megaplay: megaplayAllStreams() }, async (server) => {
    const responses = [
      await (await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub`)).json(),
      await (await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1&language=sub`)).json(),
      await (await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=1&language=sub`)).json(),
    ];
    for (const body of responses) {
      // The documented field set (from the established response contract).
      assert.deepEqual(
        Object.keys(body).sort(),
        [
          'anilistId',
          'episode',
          'expiresAt',
          'idType',
          'language',
          'malId',
          'playbackUrl',
          'provider',
          'resolved',
          'sources',
          'streams',
        ].sort(),
      );
      assert.equal(body.resolved, true);
      // The MegaPlay iframe player consumes playbackUrl with ep/lang/idType.
      assert.match(body.playbackUrl, /^https:\/\/megaplayproxy\.test\/watch\/\d+\?ep=\d+&lang=(sub|dub)&idType=(anilist|mal)$/);
      const json = JSON.stringify(body);
      assert.ok(!json.includes('megaplay.buzz'));
      assert.ok(!json.includes('cdn.example'));
    }
  });
});

// The legacy-route regression (ID 21 / One Piece style both-410) is covered by
// tests/api-stream-resolve.test.js; the MAL-route equivalent regression is
// covered by tests/stream-resolver-mal.test.js at the resolver level.

function mpCallsKinds(mock) {
  return mock.megaplayCalls().map(megaplayPathOf).map((p) => p.kind).join(',');
}
