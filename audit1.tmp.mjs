process.env.LOG_LEVEL = 'error';
const { anilistProvider, tmdbProvider } = await import('./src/providers/index.js');

async function anilistSearch(q) {
  const page = await anilistProvider.searchAnime(q, { perPage: 10 });
  return (page.media ?? []).map((a) => ({ id: a.id, title: a.title.romaji, en: a.title.english, format: a.format, year: a.seasonYear, syn: a.synonyms }));
}
async function tmdbSearch(q) {
  const raw = await tmdbProvider.searchTv(q);
  return (raw.results ?? []).slice(0, 4).map((r) => ({ id: r.id, name: r.name, original: r.original_name, firstAir: r.first_air_date }));
}

for (const q of ['Black Clover', 'One Punch Man', 'Kono Subarashii Sekai ni Shukufuku wo', 'Kaguya-sama wa Kokurasetai', 'Overlord']) {
  console.log(`=== AniList: ${q} ===`);
  try { for (const r of await anilistSearch(q)) console.log(JSON.stringify(r)); } catch (e) { console.log('ERR', e.message); }
}

console.log('=== TMDB search TV ===');
for (const q of ['Black Clover', 'One Punch Man', 'Kono Subarashii Sekai ni Shukufuku wo', 'Kaguya-sama: Love is War', 'Overlord']) {
  console.log(`-- ${q}`);
  try { for (const r of await tmdbSearch(q)) console.log(JSON.stringify(r)); } catch (e) { console.log('ERR', e.message); }
}
