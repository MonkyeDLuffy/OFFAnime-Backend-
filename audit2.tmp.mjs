process.env.LOG_LEVEL = 'error';
const { tmdbProvider } = await import('./src/providers/index.js');
for (const id of [73223, 63926, 65844, 83121, 64196]) {
  const d = await tmdbProvider.getTvDetails(id);
  console.log(`TMDB ${id} "${d.name}" first_air=${d.first_air_date}`);
  console.log('  seasons:', JSON.stringify((d.seasons ?? []).map((s) => ({ n: s.season_number, name: s.name, air: s.air_date, eps: s.episode_count }))));
}
