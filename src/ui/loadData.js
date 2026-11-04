// Browser data loader: fetches data/*.json relative to the page and validates them with the engine's data.js.
// v31.1: both maps are loaded (Small Map 1 = data/map.json, the default; Large Map 1 = data/maps/large1.json, 21.a); `data` stays Small Map 1.
import { buildData, DECKS, MAPS, DEFAULT_MAP } from '../engine/data.js';

const getJson = async url => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not load ${url}: HTTP ${r.status}`);
  return r.json();
};

export async function loadGameData(base = '') {
  const ids = Object.keys(MAPS);
  const [ruleset, generals, assets, items, ...rest] = await Promise.all([
    getJson(base + 'data/ruleset.json'), getJson(base + 'data/generals.json'), getJson(base + 'data/assets.json'), getJson(base + 'data/items.json'),
    ...DECKS.map(d => getJson(`${base}data/cards/${d}.json`)),
    ...ids.map(id => getJson(base + (id === DEFAULT_MAP ? 'data/map.json' : `data/maps/${id}.json`))),
  ]);
  const cards = Object.fromEntries(DECKS.map((d, i) => [d, rest[i]]));
  const maps = rest.slice(DECKS.length);
  // throws one Error listing every data problem (file + card id)
  const datasets = Object.fromEntries(ids.map((id, i) => [id, buildData({ ruleset, map: maps[i], generals, items, cards })]));
  return { data: datasets[DEFAULT_MAP], assets, datasets };
}
