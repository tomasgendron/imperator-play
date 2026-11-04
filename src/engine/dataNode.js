// Node-only loader (tests, tools, a future server). The browser uses src/ui/loadData.js with fetch().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildData, DECKS, DEFAULT_MAP } from './data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** v31: `map` = 'small1' (data/map.json, the default) or another id (data/maps/<id>.json, rules 21.a). */
export function readRawData(root = ROOT, { map = DEFAULT_MAP } = {}) {
  const j = rel => JSON.parse(fs.readFileSync(path.join(root, 'data', rel), 'utf8'));
  return {
    ruleset: j('ruleset.json'), map: j(map === DEFAULT_MAP ? 'map.json' : `maps/${map}.json`), generals: j('generals.json'), items: j('items.json'),
    cards: Object.fromEntries(DECKS.map(d => [d, j(`cards/${d}.json`)])),
  };
}

/** Rule labels found in rules.md (e.g. "16.n"), used to check `rule` references in the data. */
export function readRuleLabels(root = ROOT) {
  const labels = new Set();
  for (const line of fs.readFileSync(path.join(root, 'rules.md'), 'utf8').split('\n')) {
    const m = line.match(/^\*\*(\d{1,2}\.[a-z]{1,2})\*\*/);
    if (m) labels.add(m[1]);
  }
  return labels;
}

export function loadData(root = ROOT, { checkRules = true, map = DEFAULT_MAP } = {}) {
  return buildData(readRawData(root, { map }), checkRules ? { ruleLabels: readRuleLabels(root) } : {});
}
