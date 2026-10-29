/**
 * Endpoint tests (HTTP-level): GET /api/stream/resolve/anilist/:id and
 * /api/stream/resolve/mal/:id resolve streams through the MegaPlay proxy
 * using the CORRECT ID namespace, never confusing AniList with MAL.
 *
 * These tests pin the new namespace-specific routes while the legacy
 * /api/stream/resolve/:id (AniList ID only) stays backward compatible.
 *
 * Covered per route:
 *   - ep=1 sub, a later episode sub, ep=1 dub  (proxy URL carries id/ep/lang/idType)
 *   - valid API key via header (frontend server-side proxy flow) -> 200
 *   - missing API key -> 401, invalid API key -> 401
 *   - ?api_key= query is NOT accepted on streaming routes (header-only policy)
 *   - invalid id / episode / language -> 400 VALIDATION_ERROR, no provider call
 *   - namespace isolation: a numeric ID keeps the route's namespace
 *
 * Fully mocked - no live MegaPlay/AniList. Imports test-env-proxy.js first so
 * the playback proxy is configured and responses carry proxy watch URLs.
 */

import './helpers/test-env-proxy.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  installApiMocks,
  startTestServer,
  resetL1Cache,
} from './helpers/test-server.js';

const PROXY_BASE = 'https://megaplayproxy.test';
const SECRET = process.env.BACKEND_API_SECRET;
const rawFetch = globalThis.fetch.bind(globalThis);

const ANILIST_ID = 21;
const MAL_ID = 456;

function megaplayStreamJson(ep, lang) {
  return { success: true, sources: [{ url: `https://cdn.example/ep-${ep}-${lang}.mp4`, quality: '1080p' }] };
}

/** MegaPlay mock: usable stream for every /stream/{kind}/{id}/{ep}/{lang}. Records the kind. */
function megaplayHandler() {
  /** @type {Array<{kind: string, id: number, ep: number, lang: string}>} */
  const paths = [];
  return {
    handler: (url) => {
      const match = String(url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
      if (match) {
        paths.push({ kind: match[1], id: Number(match[2]), ep: Number(match[3]), lang: match[4] });
        return { status: 200, json: megaplayStreamJson(Number(match[3]), match[4]) };
      }
      return { status: 200, json: { success: false } };
    },
    paths: () => paths,
  };
}

function proxyWatchUrl(id, ep, lang, idType) {
  return `${PROXY_BASE}/watch/${id}?ep=${ep}&lang=${lang}&idType=${idType}`;
}

async function withServer(run) {
  await resetL1Cache();
  const mock = megaplayHandler();
  const installed = installApiMocks({ megaplay: mock.handler });
  const server = await startTestServer();
  try {
    await run(server, mock, rawFetch);
  } finally {
    await server.stop();
    installed.restore();
  }
}

// --- AniList route ----------------------------------------------------------

test('GET /api/stream/resolve/anilist/:id ep=1 sub -> idType=anilist, correct proxy URL', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.resolved, true);
    assert.equal(body.provider, 'megaplay');
    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, null);
    assert.equal(body.episode, 1);
    assert.equal(body.language, 'sub');
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 1, 'sub', 'anilist'));
    assert.equal(body.sources[0].url, body.playbackUrl);
    assert.equal(body.sources[0].type, 'proxy');
    // No direct MegaPlay URL exposed.
    assert.ok(!JSON.stringify(body).includes('megaplay.buzz'));

    const paths = mock.paths();
    assert.equal(paths.length, 1);
    assert.equal(paths[0].kind, 'ani');
    assert.equal(paths[0].id, ANILIST_ID);
    assert.equal(paths[0].ep, 1);
    assert.equal(paths[0].lang, 'sub');
  });
});

test('GET /api/stream/resolve/anilist/:id later episode sub -> ep carried everywhere', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=8&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.episode, 8);
    assert.equal(body.language, 'sub');
    assert.equal(body.idType, 'anilist');
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 8, 'sub', 'anilist'));
    assert.equal(body.streams.sub.url, proxyWatchUrl(ANILIST_ID, 8, 'sub', 'anilist'));
    assert.equal(body.streams.dub.url, proxyWatchUrl(ANILIST_ID, 8, 'dub', 'anilist'));

    const paths = mock.paths();
    assert.equal(paths[0].ep, 8);
    assert.equal(paths[0].kind, 'ani');
  });
});

test('GET /api/stream/resolve/anilist/:id ep=1 dub -> language=dub, idType=anilist', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=dub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.language, 'dub');
    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 1, 'dub', 'anilist'));
    assert.equal(body.streams.dub.url, proxyWatchUrl(ANILIST_ID, 1, 'dub', 'anilist'));

    const paths = mock.paths();
    assert.equal(paths[0].lang, 'dub');
    assert.equal(paths[0].kind, 'ani');
  });
});

// --- MAL route --------------------------------------------------------------

test('GET /api/stream/resolve/mal/:id ep=1 sub -> idType=mal, MAL ID used for playback', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.resolved, true);
    assert.equal(body.provider, 'megaplay');
    assert.equal(body.idType, 'mal');
    assert.equal(body.malId, MAL_ID);
    assert.equal(body.anilistId, null); // not known unless the IdentityResolver confirms it
    assert.equal(body.episode, 1);
    assert.equal(body.language, 'sub');
    assert.equal(body.playbackUrl, proxyWatchUrl(MAL_ID, 1, 'sub', 'mal'));
    assert.equal(body.sources[0].url, body.playbackUrl);
    assert.equal(body.sources[0].type, 'proxy');
    assert.ok(!JSON.stringify(body).includes('megaplay.buzz'));

    const paths = mock.paths();
    assert.equal(paths.length, 1);
    assert.equal(paths[0].kind, 'mal');
    assert.equal(paths[0].id, MAL_ID);
    assert.equal(paths[0].ep, 1);
    assert.equal(paths[0].lang, 'sub');
  });
});

test('GET /api/stream/resolve/mal/:id later episode sub -> ep carried everywhere', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=12&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.episode, 12);
    assert.equal(body.language, 'sub');
    assert.equal(body.idType, 'mal');
    assert.equal(body.playbackUrl, proxyWatchUrl(MAL_ID, 12, 'sub', 'mal'));
    assert.equal(body.streams.sub.url, proxyWatchUrl(MAL_ID, 12, 'sub', 'mal'));
    assert.equal(body.streams.dub.url, proxyWatchUrl(MAL_ID, 12, 'dub', 'mal'));

    const paths = mock.paths();
    assert.equal(paths[0].ep, 12);
    assert.equal(paths[0].kind, 'mal');
  });
});

test('GET /api/stream/resolve/mal/:id ep=1 dub -> language=dub, idType=mal', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1&language=dub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.language, 'dub');
    assert.equal(body.idType, 'mal');
    assert.equal(body.malId, MAL_ID);
    assert.equal(body.playbackUrl, proxyWatchUrl(MAL_ID, 1, 'dub', 'mal'));
    assert.equal(body.streams.dub.url, proxyWatchUrl(MAL_ID, 1, 'dub', 'mal'));

    const paths = mock.paths();
    assert.equal(paths[0].lang, 'dub');
    assert.equal(paths[0].kind, 'mal');
  });
});

// --- Namespace isolation (numeric IDs are not reinterpreted) ---------------

test('Namespace isolation: AniList route keeps idType=anilist even for a numeric MAL-like ID', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/anilist/${MAL_ID}?ep=1&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, MAL_ID);
    assert.equal(body.playbackUrl, proxyWatchUrl(MAL_ID, 1, 'sub', 'anilist'));
    assert.equal(mock.paths()[0].kind, 'ani');
    // The MAL route must NOT have been used; the ID is treated as AniList.
    assert.ok(!body.playbackUrl.includes('idType=mal'));
  });
});

test('Namespace isolation: MAL route keeps idType=mal even for a numeric AniList-like ID', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/mal/${ANILIST_ID}?ep=1&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.idType, 'mal');
    assert.equal(body.malId, ANILIST_ID);
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 1, 'sub', 'mal'));
    assert.equal(mock.paths()[0].kind, 'mal');
    assert.ok(!body.playbackUrl.includes('idType=anilist'));
  });
});

// --- Authentication (header-only policy for streaming routes) --------------

test('Valid API key via X-API-Key header -> 200 (frontend proxy flow)', async () => {
  await withServer(async (server, _mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub`, {
      headers: { 'X-API-Key': SECRET },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.idType, 'anilist');
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 1, 'sub', 'anilist'));
  });
});

test('Valid API key via Authorization Bearer header -> 200', async () => {
  await withServer(async (server, _mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1&language=sub`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.idType, 'mal');
    assert.equal(body.playbackUrl, proxyWatchUrl(MAL_ID, 1, 'sub', 'mal'));
  });
});

test('Missing API key -> 401 UNAUTHORIZED_ERROR', async () => {
  await withServer(async (server, _mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  });
});

test('Invalid API key -> 401 UNAUTHORIZED_ERROR', async () => {
  await withServer(async (server, _mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub`, {
      headers: { 'X-API-Key': 'definitely-wrong-key' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED_ERROR');
  });
});

test('?api_key= query alone is ACCEPTED on streaming routes (now allowlisted)', async () => {
  await withServer(async (server, _mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=sub&api_key=${SECRET}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.idType, 'anilist');
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 1, 'sub', 'anilist'));
  });
});

test('?api_key= query alone is ACCEPTED on the MAL streaming route', async () => {
  await withServer(async (server, _mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/mal/${MAL_ID}?ep=1&language=sub&api_key=${SECRET}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.idType, 'mal');
    assert.equal(body.playbackUrl, proxyWatchUrl(MAL_ID, 1, 'sub', 'mal'));
  });
});

// --- Validation -------------------------------------------------------------

test('Invalid ID values -> 400 VALIDATION_ERROR before any provider call', async () => {
  await withServer(async (server, mock, rawFetch) => {
    for (const bad of ['abc', '0', '-1', '1.5', '', 'notanid']) {
      const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${encodeURIComponent(bad)}?ep=1`, {
        headers: { 'X-API-Key': SECRET },
      });
      assert.equal(res.status, 400, `expected 400 for id=${JSON.stringify(bad)}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(mock.paths().length, 0);
  });
});

test('Invalid episode values -> 400 VALIDATION_ERROR before any provider call', async () => {
  await withServer(async (server, mock, rawFetch) => {
    for (const bad of ['0', '-1', '2.5', 'abc', '']) {
      const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=${encodeURIComponent(bad)}`, {
        headers: { 'X-API-Key': SECRET },
      });
      assert.equal(res.status, 400, `expected 400 for ep=${JSON.stringify(bad)}`);
      assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    }
    assert.equal(mock.paths().length, 0);
  });
});

test('Invalid language values -> 400 VALIDATION_ERROR before any provider call', async () => {
  await withServer(async (server, mock, rawFetch) => {
    const res = await rawFetch(`${server.baseUrl}/api/stream/resolve/anilist/${ANILIST_ID}?ep=1&language=abc`, {
      headers: { 'X-API-Key': SECRET },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
    assert.equal(mock.paths().length, 0);
  });
});

// --- Backward compatibility: legacy /api/stream/resolve/:id ----------------

test('Legacy GET /api/stream/resolve/:id still resolves by AniList ID (idType=anilist)', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=1&language=sub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.resolved, true);
    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, null);
    assert.equal(body.episode, 1);
    assert.equal(body.language, 'sub');
    assert.equal(body.playbackUrl, proxyWatchUrl(ANILIST_ID, 1, 'sub', 'anilist'));

    const paths = mock.paths();
    assert.equal(paths.length, 1);
    assert.equal(paths[0].kind, 'ani');
    assert.equal(paths[0].id, ANILIST_ID);
  });
});
