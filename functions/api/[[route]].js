/**
 * Cloudflare Pages Function adapter (deployment adapter - contains NO business logic).
 *
 * Pages Functions are NOT a Node/Express server: `app.listen()` never runs on
 * Pages. This catch-all maps every `/api/*` request onto the existing,
 * deployment-agnostic application core (`createApp()` from src/app.js) by
 * bridging the two runtimes:
 *
 *   Worker `Request`  -> minimal Node-style `req` (url/method/headers)
 *   Express app       -> driven via its callable `(req, res)` contract, the
 *                        same invocation a Node http server performs
 *   Express `res`     -> minimal shim capturing status/headers/body, resolved
 *                        back into a Worker `Response`
 *
 * The Express prototype chain (attached by the app's init middleware) provides
 * `res.json`/`res.send`/`res.set`, which call into this shim's `setHeader`,
 * `getHeader` and `end`. Nothing else in the request lifecycle is emulated.
 *
 * Reused as-is (not duplicated): providers, services, cache (L1 memory + L2
 * Supabase), identity resolver, stream resolver, normalizers, route layer and
 * API contracts - including `GET /api/stream/resolve/:id`, which is unchanged.
 *
 * Runtime notes:
 *   - Requires the `nodejs_compat` flag (wrangler.toml) for `node:crypto`
 *     (request ids), `Buffer` (Express Content-Length/ETag) and `process.env`
 *     (auto-populated from Pages env vars/secrets for compatibility dates
 *     >= 2025-04-01).
 *   - The app is built once per isolate; `createApp()` never opens a listener,
 *     so nothing here starts servers or assumes a long-running process.
 *   - The L1 memory cache lives per-isolate; the L2 Supabase cache provides
 *     persistence across deployments (unchanged design).
 */

import { createApp } from '../../src/app.js';

const app = createApp();

/**
 * Convert a Worker `Request` into the minimal Node-style request object the
 * Express app needs. `req.url` keeps path + query string; Express mutates
 * `req.url` during routing and derives `req.originalUrl`/`req.query` from it.
 * @param {Request} request
 */
function toNodeRequest(request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    httpVersion: '1.1',
    connection: { remoteAddress: '', encrypted: false },
    socket: { remoteAddress: '', writable: true },
    raw: [],
  };
}

/**
 * Minimal Node `ServerResponse`-style shim: collects status/headers/body and
 * resolves a Worker `Response` when the app finishes the request. Emissions of
 * the `finish` event (used by the request-logger middleware) are supported.
 * @returns {{ res: object, done: Promise<Response> }}
 */
function createResponseShim() {
  const listeners = new Map();
  const headers = new Map();
  const chunks = [];
  let ended = false;
  let finishResolve;

  const done = new Promise((resolve) => {
    finishResolve = resolve;
  });

  const res = {
    statusCode: 200,
    headersSent: false,

    setHeader(name, value) {
      if (ended) return res;
      headers.set(
        String(name).toLowerCase(),
        Array.isArray(value) ? value.map(String).join(', ') : String(value),
      );
      return res;
    },

    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },

    removeHeader(name) {
      headers.delete(String(name).toLowerCase());
      return res;
    },

    hasHeader(name) {
      return headers.has(String(name).toLowerCase());
    },

    getHeaderNames() {
      return [...headers.keys()];
    },

    getHeaders() {
      return Object.fromEntries(headers);
    },

    status(code) {
      res.statusCode = Number(code);
      return res;
    },

    writeHead(statusCode, reason, headersArg) {
      res.statusCode = Number(statusCode);
      const extraHeaders = typeof reason === 'string' ? headersArg : reason;
      if (extraHeaders) {
        for (const [key, value] of Object.entries(extraHeaders)) {
          res.setHeader(key, value);
        }
      }
      return res;
    },

    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
      return res;
    },

    once(event, callback) {
      const wrapper = (...args) => {
        res.removeListener(event, wrapper);
        callback(...args);
      };
      return res.on(event, wrapper);
    },

    removeListener(event, callback) {
      const arr = listeners.get(event);
      if (arr) {
        const index = arr.indexOf(callback);
        if (index !== -1) arr.splice(index, 1);
      }
      return res;
    },

    write(chunk) {
      if (ended) return false;
      chunks.push(toUint8Array(chunk));
      return true;
    },

    end(chunk, encoding) {
      if (ended) return res;
      if (chunk !== undefined && chunk !== null) {
        chunks.push(toUint8Array(chunk, encoding));
      }
      ended = true;
      res.headersSent = true;
      for (const callback of listeners.get('finish') ?? []) {
        try {
          callback();
        } catch {
          // logging must never break the response
        }
      }
      finishResolve(buildResponse(res, headers, chunks));
      return res;
    },
  };

  return { res, done };
}

/**
 * @param {string | Buffer | Uint8Array} chunk
 * @param {string} [encoding]
 * @returns {Uint8Array}
 */
function toUint8Array(chunk, encoding) {
  if (typeof chunk === 'string') {
    if (encoding && encoding !== 'utf8' && encoding !== 'utf-8') {
      throw new Error(`Unsupported response encoding: ${encoding}`);
    }
    return new TextEncoder().encode(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('Unsupported response body type');
}

/**
 * @param {object} res Response shim (statusCode read for null-body statuses).
 * @param {Map<string, string>} headers
 * @param {Uint8Array[]} chunks
 * @returns {Response}
 */
function buildResponse(res, headers, chunks) {
  let body = null;
  if (chunks.length > 0) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = merged;
  }

  const headerObject = {};
  for (const [key, value] of headers) {
    headerObject[key] = value;
  }
  // Null-body statuses must not carry body-length headers.
  if (body === null && (res.statusCode === 204 || res.statusCode === 304 || res.statusCode === 205)) {
    delete headerObject['content-length'];
    delete headerObject['transfer-encoding'];
  }

  return new Response(body, { status: res.statusCode, headers: headerObject });
}

/**
 * Pages Function catch-all for /api/*.
 * @param {{ request: Request }} context
 * @returns {Promise<Response>}
 */
export async function onRequest(context) {
  const req = toNodeRequest(context.request);
  const { res, done } = createResponseShim();
  app(req, res);
  return done;
}
