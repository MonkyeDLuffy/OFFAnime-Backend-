/**
 * Regression tests (HTTP-level): GET /api/stream/resolve/:id respects the
 * REQUESTED episode everywhere.
 *
 * Bug being pinned: the controller used to read only the documented
 * `?episode=` alias, so a frontend request like `?ep=4` silently resolved to
 * episode 1 (response `episode` field, playbackUrl, streams.sub/dub, sources,
 * MegaPlay URLs, and cache keys all said episode 1).
 *
 * Covered: `ep` honored end-to-end (ep=4, ep=7), default behavior without a
 * parameter, invalid episode values (400), no cross-episode cache collisions,
 * cache hits returning the requested episode, AniList -> MAL fallback episode
 * preservation, sub/dub URL consistency, and `?episode=` backward
 * compatibility. Fully mocked - no live MegaPlay/AniList.
 */

import './helpers/test-env-proxy.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, installApiMocks, resetL1Cache } from './helpers/test-server.js';

const PROXY_BASE = 'https://megaplayproxy.test';
const ANILIST_ID = 20;
const MAL_ID = 456;

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

/** MegaPlay mock: serves a usable stream for every documented
 * /stream/{kind}/{id}/{ep}/{lang} URL (except when the test overrides it). */
function megaplayHandler() {
  return (url) => {
    const match = String(url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
    if (!match) return { status: 200, json: { success: false } };
    const [, , ep, lang] = match;
    return { status: 200, json: megaplayStreamJson(Number(ep), lang) };
  };
}

/** Extract {kind, id, ep, lang} from a recorded MegaPlay call URL. */
function megaplayPathOf(call) {
  const match = String(call.url).match(/\/stream\/(ani|mal)\/(\d+)\/(\d+)\/(sub|dub)/);
  assert.ok(match, `unexpected MegaPlay URL: ${call.url}`);
  return { kind: match[1], id: Number(match[2]), ep: Number(match[3]), lang: match[4] };
}

/** Assert EVERY episode-bearing field/URL of the response uses `ep`. */
function assertEpisodeEverywhere(body, ep, { id = ANILIST_ID, idType = 'anilist', language = 'sub' } = {}) {
  assert.equal(body.episode, ep);
  assert.equal(body.playbackUrl, `${PROXY_BASE}/watch/${id}?ep=${ep}&lang=${language}&idType=${idType}`);
  assert.equal(body.streams.sub.url, `${PROXY_BASE}/watch/${id}?ep=${ep}&lang=sub&idType=${idType}`);
  assert.equal(body.streams.dub.url, `${PROXY_BASE}/watch/${id}?ep=${ep}&lang=dub&idType=${idType}`);
  for (const source of body.sources) {
    assert.ok(
      source.url.includes(`ep=${ep}&`),
      `expected source URL to carry ep=${ep}: ${source.url}`,
    );
  }
}

async function withServer(run) {
  await resetL1Cache();
  const mock = installApiMocks({ megaplay: megaplayHandler() });
  const server = await startTestServer();
  try {
    await run(server, mock);
  } finally {
    await server.stop();
    mock.restore();
  }
}

test('regression: ?ep=4 returns episode 4 everywhere (playbackUrl, streams, sources, MegaPlay URL)', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.resolved, true);
    assert.equal(body.idType, 'anilist');
    assert.equal(body.anilistId, ANILIST_ID);
    assertEpisodeEverywhere(body, 4);

    // The provider was asked for episode 4, never episode 1.
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.equal(paths.length, 1);
    assert.equal(paths[0].kind, 'ani');
    assert.equal(paths[0].id, ANILIST_ID);
    assert.equal(paths[0].ep, 4);
    assert.equal(paths[0].lang, 'sub');
  });
});

test('regression: ?ep=7 returns episode 7 everywhere', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=7`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assertEpisodeEverywhere(body, 7);
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.equal(paths[0].ep, 7);
  });
});

test('regression: no episode parameter preserves the documented default (episode 1)', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assertEpisodeEverywhere(body, 1);
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.equal(paths[0].ep, 1);
  });
});

test('regression: invalid episode values return HTTP 400 before any provider call', async () => {
  await withServer(async (server, mock) => {
    for (const bad of ['0', '-1', '2.5', 'abc', '', '999999999']) {
      const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `expected 400 for ep=${JSON.stringify(bad)}`);
      const body = await res.json();
      assert.equal(body.error.code, 'VALIDATION_ERROR', `expected VALIDATION_ERROR for ep=${JSON.stringify(bad)}`);
    }
    // Repeated params arrive as an array -> rejected as well.
    const arrayRes = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4&ep=5`);
    assert.equal(arrayRes.status, 400);
    assert.equal((await arrayRes.json()).error.code, 'VALIDATION_ERROR');

    assert.equal(mock.megaplayCalls().length, 0);
  });
});

test('regression: episodes 1 and 4 do NOT share a cached response (no cross-episode collision)', async () => {
  await withServer(async (server, mock) => {
    const first = await (await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=1`)).json();
    const fourth = await (await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4`)).json();

    assert.equal(first.episode, 1);
    assert.equal(fourth.episode, 4);
    assert.notEqual(first.playbackUrl, fourth.playbackUrl);
    assert.ok(first.playbackUrl.includes('ep=1&'));
    assert.ok(fourth.playbackUrl.includes('ep=4&'));

    // Distinct cache keys: the provider was called once PER episode.
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(
      paths.map((p) => `${p.kind}/${p.id}/${p.ep}/${p.lang}`),
      [`ani/${ANILIST_ID}/1/sub`, `ani/${ANILIST_ID}/4/sub`],
    );
  });
});

test('regression: cache hits still return the requested episode (ep=4 twice -> one provider call, correct URLs)', async () => {
  await withServer(async (server, mock) => {
    const first = await (await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4`)).json();
    const second = await (await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4`)).json();

    assert.equal(mock.megaplayCalls().length, 1); // second resolve served from cache
    assertEpisodeEverywhere(second, 4);
    assert.equal(second.playbackUrl, first.playbackUrl);
    assert.deepEqual(second.sources, first.sources);
  });
});

test('regression: AniList -> MAL fallback preserves the requested episode (ep=4 -> idType=mal, ep=4 URLs)', async () => {
  await resetL1Cache();
  const mock = installApiMocks({
    anilist: () => ({ data: { Media: { id: ANILIST_ID, idMal: MAL_ID } } }),
    megaplay: (url) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith(`/stream/ani/${ANILIST_ID}/`)) {
        // Genuine no-stream on the AniList endpoint -> MAL fallback.
        return { status: 200, body: MEGAPLAY_ERROR_PAGE, contentType: 'text/html' };
      }
      const match = path.match(/\/stream\/mal\/(\d+)\/(\d+)\/(sub|dub)/);
      return { status: 200, json: megaplayStreamJson(Number(match[2]), match[3]) };
    },
  });
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.resolved, true);
    assert.equal(body.idType, 'mal');
    assert.equal(body.anilistId, ANILIST_ID);
    assert.equal(body.malId, MAL_ID);
    assertEpisodeEverywhere(body, 4, { id: MAL_ID, idType: 'mal' });

    // Both MegaPlay lookups used episode 4.
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.deepEqual(paths.map((p) => `${p.kind}/${p.id}/${p.ep}`), [`ani/${ANILIST_ID}/4`, `mal/${MAL_ID}/4`]);
  } finally {
    await server.stop();
    mock.restore();
  }
});

test('regression: sub and dub URLs use the SAME requested episode (?ep=4&language=dub)', async () => {
  await withServer(async (server) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?ep=4&language=dub`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.episode, 4);
    assert.equal(body.language, 'dub');
    assert.equal(body.playbackUrl, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=4&lang=dub&idType=anilist`);
    assert.equal(body.streams.sub.url, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=4&lang=sub&idType=anilist`);
    assert.equal(body.streams.dub.url, `${PROXY_BASE}/watch/${ANILIST_ID}?ep=4&lang=dub&idType=anilist`);
    assert.deepEqual(body.sources, [
      { url: body.playbackUrl, type: 'proxy', language: 'dub' },
      { url: body.streams.sub.url, type: 'proxy', language: 'sub' },
    ]);
  });
});

test('regression: original ?episode= alias stays backward-compatible (?episode=4)', async () => {
  await withServer(async (server, mock) => {
    const res = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?episode=4`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assertEpisodeEverywhere(body, 4);
    const paths = mock.megaplayCalls().map(megaplayPathOf);
    assert.equal(paths[0].ep, 4);

    // And the language alias contract is unchanged.
    const dubRes = await fetch(`${server.baseUrl}/api/stream/resolve/${ANILIST_ID}?episode=6&language=dub`);
    assert.equal(dubRes.status, 200);
    const dubBody = await dubRes.json();
    assert.equal(dubBody.episode, 6);
    assert.equal(dubBody.language, 'dub');
    assert.ok(dubBody.playbackUrl.includes('ep=6&lang=dub'));
  });
});
