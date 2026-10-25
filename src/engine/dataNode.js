// Node-only loader (tests, tools, a future server). The browser uses src/ui/loadData.js with fetch().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildData, DECKS } from './data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readRawData(root = ROOT) {
  const j = rel => JSON.parse(fs.readFileSync(path.join(root, 'data', rel), 'utf8'));
  return {
    ruleset: j('ruleset.json'), map: j('map.json'), generals: j('generals.json'), items: j('items.json'),
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

export function loadData(root = ROOT, { checkRules = true } = {}) {
  return buildData(readRawData(root), checkRules ? { ruleLabels: readRuleLabels(root) } : {});
}
