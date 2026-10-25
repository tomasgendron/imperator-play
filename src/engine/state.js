// State factory, invariants (validateState), clone, stateHash (PLAN 3, 13.1). Pure.
import { createRng, shuffle } from './rng.js';

export const SCHEMA_VERSION = 2;   // 2 = rules update 2026-10-21: discards, players[].items/out/gameRollsTaken/startIncome, carthage.neutral
export const PROVINCE_STATUSES = ['native', 'allied', 'conquered', 'starting', 'held'];
export const OWNED_STATUSES = ['allied', 'conquered', 'starting', 'held'];
export const PHASES = ['setup', 'turn', 'finished'];
export const STEPS = ['resources', 'gameRoll', 'revoltRoll', 'actions', 'ended'];

export const clone = o => structuredClone(o);

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

/** Stable JSON: object keys sorted, so equal states always serialise (and hash) identically. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** cyrb53 over the stable serialisation: a short hex fingerprint for replay/determinism checks. */
export function stateHash(state) {
  const str = stableStringify(state);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Blank game state before setup (PLAN 3.1 to 3.3): 13 unowned provinces with random Game Roll numbers 3..8 (each used twice, 16.h),
 * rewards from the map defaults (Q5), Roma at 10 troops, Carthage natives 10, the static 54-card registry and shuffled decks.
 * Setup (roll-off, generals, start provinces) is M1 and fills players/turnOrder/startProvince.
 */
export function createBlankState(data, { seed, players = [], gameId = 'g-' + seed } = {}) {
  const rng = createRng(seed);
  const cards = {};
  const decks = { game: [], resource: [], displeased: [] };
  let n = 0;
  for (const deck of ['game', 'resource', 'displeased']) {
    const prefix = deck[0];
    for (const def of data.decks[deck]) for (let i = 0; i < def.copies; i++) {
      const uid = prefix + String(++n).padStart(2, '0');
      cards[uid] = { def: def.id, deck };
      decks[deck].push(uid);
    }
  }
  for (const deck of Object.keys(decks)) decks[deck] = shuffle(rng, decks[deck]);
  const pn = data.rules.provinceNumbers;
  const numbers = shuffle(rng, pn.values.flatMap(v => Array(pn.timesEach).fill(v)));
  const provinces = {};
  let ni = 0;
  for (const p of data.provinces) {
    const roma = p.kind === 'roma';
    provinces[p.id] = {
      id: p.id, number: roma ? null : numbers[ni++], reward: roma ? null : p.defaultReward,
      owner: null, status: 'native', troops: roma ? data.rules.romaStartTroops : 0,
      native: p.id === 'carthage'
        ? { rolled: data.rules.carthageNative[0], count: data.rules.carthageNative[0], present: data.rules.carthageNative[0] }
        : { rolled: null, count: null, present: null },
      road: false, walls: [], healAtTurn: null,
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION, gameId,
    config: { ruleset: data.ruleset.id, winPrestige: data.rules.winPrestige, startGold: data.rules.startingGold, startTroops: data.rules.startingTroops,
      actionsPerTurn: data.rules.actionsPerTurn, unusedActionGold: data.rules.unusedActionGold, seed, hideHandDefault: false },
    rng, phase: 'setup',
    players: players.map(p => ({ id: p.id, name: p.name, color: p.color ?? null, controller: p.controller ?? 'human', general: p.general ? { id: p.general, at: null } : null, startProvince: null,
      gold: data.rules.startingGold, prestige: 0, hand: [], inPlay: [], savedResources: [], generalRecalledThroughTurn: null,
      items: { catapult: 0 }, out: false, gameRollsTaken: 0, startIncome: true })),
    turnOrder: [],
    turn: { number: 0, round: 0, activePlayerId: null, step: 'resources', actionsUsed: 0, nonBattleCardPlayed: false, gameCardBought: false, bonusTroopsGained: [], revoltRollsExtra: 0, generalMoved: false, sub: {} },
    provinces, roma: { goldPile: 0, holder: null, heldSinceTurn: null }, carthage: { defeated: false, neutral: false, decreeLegionsLost: 0 },
    cards, decks, discards: { game: [], resource: [], displeased: [] }, pending: [], winner: null, eventSeq: 0, frameSeq: 0, setup: null, log: [],
  };
}

/**
 * Invariants of PLAN 13.1 (run after every action in every test). Returns a list of problems; empty = fine.
 * `opts.floor` (default true) checks the global floor of 1 on every OWNED province (Vidi 2026-10-17, Q64): a revolting province
 * leaves the owner's territory at once, so it is never an owned province with 0 troops.
 */
export function validateState(state, data, opts = {}) {
  const errs = [];
  const err = m => errs.push(m);
  const floor = opts.floor !== false;
  const isNat = n => Number.isInteger(n) && n >= 0;

  if (state.schemaVersion !== SCHEMA_VERSION) err(`schemaVersion ${state.schemaVersion} != ${SCHEMA_VERSION}`);
  if (!PHASES.includes(state.phase)) err('bad phase ' + state.phase);
  if (!state.rng || state.rng.algo !== 'sfc32' || !Array.isArray(state.rng.s) || state.rng.s.length !== 4 || !state.rng.s.every(x => Number.isInteger(x) && x >= 0 && x < 4294967296) || !isNat(state.rng.draws)) err('bad rng state');

  const pids = state.players.map(p => p.id);
  if (new Set(pids).size !== pids.length) err('duplicate player ids');
  const playerById = Object.fromEntries(state.players.map(p => [p.id, p]));
  if (state.turnOrder.length) {
    if ([...state.turnOrder].sort().join() !== [...pids].sort().join()) err('turnOrder is not a permutation of the players');
  } else if (state.phase !== 'setup') err('turnOrder is empty after setup');

  // provinces
  const ids = Object.keys(state.provinces).sort();
  if (ids.join() !== data.provinceIds.join()) err('provinces do not match map.json');
  const startingByOwner = {};
  for (const id of ids) {
    const p = state.provinces[id];
    if (!p) continue;
    const def = data.provincesById[id];
    if (p.id !== id) err(`${id}: id mismatch`);
    if (!PROVINCE_STATUSES.includes(p.status)) err(`${id}: bad status ${p.status}`);
    if (!isNat(p.troops)) err(`${id}: troops ${p.troops}`);
    if (p.owner !== null && !playerById[p.owner]) err(`${id}: owner ${p.owner} is not a player`);
    if (p.owner === null && p.status !== 'native') err(`${id}: unowned but status ${p.status}`);
    if (p.owner !== null && !OWNED_STATUSES.includes(p.status)) err(`${id}: owned but status ${p.status}`);
    if (p.status === 'held' && id !== 'roma') err(`${id}: only Roma can be held`);
    if (id === 'roma' && p.owner !== null && p.status !== 'held') err('roma: owned but not held');
    // starting flag is tied to the ORIGINAL owner (Q62, Q65)
    if (p.status === 'starting') {
      if (p.startingOf !== p.owner) err(`${id}: status starting needs startingOf == owner`);
      if (p.owner !== null) {
        if (playerById[p.owner]?.startProvince !== id) err(`${id}: starting province is not ${p.owner}'s startProvince`);
        if (startingByOwner[p.owner]) err(`${p.owner} has two starting provinces`);
        startingByOwner[p.owner] = id;
      }
    } else if (p.startingOf !== undefined && p.startingOf !== null) err(`${id}: startingOf set while status is ${p.status}`);
    if (floor && p.owner !== null && p.troops < data.rules.provinceFloor) err(`${id}: owned province below the floor of ${data.rules.provinceFloor} (troops ${p.troops})`);
    if (p.owner === null && id !== 'roma' && p.troops !== 0) err(`${id}: unowned province holds ${p.troops} own troops`);
    const nat = p.native;
    if (!nat || !['rolled', 'count', 'present'].every(k => nat[k] === null || isNat(nat[k]))) err(`${id}: bad native numbers`);
    else if (nat.count !== null && nat.present !== null && nat.present > nat.count) err(`${id}: natives present ${nat.present} > count ${nat.count}`);
    if (def?.kind !== 'roma') {
      if (!(Number.isInteger(p.number) && p.number >= 3 && p.number <= 8)) err(`${id}: number ${p.number}`);
      if (!['troop', 'gold'].includes(p.reward)) err(`${id}: reward ${p.reward}`);
    } else if (p.number !== null || p.reward !== null) err('roma has no number or reward');
    const neighbours = new Set([...(def?.land || []), ...(def?.sea || [])]);
    for (const w of p.walls || []) if (!neighbours.has(w)) err(`${id}: wall faces non-neighbour ${w}`);
    if (new Set(p.walls).size !== (p.walls || []).length) err(`${id}: duplicate wall side`);
  }
  // each starting player's start province must be starting while they still own the original (or not starting once captured)
  for (const pl of state.players) {
    if (pl.startProvince !== null && !data.provincesById[pl.startProvince]) err(`${pl.id}: startProvince ${pl.startProvince} unknown`);
    if (pl.startProvince !== null && data.provincesById[pl.startProvince]?.startingEligible === false) err(`${pl.id}: ineligible start province ${pl.startProvince}`);
    if (!isNat(pl.gold)) err(`${pl.id}: gold ${pl.gold}`);
    if (!isNat(pl.prestige)) err(`${pl.id}: prestige ${pl.prestige}`);
    if (pl.general && pl.general.at !== null && !data.provincesById[pl.general.at]) err(`${pl.id}: general at unknown ${pl.general.at}`);
    if (pl.general && !data.generalsById[pl.general.id]) err(`${pl.id}: unknown general ${pl.general.id}`);
    if (!pl.items || !isNat(pl.items.catapult)) err(`${pl.id}: items.catapult must be a whole number (19.u)`);
    if (pl.out && Object.values(state.provinces).some(p => p.owner === pl.id)) err(`${pl.id}: eliminated but still owns a province (12.m)`);
    if (pl.out && (pl.hand.length || pl.inPlay.length || pl.savedResources.length)) err(`${pl.id}: eliminated but still holds cards`);
  }
  if (state.turnOrder.length && state.phase === 'turn' && playerById[state.turn.activePlayerId]?.out && !state.pending.length) err('the active player is eliminated');
  // Roma holder consistency
  const roma = state.provinces.roma;
  if (roma) {
    if ((state.roma.holder ?? null) !== roma.owner) err('roma.holder differs from provinces.roma.owner');
    if (roma.troops > data.rules.romaMaxTroops) err(`roma: ${roma.troops} troops > cap ${data.rules.romaMaxTroops} (12.k)`);
  }
  // cards: conserved across decks + hands + inPlay + savedResources
  const uids = Object.keys(state.cards);
  const expected = data.rules.deckSizes.game + data.rules.deckSizes.resource + data.rules.deckSizes.displeased;
  if (uids.length !== expected) err(`card registry has ${uids.length} cards, expected ${expected}`);
  const seen = new Map();
  const see = (uid, where) => { seen.set(uid, [...(seen.get(uid) || []), where]); };
  for (const [deck, list] of Object.entries(state.decks)) for (const uid of list) {
    see(uid, 'deck:' + deck);
    if (state.cards[uid] && state.cards[uid].deck !== deck) err(`card ${uid} sits in deck ${deck} but belongs to ${state.cards[uid].deck}`);
  }
  if (!state.discards) err('missing discards (18.l)');
  else for (const [deck, list] of Object.entries(state.discards)) for (const uid of list) {
    see(uid, 'discard:' + deck);
    if (state.cards[uid] && state.cards[uid].deck !== deck) err(`card ${uid} sits in discard ${deck} but belongs to ${state.cards[uid].deck}`);
  }
  for (const pl of state.players) {
    for (const c of pl.hand) see(c.uid, 'hand:' + pl.id);
    for (const c of pl.inPlay) see(c.uid, 'inPlay:' + pl.id);
    for (const c of pl.savedResources) see(c.uid, 'saved:' + pl.id);
  }
  for (const uid of uids) {
    const w = seen.get(uid) || [];
    if (w.length !== 1) err(`card ${uid} appears ${w.length} times (${w.join(', ') || 'nowhere'})`);
    if (!data.cardDefsById[state.cards[uid].def]) err(`card ${uid} has unknown def ${state.cards[uid].def}`);
  }
  for (const uid of seen.keys()) if (!state.cards[uid]) err(`unknown card uid ${uid}`);
  // frames reference real players/provinces
  const provinceKeys = ['province', 'from', 'target', 'origin', 'to'];
  for (const f of state.pending) {
    if (f.player !== undefined && f.player !== null && !playerById[f.player]) err(`frame ${f.id}: unknown player ${f.player}`);
    for (const r of f.resolvableBy || []) if (!playerById[r]) err(`frame ${f.id}: unknown resolvableBy ${r}`);
    for (const k of provinceKeys) if (f[k] !== undefined && f[k] !== null && !data.provincesById[f[k]]) err(`frame ${f.id}: unknown province ${f[k]}`);
    if (f.kind === 'chooseProvince' && Array.isArray(f.options)) for (const o of f.options) if (typeof o === 'string' && !data.provincesById[o]) err(`frame ${f.id}: unknown option ${o}`);
  }
  // turn / winner
  if (state.turn.actionsUsed > data.rules.actionsPerTurn) err(`actionsUsed ${state.turn.actionsUsed} > ${data.rules.actionsPerTurn}`);
  if (state.turn.step !== undefined && !STEPS.includes(state.turn.step)) err('bad turn.step ' + state.turn.step);
  if (state.winner !== null) {
    if (!playerById[state.winner]) err('winner is not a player');
    else if (playerById[state.winner].prestige < data.rules.winPrestige && !state.players.every(p => p.id === state.winner || p.out)) err(`winner has ${playerById[state.winner].prestige} Prestige < ${data.rules.winPrestige} and is not the last player standing (12.m, Q76)`);
    if (state.phase !== 'finished') err('winner set but phase is not finished');
  } else if (state.phase === 'finished') err('phase finished without a winner');
  const top = state.players.filter(p => p.prestige >= data.rules.winPrestige);
  if (top.length > 1 && state.winner === null) err('several players at the winning Prestige and no winner');
  return errs;
}

export function assertValidState(state, data, opts) {
  const errs = validateState(state, data, opts);
  if (errs.length) throw new Error('Invalid state:\n  ' + errs.join('\n  '));
  return state;
}
