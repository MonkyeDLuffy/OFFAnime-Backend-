/**
 * Route-registration verification (not part of the test suite): boots the real
 * Express app and prints the actual registered route stack, then performs
 * real HTTP requests against the running server for the three streaming
 * routes (validation-level integration, no provider credentials needed).
 */

process.env.LOG_LEVEL = 'error';
process.env.MEGAPLAY_PROXY_URL = 'https://megaplayproxy.test';
process.env.BACKEND_API_SECRET = 'verification-only-secret';

const { createApp } = await import('../src/app.js');

const app = createApp();

// Print the REAL route table (the source of truth for registration).
function printRoutes(stack, prefix = '') {
  for (const layer of stack) {
    const route = layer.route;
    if (route) {
      const methods = Object.keys(route.methods).join(',').toUpperCase();
      console.log(`${methods.padEnd(6)} ${prefix}${route.path}`);
    } else if (layer.name === 'router') {
      // One nested api Router (mounted at API_PREFIX by routes/index.js); the
      // probe request shape proves the mount. Feature routers are flat here.
      printRoutes(layer.handle.stack, `${prefix}/api`.replace('/api/api', '/api'));
    }
  }
}

printRoutes(app._router.stack, '');

// Real HTTP requests against the running server (integration-level).
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function probe(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: 'Bearer verification-only-secret' },
  });
  let body;
  try { body = await res.json(); } catch { body = '<non-json>'; }
  console.log(`\nGET ${path}${' ->'.padEnd(3)} ${res.status}`);
  console.log(JSON.stringify(body).slice(0, 400));
}

await probe('/api/stream/resolve/anilist/abc');           // 400 VALIDATION_ERROR
await probe('/api/stream/resolve/mal/abc');               // 400 VALIDATION_ERROR
await probe('/api/stream/resolve/anilist/16498?ep=1&language=sub'); // provider flow (mockless real net not required)
await probe('/api/stream/resolve/mal/21?ep=1&language=sub');       // provider flow
await probe('/api/stream/resolve/16498?ep=1&language=sub');        // legacy

server.close();
