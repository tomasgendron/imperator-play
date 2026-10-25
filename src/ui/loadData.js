// Browser data loader: fetches data/*.json relative to the page and validates them with the engine's data.js.
import { buildData, DECKS } from '../engine/data.js';

const getJson = async url => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not load ${url}: HTTP ${r.status}`);
  return r.json();
};

export async function loadGameData(base = '') {
  const [ruleset, map, generals, assets, items, ...decks] = await Promise.all([
    getJson(base + 'data/ruleset.json'), getJson(base + 'data/map.json'), getJson(base + 'data/generals.json'), getJson(base + 'data/assets.json'), getJson(base + 'data/items.json'),
    ...DECKS.map(d => getJson(`${base}data/cards/${d}.json`)),
  ]);
  const raw = { ruleset, map, generals, items, cards: Object.fromEntries(DECKS.map((d, i) => [d, decks[i]])) };
  return { data: buildData(raw), assets };   // throws one Error listing every data problem (file + card id)
}
