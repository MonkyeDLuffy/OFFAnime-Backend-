/**
 * Test helper: installs a mock global fetch.
 *
 * Zero-dependency HTTP mocking for provider tests - no live AniList calls in
 * the unit test suite. Uses real `Response` objects (Node 18+) so the shared
 * HTTP client behaves exactly as in production (headers, status, JSON parsing,
 * AbortSignal semantics).
 *
 * Usage:
 *   const mock = installMockFetch(() => jsonResponse({ data: { Media: {...} } }));
 *   try { ... } finally { mock.restore(); }
 */

/**
 * @typedef {Object} MockResponseDescriptor
 * @property {number} status
 * @property {unknown} [json]      Body serialized as JSON.
 * @property {string} [body]       Raw body (overrides json).
 * @property {string} [contentType] Defaults to application/json.
 * @property {Record<string,string>} [headers] Extra headers.
 */

/**
 * Install a mock fetch. The handler receives each call and returns either a
 * real `Response` or a MockResponseDescriptor.
 *
 * @param {(call: { url: string, init: RequestInit, method: string }, index: number) => Promise<Response | MockResponseDescriptor>} handler
 * @returns {{ calls: Array<{ url: string, init: RequestInit, method: string }>, restore: () => void }}
 */
export function installMockFetch(handler) {
  const original = globalThis.fetch;
  /** @type {Array<{ url: string, init: RequestInit, method: string }>} */
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const call = { url, init, method: init.method ?? 'GET' };
    calls.push(call);
    const result = await handler(call, calls.length);

    if (result instanceof Response) return result;
    if (result && typeof result === 'object' && 'status' in result) {
      const body = result.body !== undefined ? result.body : JSON.stringify(result.json ?? {});
      return new Response(body, {
        status: result.status,
        headers: {
          'content-type': result.contentType ?? 'application/json',
          ...(result.headers ?? {}),
        },
      });
    }
    throw new Error('mock fetch handler must return a Response or descriptor');
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

/**
 * Build a JSON Response.
 * @param {unknown} body
 * @param {number} [status=200]
 * @param {Record<string,string>} [headers]
 * @returns {Response}
 */
export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
