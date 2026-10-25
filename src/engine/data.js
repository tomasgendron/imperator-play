// Loads/validates data/*.json (PLAN 5.1, 5.2). PURE: no I/O here, callers hand over the parsed JSON
// (Node: dataNode.js, browser: src/ui/loadData.js). Fails loudly with the file and card id.
import { isDeclared, PERK_HOOKS } from './registry.js';

export const DECKS = ['game', 'resource', 'displeased', 'decree'];
export const CARD_TYPES = ['battle', 'other'];
export const KINDS = {
  game: ['battle', 'action', 'reaction', 'enabler', 'auto'],
  resource: ['auto', 'buildOrSave'],
  displeased: ['auto'],
  decree: ['decree'],
};
export const PLAY_WINDOWS = ['battleCards', 'ownActionsStep', 'revoltResponse', 'attackRoma', 'displeasedResponse', 'defenceAnnounced'];
export const ON_DRAW = ['keep', 'autoPlay', 'autoPlayInPlay', 'applyNow', 'buildOrSave'];
const PROVINCE_STATUS_REWARD = ['troop', 'gold'];

const isInt = n => Number.isInteger(n);
const isStr = s => typeof s === 'string' && s.length > 0;

/** @returns {string[]} error messages, empty when the data is valid. `opts.ruleLabels` (Set) enables rule-label checks. */
export function validateData(raw, opts = {}) {
  const errs = [];
  const err = (file, id, msg) => errs.push(`${file}${id ? ' [' + id + ']' : ''}: ${msg}`);
  const labels = opts.ruleLabels;
  const checkRules = (file, id, rules) => {
    if (!Array.isArray(rules) || rules.length === 0) return err(file, id, '`rule` must be a non-empty array');
    if (labels) for (const r of rules) if (!labels.has(r)) err(file, id, `rule label ${r} not found in rules.md`);
  };

  // ---- ruleset
  const rs = raw.ruleset?.values;
  if (!rs) err('ruleset.json', null, 'missing `values`');
  else for (const [k, e] of Object.entries(rs)) {
    if (!e || !('value' in e)) err('ruleset.json', k, 'entry needs a `value`');
    if (!e || !isStr(e.rule)) err('ruleset.json', k, 'entry needs a `rule` label string');
  }
  const R = k => rs?.[k]?.value;

  // ---- map
  const provinces = raw.map?.provinces;
  const pids = new Set();
  if (!Array.isArray(provinces) || provinces.length !== 13) err('map.json', null, 'needs exactly 13 provinces');
  else {
    for (const p of provinces) {
      if (!isStr(p.id)) { err('map.json', null, 'province without id'); continue; }
      if (pids.has(p.id)) err('map.json', p.id, 'duplicate id');
      pids.add(p.id);
    }
    for (const p of provinces) {
      if (!isStr(p.name)) err('map.json', p.id, 'missing name');
      if (!p.token || typeof p.token.x !== 'number' || typeof p.token.y !== 'number') err('map.json', p.id, 'token {x,y} required');
      if (typeof p.startingEligible !== 'boolean') err('map.json', p.id, '`startingEligible` boolean required');
      if (p.kind !== 'roma' && !PROVINCE_STATUS_REWARD.includes(p.defaultReward)) err('map.json', p.id, '`defaultReward` must be troop|gold');
      for (const kind of ['land', 'sea']) for (const q of p[kind] || []) {
        const other = provinces.find(x => x.id === q);
        if (!other) err('map.json', p.id, `${kind} neighbour ${q} does not exist`);
        else if (!(other[kind] || []).includes(p.id)) err('map.json', p.id, `${kind} link to ${q} is not symmetric`);
      }
    }
    const notEligible = provinces.filter(p => !p.startingEligible).map(p => p.id).sort().join(',');
    const excluded = [...(R('startProvinceExcluded') || [])].sort().join(',');
    if (notEligible !== excluded) err('map.json', null, `startingEligible=false (${notEligible}) must equal ruleset startProvinceExcluded (${excluded})`);
  }

  // ---- generals
  const gen = raw.generals?.generals;
  const generalIds = new Set();
  for (const [k, line] of (raw.generals?.common || []).entries()) { if (!isStr(line?.text)) err('generals.json', `common[${k}]`, 'text required'); checkRules('generals.json', `common[${k}]`, line?.rule); }
  if (!Array.isArray(gen) || gen.length === 0) err('generals.json', null, 'missing generals');
  else for (const g of gen) {
    if (!isStr(g.id) || generalIds.has(g.id)) { err('generals.json', g.id, 'missing or duplicate id'); continue; }
    generalIds.add(g.id);
    if (!isStr(g.name) || !isStr(g.text)) err('generals.json', g.id, 'name and text required');
    checkRules('generals.json', g.id, g.rule);
    if (!isStr(g.quote) || !Array.isArray(g.intro)) err('generals.json', g.id, 'quote and intro required (M8.1 general view)');
    for (const [k, line] of (g.intro || []).entries()) { if (!isStr(line?.text)) err('generals.json', `${g.id}.intro[${k}]`, 'text required'); checkRules('generals.json', `${g.id}.intro[${k}]`, line?.rule); }
    const perkIds = new Set((g.perks || []).map(p => p.id));
    for (const p of g.perks || []) {
      if (!isStr(p.id)) err('generals.json', g.id, 'perk without id');
      if (p.handler !== undefined && !isDeclared('perk', p.handler)) err('generals.json', `${g.id}.${p.id}`, `unknown perk handler "${p.handler}"`);
      if (p.handler === undefined && !Array.isArray(p.modifiers)) err('generals.json', `${g.id}.${p.id}`, 'perk needs a handler or modifiers');
      for (const h of p.hooks || []) if (!PERK_HOOKS.includes(h)) err('generals.json', `${g.id}.${p.id}`, `unknown hook ${h}`);
      for (const x of p.exclusiveWith || []) if (!perkIds.has(x)) err('generals.json', `${g.id}.${p.id}`, `exclusiveWith ${x} is not a perk of this general`);
      if (typeof p.needsWithArmy !== 'boolean') err('generals.json', `${g.id}.${p.id}`, '`needsWithArmy` boolean required (15.f)');
      if (!isStr(p.name) || !isStr(p.when) || !Array.isArray(p.detail) || !p.detail.length) err('generals.json', `${g.id}.${p.id}`, 'perk needs name, when and detail (M8.1 general view)');
      for (const [k, line] of (p.detail || []).entries()) { if (!isStr(line?.text)) err('generals.json', `${g.id}.${p.id}.detail[${k}]`, 'text required'); checkRules('generals.json', `${g.id}.${p.id}.detail[${k}]`, line?.rule); }
    }
  }

  // ---- cards
  const cardIds = new Set();
  const decksIn = raw.cards || {};
  const sizes = R('deckSizes') || {};
  for (const deck of DECKS) {
    const file = `cards/${deck}.json`;
    const list = decksIn[deck]?.cards;
    if (!Array.isArray(list) || list.length === 0) { err(file, null, 'missing cards'); continue; }
    let copies = 0;
    for (const c of list) {
      const id = c.id;
      if (!isStr(id)) { err(file, null, 'card without id'); continue; }
      if (cardIds.has(id)) err(file, id, 'duplicate card id (ids are unique across all decks)');
      cardIds.add(id);
      if (c.deck !== deck) err(file, id, `\`deck\` is "${c.deck}", expected "${deck}"`);
      if (!isInt(c.copies) || c.copies < 1) err(file, id, '`copies` must be an integer >= 1'); else copies += c.copies;
      if (!isStr(c.name)) err(file, id, '`name` required');
      if (!isStr(c.text)) err(file, id, '`text` required');
      if (!KINDS[deck].includes(c.kind)) err(file, id, `\`kind\` "${c.kind}" not allowed in deck ${deck} (${KINDS[deck].join('|')})`);
      if (!CARD_TYPES.includes(c.type)) err(file, id, `\`type\` is required and must be "battle" or "other" (got ${JSON.stringify(c.type)})`);
      checkRules(file, id, c.rule);
      if (!c.art || !isStr(c.art.front)) err(file, id, '`art.front` path required');
      if (c.onDraw !== undefined && !ON_DRAW.includes(c.onDraw)) err(file, id, `unknown onDraw "${c.onDraw}"`);
      if (c.unique && !(c.unique.scope === 'player' && isStr(c.unique.onDuplicate))) err(file, id, '`unique` needs scope "player" and onDuplicate');
      if (c.play) {
        for (const w of c.play.windows || []) if (!PLAY_WINDOWS.includes(w)) err(file, id, `unknown play window "${w}"`);
        if (!isInt(c.play.delayTurns) || c.play.delayTurns < 0) err(file, id, '`play.delayTurns` integer >= 0 required');
        if (typeof c.play.usesTurnCardSlot !== 'boolean') err(file, id, '`play.usesTurnCardSlot` boolean required');
      }
      if (c.type === 'battle') {
        // PLAN 5.2 `type` row: battle cards are playable in battleCards, never use the turn slot, never wait a turn (18.h).
        if (!c.play?.windows?.includes('battleCards')) err(file, id, 'type "battle" requires play.windows to contain "battleCards"');
        if (c.play?.usesTurnCardSlot !== false) err(file, id, 'type "battle" requires play.usesTurnCardSlot false (18.h)');
        if (c.play?.delayTurns !== 0) err(file, id, 'type "battle" requires play.delayTurns 0 (18.h)');
      } else if (c.play?.windows?.includes('battleCards')) err(file, id, 'only type "battle" cards may use the battleCards window');
      if (c.effect) {
        const kind = deck === 'decree' ? 'decree' : 'effect';
        if (!isStr(c.effect.handler)) err(file, id, '`effect.handler` required');
        else if (!isDeclared(kind, c.effect.handler)) err(file, id, `unknown ${kind} handler "${c.effect.handler}" (declare it in registry.js)`);
      } else if (!Array.isArray(c.modifiers)) err(file, id, 'card needs an `effect` or `modifiers`');
      if (deck === 'decree') {
        if (!Array.isArray(c.numbers) || c.numbers.join() !== (R('decreeNumbers') || []).join()) err(file, id, '`numbers` must equal ruleset decreeNumbers');
        if (!c.activeWhen) err(file, id, '`activeWhen` required on decree cards');
      }
    }
    if (sizes[deck] !== undefined && copies !== sizes[deck]) err(file, null, `${copies} cards in total, ruleset deckSizes.${deck} says ${sizes[deck]}`);
  }
  // ---- items (19.u; optional file, Vidi 2026-10-21)
  for (const it of raw.items?.items || []) {
    if (!isStr(it.id) || !isStr(it.name) || !isStr(it.text)) err('items.json', it.id, 'id, name and text required');
    checkRules('items.json', it.id, it.rule);
    if (!isInt(it.cost?.gold) || it.cost.gold < 0) err('items.json', it.id, '`cost.gold` integer >= 0 required');
    if (!it.art || !isStr(it.art.front)) err('items.json', it.id, '`art.front` path required');
  }
  return errs;
}

/** Validates and returns an immutable, indexed data bundle. Throws one Error listing every problem. */
export function buildData(raw, opts = {}) {
  const errs = validateData(raw, opts);
  if (errs.length) throw new Error('Invalid game data:\n  ' + errs.join('\n  '));
  const rules = {};
  for (const [k, e] of Object.entries(raw.ruleset.values)) rules[k] = e.value;
  const provinces = raw.map.provinces;
  const cardDefs = DECKS.flatMap(d => raw.cards[d].cards);
  const data = {
    ruleset: raw.ruleset, rules, map: raw.map, provinces,
    provincesById: Object.fromEntries(provinces.map(p => [p.id, p])),
    provinceIds: provinces.map(p => p.id).sort(),
    generals: raw.generals.generals,
    generalCommon: raw.generals.common ?? [],
    generalsById: Object.fromEntries(raw.generals.generals.map(g => [g.id, g])),
    cardDefs,
    cardDefsById: Object.fromEntries(cardDefs.map(c => [c.id, c])),
    decks: Object.fromEntries(DECKS.map(d => [d, raw.cards[d].cards])),
    items: raw.items?.items ?? [],
    itemsById: Object.fromEntries((raw.items?.items ?? []).map(i => [i.id, i])),
  };
  return deepFreezeData(data);
}

function deepFreezeData(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreezeData(v); }
  return o;
}

/** Handlers named by the data, per kind (for the "declared but unused" registry test). */
export function usedHandlers(data) {
  const used = { effect: new Set(), perk: new Set(), decree: new Set() };
  for (const c of data.cardDefs) if (c.effect?.handler) used[c.deck === 'decree' ? 'decree' : 'effect'].add(c.effect.handler);
  for (const g of data.generals) for (const p of g.perks) if (p.handler) used.perk.add(p.handler);
  return used;
}
