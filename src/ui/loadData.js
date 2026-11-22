// Browser data loader: fetches data/*.json relative to the page and validates them with the engine's data.js.
// v31.1: both maps are loaded (Small Map 1 = data/map.json, the default; Large Map 1 = data/maps/large1.json, 21.a); `data` stays Small Map 1.
import { buildData, DECKS, MAPS, DEFAULT_MAP, validWinPrestige } from '../engine/data.js';

const getJson = async url => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not load ${url}: HTTP ${r.status}`);
  return r.json();
};

let raw = null;        // the parsed JSON, kept so a win-target dataset can be rebuilt without re-fetching
let pristine = null;   // the map-default datasets, never overwritten by a win override
const overridden = new Map();   // `${mapId}:${win}` -> the frozen dataset with that win target (identity-stable, so setMap's `data ===` check works)

export async function loadGameData(base = '') {
  const ids = Object.keys(MAPS);
  const [ruleset, generals, assets, items, ...rest] = await Promise.all([
    getJson(base + 'data/ruleset.json'), getJson(base + 'data/generals.json'), getJson(base + 'data/assets.json'), getJson(base + 'data/items.json'),
    ...DECKS.map(d => getJson(`${base}data/cards/${d}.json`)),
    ...ids.map(id => getJson(base + (id === DEFAULT_MAP ? 'data/map.json' : `data/maps/${id}.json`))),
  ]);
  const cards = Object.fromEntries(DECKS.map((d, i) => [d, rest[i]]));
  const maps = rest.slice(DECKS.length);
  raw = { ruleset, generals, items, cards, maps: Object.fromEntries(ids.map((id, i) => [id, maps[i]])) };
  // throws one Error listing every data problem (file + card id)
  const datasets = Object.fromEntries(ids.map((id, i) => [id, buildData({ ruleset, map: maps[i], generals, items, cards })]));
  pristine = datasets;
  return { data: datasets[DEFAULT_MAP], assets, datasets };
}

/** v31.39: the dataset for a map with a chosen win target. `win` null/undefined/invalid, or equal to the map default,
 * returns the pristine map dataset; anything else builds (and caches) a frozen copy with `rules.winPrestige` overridden,
 * so the engine, the AI threat line and every display read the chosen value. Unknown map id -> undefined. */
export function datasetFor(mapId, win) {
  const base = pristine?.[mapId];
  if (!base) return undefined;
  const w = validWinPrestige(win);
  if (w === null || w === base.rules.winPrestige) return base;
  const key = `${mapId}:${w}`;
  if (!overridden.has(key)) overridden.set(key, buildData({ ruleset: raw.ruleset, map: raw.maps[mapId], generals: raw.generals, items: raw.items, cards: raw.cards }, { winPrestige: w }));
  return overridden.get(key);
}
