process.env.LOG_LEVEL = 'error';
const { createApp } = await import('./src/app.js');
const { config } = await import('./src/config/env.js');
const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { Authorization: `Bearer ${config.BACKEND_API_SECRET}` };
async function probe(id) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${base}/api/tmdb/${id}`, { headers });
    const body = await res.json().catch(() => null);
    if (res.status === 200) return body;
    if (i === 2) return { status: res.status, error: body?.error?.code };
    await new Promise((r) => setTimeout(r, 500));
  }
}
for (const [label, id] of [['BC S1', 97940], ['BC S2', 195604], ['BC movie', 131680], ['OPM S1', 21087], ['OPM S2', 97668], ['Overlord II', 98437], ['KonoSuba S2', 21699], ['Kaguya S2', 112641], ['Kaguya S3', 125367]]) {
  const b = await probe(id);
  console.log(`${label} (${id}):`, JSON.stringify({ resolved: b?.resolved, tmdbId: b?.tmdbId, season: b?.tmdbSeasonNumber ?? null, reason: b?.reason }));
}
await new Promise((r) => server.close(r));
setTimeout(() => process.exit(0), 50).unref();
