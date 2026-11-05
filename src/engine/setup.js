// Game creation and the setup flow (PLAN 3.5, 4.4 assignStartProvinces, 8.2; rules 4.a-4.c, 20.l, 20.n, Q1-Q4, Q55).
// Flow: roll-off (d10 each, ties re-roll among the tied) -> generals (reverse turn order) -> start provinces (random deal or picks;
// v31: on a map with fixed starts, 21.f, always picks in turn order, the highest roll-off first)
// -> start natives (d6 each) -> phase "turn". Each step is a frame resolved by an action; nothing rolls on its own.
import { createBlankState } from './state.js';
import { createRng, shuffle, int } from './rng.js';
import { applyAction } from './apply.js';
import { fail, check, emit, roll, pushFrame, popFrame, makeCtx, mustPlayer, onSettle, settle, playerOf } from './core.js';
import { define, defineRoll } from './actions.js';
import { distances } from './selectors.js';

export const PALETTE = ['#c0392b', '#2471a3', '#1e8449', '#8e44ad', '#b9770e', '#117a8b'];

// ------------------------------------------------------------------ start provinces (PLAN 4.4)
const combos = (arr, k) => {
  const out = [];
  const rec = (start, cur) => { if (cur.length === k) { out.push(cur.slice()); return; } for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); } };
  rec(0, []);
  return out;
};

// ------------------------------------------------------------------ 2-player sides (4.g, 15.i, 20.o; Vidi 2026-10-25)
/** Do the west/east sides apply to an n-player game? */
export const sidesApply = (data, n) => !!data.rules.twoPlayerSides && n === data.rules.twoPlayerSides.players;
/** 'west' | 'east' | null (Swiss, Germanica, Roma, Carthage). */
export const sideOf = (data, id) => (data.rules.twoPlayerSides ? ['west', 'east'].find(k => data.rules.twoPlayerSides[k].includes(id)) : null) ?? null;
export const sideProvinces = (data, side) => data.rules.twoPlayerSides[side].filter(id => data.provincesById[id]?.startingEligible);
export const OTHER_SIDE = { west: 'east', east: 'west' };
export const SIDE_NAMES = { west: 'West', east: 'East' };
/** v31 (21.f): the fixed start provinces of an n-player game on this map, or null. */
export const fixedStartsFor = (data, n) => data.rules.fixedStarts?.[n] ?? null;
/** v31 (21.f): with fixed starts the seats pick in turn order (the highest roll-off first); otherwise in reverse turn order (4.b). */
export const startPickOrder = (state, data) => (fixedStartsFor(data, state.players.length) && data.rules.fixedStartPickOrder === 'rollOffHighestFirst' ? [...state.turnOrder] : [...state.turnOrder].reverse());
/** Can `id` be a start province in an n-player game at all? (4.b; 4.g / 21.g in a 2-player game; 21.f fixed starts) */
export const startAllowed = (data, n, id) => !!data.provincesById[id]?.startingEligible && (!sidesApply(data, n) || sideOf(data, id) !== null) && (!fixedStartsFor(data, n) || fixedStartsFor(data, n).includes(id));
/** "West (Britain, Gaul, ...)" for this map (4.g, 21.g). */
export const sideLabel = (data, side) => `${SIDE_NAMES[side]} (${sideProvinces(data, side).map(x => data.provincesById[x].name).join(', ')})`;

/** Shortest-path distance matrix over the whole map graph (Roma and Carthage may be passed through, Q55). */
export function distanceMatrix(data) {
  return Object.fromEntries(data.provinceIds.map(id => [id, distances(data, id)]));
}

/**
 * Deals `n` start provinces (PLAN 4.4). Candidates = startingEligible provinces (never Carthage or Roma). Tier 1: every pair at distance >= 3.
 * Tier 2 (fallback only): the documented Mauretania-Egypt exception. Tier 3: relax the distance to 2, then 1. ONE valid set is picked
 * uniformly with the seeded RNG, then the provinces are assigned to the players in a second uniform shuffle.
 * Mutates `rng`. Returns {assignments:[province per player], requestedDistance, usedDistance, fallbackUsed, exceptionsUsed}.
 */
export function assignStartProvinces(rng, data, n) {
  const fixed = fixedStartsFor(data, n);
  if (fixed) {   // 21.f: the fixed starts (checked against 20.o when the data is built); a seeded deal for callers that deal
    const D = distanceMatrix(data); const want = data.rules.startProvinceMinDistance;
    return { assignments: shuffle(rng, fixed), requestedDistance: want, usedDistance: Math.min(...fixed.flatMap((a, i) => fixed.slice(i + 1).map(b => D[a][b]))), fallbackUsed: false, exceptionsUsed: [], tier: 1, candidates: 1, fixed: true };
  }
  if (sidesApply(data, n)) {   // 4.g: the sides are dealt at random, then a random start on each side; a pair that breaks 20.o is re-dealt
    const sides = shuffle(rng, ['west', 'east']); const D = distanceMatrix(data); const want = data.rules.startProvinceMinDistance;
    const all = []; for (const a of sideProvinces(data, sides[0])) for (const b of sideProvinces(data, sides[1])) all.push([a, b]);
    const pairs = all.filter(([a, b]) => D[a][b] >= want);
    const pool = pairs.length ? pairs : all;
    const set = pool[int(rng, pool.length) - 1];
    return { assignments: set, sides, requestedDistance: want, usedDistance: pairs.length ? want : Math.min(...all.map(([a, b]) => D[a][b])), fallbackUsed: !pairs.length, exceptionsUsed: [], tier: pairs.length ? 1 : 3, candidates: pool.length };
  }
  const cand = data.provinceIds.filter(id => data.provincesById[id].startingEligible);
  if (n > cand.length) fail('TOO_MANY_PLAYERS', `Only ${cand.length} provinces can be start provinces.`, '4.b');
  const D = distanceMatrix(data);
  const want = data.rules.startProvinceMinDistance;
  const exceptions = data.rules.startDistanceExceptions.filter(e => e.appliesWhen === 'fallback');
  const isEx = (a, b) => exceptions.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  const valid = (d, useEx) => combos(cand, n).filter(set => set.every((a, i) => set.slice(i + 1).every(b => D[a][b] >= d || (useEx && isEx(a, b)))));
  let sets = valid(want, false), used = want, tier = 1;
  if (!sets.length) { sets = valid(want, true); tier = 2; }
  for (let d = want - 1; !sets.length && d >= 1; d--) { sets = valid(d, true); used = d; tier = 3; }
  if (!sets.length) fail('NO_START_SET', 'No valid set of start provinces exists.', '4.b');
  const set = sets[int(rng, sets.length) - 1];
  const assignments = shuffle(rng, set);
  const exceptionsUsed = tier === 1 ? [] : exceptions.filter(e => set.includes(e.a) && set.includes(e.b) && D[e.a][e.b] < used).map(e => [e.a, e.b]);
  return { assignments, requestedDistance: want, usedDistance: used, fallbackUsed: tier > 1, exceptionsUsed, tier, candidates: sets.length };
}

// ------------------------------------------------------------------ setup validation (M4: the setup screen and createGame share it)
export const CONTROLLERS = ['human', 'ai'];
/**
 * Checks a setup before a game is created (M4, PLAN 8.2): 2-3 seats, names, Human/AI, generals unique, and Selected start provinces
 * by the same rule as the random deal and the hand picks (startingEligible: never Carthage or Roma; 2+ provinces between starts,
 * i.e. distance >= startProvinceMinDistance, listed exceptions allowed; the seats still to pick must keep room).
 * setup = {players: [{name, controller?, general?, startProvince?}], startProvinceMode?}. Returns {ok, errors: [{seat, field, code, message}]}.
 */
export function validateSetup(data, { players = [], startProvinceMode = data.rules.startProvinceMode, allowCloseStarts = false } = {}) {
  const errors = []; const err = (seat, field, code, message) => errors.push({ seat, field, code, message });
  const max = Math.min(data.rules.maxPlayers, data.generals.length);
  if (players.length < 2) err(null, 'players', 'BAD_PLAYERS', 'A game needs at least 2 players.');
  if (players.length > max) err(null, 'players', 'TOO_MANY_PLAYERS', `At most ${max} players.`);
  const mode = startProvinceMode === 'selected' ? 'pick' : startProvinceMode;
  if (!['random', 'pick'].includes(mode)) err(null, 'startProvinceMode', 'BAD_OPTION', 'Start provinces are "random" or "selected" (15.i, 21.h: no general-based starts).');
  const fixed = fixedStartsFor(data, players.length);
  const gens = [];
  players.forEach((p, i) => {
    if (p.name !== undefined && !String(p.name).trim()) err(i, 'name', 'BAD_NAME', `Seat ${i + 1} needs a name.`);
    if (p.controller !== undefined && !CONTROLLERS.includes(p.controller)) err(i, 'controller', 'BAD_CONTROLLER', `Seat ${i + 1} is Human or AI.`);
    if (p.general && p.general !== 'random') {
      if (!data.generalsById[p.general]) err(i, 'general', 'UNKNOWN_GENERAL', `Unknown general "${p.general}".`);
      else if (gens.includes(p.general)) err(i, 'general', 'GENERAL_TAKEN', `Two players cannot have the same general: ${data.generalsById[p.general].name} is already taken (15.e).`);
      gens.push(p.general);
    }
  });
  const starts = players.map((p, i) => [i, p.startProvince]).filter(([, id]) => id && id !== 'random');   // 'random' = "Random for this seat" (v29.1)
  const two = sidesApply(data, players.length);
  const sidesSet = players.map(p => p.startSide).filter(Boolean);
  if (sidesSet.some(x => !OTHER_SIDE[x])) err(null, 'startSide', 'BAD_OPTION', 'A start side is "west" or "east" (4.g).');
  else if (sidesSet.length && (!two || mode !== 'pick')) err(null, 'startSide', 'BAD_OPTION', 'Start sides are only chosen in a 2-player game with Selected starts (4.g).');
  else if (new Set(sidesSet).size < sidesSet.length) err(null, 'startSide', 'START_SAME_SIDE', 'The two players start on different sides, one west and one east (4.g).');
  if (starts.length && mode !== 'pick') err(null, 'startProvince', 'BAD_OPTION', 'Start provinces can only be set with Selected starts.');
  else if (starts.length && fixed) err(null, 'startProvince', 'START_PICKED_AFTER_ROLL_OFF', `On ${data.mapName ?? 'this map'} the ${players.length} starts are ${fixed.map(x => data.provincesById[x].name).join(', ')}: each player picks one after the roll-off, the highest roll first (21.f).`);
  const D = new Map(); const dist = x => D.get(x) ?? (D.set(x, distances(data, x)), D.get(x));
  const isEx = (a, b) => data.rules.startDistanceExceptions.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  const placed = [];
  for (const [i, id] of starts) {
    const def = data.provincesById[id];
    if (!def) { err(i, 'startProvince', 'UNKNOWN_PROVINCE', `Unknown province "${id}".`); continue; }
    if (!def.startingEligible) { err(i, 'startProvince', 'START_INELIGIBLE', `${def.name} can never be a start province (never Carthage or Roma, 4.b).`); continue; }
    if (two && !sideOf(data, id)) { err(i, 'startProvince', 'START_NOT_ON_SIDE', `${def.name} is not a start province in a 2-player game (4.g, 21.g).`); continue; }
    if (two && players[i].startSide && sideOf(data, id) !== players[i].startSide) { err(i, 'startProvince', 'START_WRONG_SIDE', `${def.name} is in the ${sideOf(data, id)}; this seat starts in the ${players[i].startSide} (4.g).`); continue; }
    if (placed.includes(id)) { err(i, 'startProvince', 'START_TAKEN', `${def.name} is already another seat's start.`); continue; }
    if (two && placed.some(o => sideOf(data, o) === sideOf(data, id))) { err(i, 'startProvince', 'START_SAME_SIDE', `${def.name} is in the ${sideOf(data, id)}, like ${data.provincesById[placed.find(o => sideOf(data, o) === sideOf(data, id))].name}: in a 2-player game one player starts in the west and the other in the east (4.g).`); continue; }
    const close = allowCloseStarts ? null : placed.find(o => dist(id)[o] < data.rules.startProvinceMinDistance && !isEx(id, o));
    if (close) { err(i, 'startProvince', 'START_TOO_CLOSE', `${def.name} is only ${dist(id)[close]} step(s) from ${data.provincesById[close].name}: starts need 2+ provinces between them (20.o, Q3).`); continue; }
    placed.push(id);
  }
  if (!errors.length && mode === 'pick' && !allowCloseStarts) {
    const NP = players.length;
    const far = (x, ys) => ys.every(y => dist(x)[y] >= data.rules.startProvinceMinDistance);
    const okSide = (c, chosen) => !two || (sideOf(data, c) && !chosen.some(y => sideOf(data, y) === sideOf(data, c)));
    const fits = (k, chosen) => k === 0 || data.provinceIds.some(c => startAllowed(data, NP, c) && okSide(c, chosen) && !chosen.includes(c) && far(c, chosen) && fits(k - 1, chosen.concat(c)));
    if (!fits(players.length - placed.length, placed)) err(null, 'startProvince', 'START_LEAVES_NO_ROOM', 'These starts leave no valid start province for the other seats.');
  }
  return { ok: !errors.length, errors };
}

// ------------------------------------------------------------------ createGame
/**
 * New game in the setup phase. players: [{id?, name, color?, general?: id|null}]; options: {startProvinceMode: 'random'|'pick',
 * rerandomRewards: bool, allowCloseStarts: bool, hideHand: bool}. Returns {state, events} after setup has pushed its first prompt.
 */
export function createGame(data, { seed, players, options = {} }) {
  check(Array.isArray(players) && players.length >= 2, 'BAD_PLAYERS', 'A game needs at least 2 players.');
  check(players.length <= Math.min(data.rules.maxPlayers, data.generals.length), 'TOO_MANY_PLAYERS', `At most ${Math.min(data.rules.maxPlayers, data.generals.length)} players (only ${data.generals.length} generals are defined, Q4).`, '15.e');
  const v = validateSetup(data, { players, startProvinceMode: options.startProvinceMode, allowCloseStarts: options.allowCloseStarts });
  if (!v.ok) fail(v.errors[0].code, v.errors[0].message);
  const ps = players.map((p, i) => ({ id: p.id ?? 'p' + (i + 1), name: p.name ?? 'Player ' + (i + 1), color: p.color ?? PALETTE[i], general: p.general === 'random' ? null : p.general ?? null, controller: p.controller ?? 'human', startProvince: p.startProvince && p.startProvince !== 'random' ? p.startProvince : null, startSide: p.startSide ?? null }));
  check(new Set(ps.map(p => p.id)).size === ps.length, 'BAD_PLAYERS', 'Player ids must be unique.');
  const preset = ps.filter(p => p.general).map(p => p.general);
  for (const g of preset) check(data.generalsById[g], 'UNKNOWN_GENERAL', `Unknown general "${g}".`);
  check(new Set(preset).size === preset.length, 'GENERAL_TAKEN', 'Two players cannot have the same general.', '15.e');
  const state = createBlankState(data, { seed, players: ps });
  const mode = options.startProvinceMode === 'selected' ? 'pick' : options.startProvinceMode ?? data.rules.startProvinceMode;   // 'selected' = picks (M4 setup screen)
  check(['random', 'pick'].includes(mode), 'BAD_OPTION', 'startProvinceMode must be "random" or "pick" (15.i, 21.h: no general-based starts).');
  if (options.map !== undefined) check(options.map === (data.mapId ?? 'small1'), 'BAD_OPTION', `options.map "${options.map}" does not match the rules data (map "${data.mapId ?? 'small1'}").`);
  state.config.startProvinceMode = mode; state.config.allowCloseStarts = !!options.allowCloseStarts; state.config.hideHandDefault = !!options.hideHand;
  state.config.rewardMode = options.rerandomRewards ? 'random' : data.rules.rewardMode;
  if (options.rerandomRewards) {   // Q5: keeps the 7 Troop / 5 Gold split, every province gets a random reward
    const ids = data.provinces.filter(p => p.kind !== 'roma').map(p => p.id);
    const rewards = shuffle(state.rng, ids.map(id => data.provincesById[id].defaultReward));
    ids.forEach((id, i) => { state.provinces[id].reward = rewards[i]; });
  }
  const presetSides = Object.fromEntries(ps.filter(p => p.startSide).map(p => [p.id, p.startSide]));
  // v29.1 (M17.1): "Random general" chosen on the setup screen is kept: the generals stage draws a free general for these seats on state.rng
  // (host-authoritative) and never asks them again; general null / left out still means "choose in the game" (console, tests)
  const randomGenerals = ps.filter((p, i) => players[i].general === 'random').map(p => p.id);
  // v29.1: likewise "Random for this seat" (Selected starts, startProvince 'random'): that seat's start is drawn on state.rng, never asked
  const randomStarts = ps.filter((p, i) => players[i].startProvince === 'random').map(p => p.id);
  const picks = mode === 'pick' || !!fixedStartsFor(data, ps.length);   // 21.f: fixed starts are always picked in roll-off order, whatever the start setting
  state.setup = { ...(randomGenerals.length ? { randomGenerals } : {}), ...(randomStarts.length && picks ? { randomStarts } : {}), presetStarts: Object.fromEntries(ps.filter(p => p.startProvince).map(p => [p.id, p.startProvince])), ...(Object.keys(presetSides).length ? { presetSides } : {}), stage: 'rollOff', rollOff: { round: 1, queue: ps.map(p => p.id), keys: Object.fromEntries(ps.map(p => [p.id, []])) } };
  const ctx = makeCtx(state, data, {});
  emit(ctx, 'gameCreated', { rule: '4.a', pub: { seed, players: ps.map(p => ({ id: p.id, name: p.name })), startProvinceMode: mode, ...(data.mapId && data.mapId !== 'small1' ? { map: data.mapId } : {}) } });
  settle(ctx);
  return { state, events: ctx.events };
}

// ------------------------------------------------------------------ helpers
// v29.1: the legal starts for a seat that chose "Random for this seat" (as CHOOSE_START_PROVINCE, without the listed close-start exceptions)
function randomStartOptions(state, data, pid) {
  const two = sidesApply(data, state.players.length); const side = state.setup?.sides?.[pid] ?? null;
  const taken = state.players.filter(p => p.startProvince).map(p => p.startProvince);
  const remaining = state.players.filter(p => !p.startProvince && p.id !== pid).length;
  const D = new Map(); const dist = x => D.get(x) ?? (D.set(x, distances(data, x)), D.get(x));
  const close = !!state.config.allowCloseStarts; const NP = state.players.length;
  const far = (x, ys) => close || ys.every(y => dist(x)[y] >= data.rules.startProvinceMinDistance);
  const okSide = (c, chosen) => !two || (sideOf(data, c) && !chosen.some(y => sideOf(data, y) === sideOf(data, c)));
  const fits = (k, chosen) => k === 0 || data.provinceIds.some(c => startAllowed(data, NP, c) && okSide(c, chosen) && !chosen.includes(c) && far(c, chosen) && fits(k - 1, chosen.concat(c)));
  return data.provinceIds.filter(id => startAllowed(data, NP, id) && state.provinces[id].owner === null
    && (!two || (sideOf(data, id) && (!side || sideOf(data, id) === side) && okSide(id, taken)))
    && far(id, taken) && (close || fits(remaining, taken.concat(id))));
}

function placeStart(ctx, pid, id) {
  const { state, data } = ctx;
  const p = state.provinces[id]; const pl = mustPlayer(state, pid);
  // v31.4: a start is 5 troops and no native roll (20.n). Other provinces still roll natives when first attacked (17.h).
  Object.assign(p, { owner: pid, status: 'starting', startingOf: pid, troops: data.rules.startingTroops, native: { rolled: 0, count: 0, present: 0 } });
  pl.startProvince = id;
  if (pl.general) pl.general.at = id;
  emit(ctx, 'startProvinceChosen', { actor: pid, rule: '4.b, 20.n', pub: { player: pid, province: id, troops: data.rules.startingTroops } });
}

const rollOffOrder = keys => Object.entries(keys).sort((a, b) => {
  for (let i = 0; i < Math.max(a[1].length, b[1].length); i++) { const x = a[1][i] ?? 0, y = b[1][i] ?? 0; if (x !== y) return y - x; }
  return 0;
}).map(e => e[0]);

// ------------------------------------------------------------------ roll purposes
defineRoll('rollOff', (ctx, f) => {
  const { state } = ctx; const ro = state.setup.rollOff;
  const v = roll(ctx, data10(ctx), 'rollOff', f.player);
  ro.keys[f.player].push(v); ro.queue.shift(); popFrame(ctx);
  emit(ctx, 'rollOffResult', { actor: f.player, rule: 'Q2', pub: { player: f.player, value: v, round: ro.round } });
});
const data10 = ctx => ctx.data.rules.dice.rollOff;

defineRoll('startProvinces', (ctx, f) => {
  const { state, data } = ctx;
  popFrame(ctx);
  const r = assignStartProvinces(state.rng, data, state.players.length);
  if (r.sides) state.setup.sides = Object.fromEntries(state.players.map((p, i) => [p.id, r.sides[i]]));
  emit(ctx, 'startProvincesDealt', { rule: r.sides ? '4.g, 20.o' : 'Q3, Q55', pub: { n: state.players.length, ...(r.sides ? { sides: state.players.map((p, i) => ({ player: p.id, side: r.sides[i] })) } : {}), requestedDistance: r.requestedDistance, usedDistance: r.usedDistance, fallbackUsed: r.fallbackUsed, exceptionsUsed: r.exceptionsUsed, assignments: state.players.map((p, i) => ({ player: p.id, province: r.assignments[i] })) } });
  state.players.forEach((p, i) => placeStart(ctx, p.id, r.assignments[i]));
});

defineRoll('startNative', (ctx, f) => {
  const { state, data } = ctx;
  const v = roll(ctx, data.rules.dice.native, 'startNative', f.player);
  const count = data.rules.nativeRollTable.find(r => r.d6.includes(v)).count;
  const p = state.provinces[f.province];
  p.native = { rolled: count, count, present: count };
  popFrame(ctx);
  emit(ctx, 'startNativesRolled', { actor: f.player, rule: '20.l', pub: { player: f.player, province: f.province, d6: v, count } });
});

// ------------------------------------------------------------------ actions
define('CHOOSE_GENERAL', {
  frame: ['setupGeneral'],
  run(ctx, a) {
    const { state, data } = ctx; const f = state.pending[state.pending.length - 1];
    let id = a.general;
    const taken = new Set(state.players.filter(p => p.general).map(p => p.general.id));
    const free = data.generals.map(g => g.id).filter(g => !taken.has(g));
    if (id === 'random') id = free[int(state.rng, free.length) - 1];
    check(data.generalsById[id], 'UNKNOWN_GENERAL', `Unknown general "${id}".`);
    check(!taken.has(id), 'GENERAL_TAKEN', `${data.generalsById[id].name} is already taken.`, '15.e');
    playerOf(state, f.player).general = { id, at: null };
    popFrame(ctx);
    emit(ctx, 'generalChosen', { actor: f.player, rule: 'Q4', pub: { player: f.player, general: id } });
  },
});

define('CHOOSE_SIDE', {
  frame: ['setupSide'],
  run(ctx, a) {
    const { state } = ctx; const f = state.pending[state.pending.length - 1];
    check(OTHER_SIDE[a.side], 'BAD_SIDE', `Choose "west" ${sideLabel(ctx.data, 'west').slice(5)} or "east" ${sideLabel(ctx.data, 'east').slice(5)} (4.g, 21.g).`, '4.g');
    const other = state.players.find(p => p.id !== f.player);
    state.setup.sides = { [f.player]: a.side, [other.id]: OTHER_SIDE[a.side] };
    popFrame(ctx);
    emit(ctx, 'startSideChosen', { actor: f.player, rule: '4.g', pub: { player: f.player, side: a.side, sides: state.players.map(p => ({ player: p.id, side: state.setup.sides[p.id] })) } });
  },
});

define('CHOOSE_START_PROVINCE', {
  frame: ['setupStartProvince'],
  run(ctx, a) {
    const { state, data } = ctx; const f = state.pending[state.pending.length - 1];
    const id = a.province; const def = data.provincesById[id];
    check(def, 'UNKNOWN_PROVINCE', `Unknown province "${id}".`);
    check(def.startingEligible, 'START_INELIGIBLE', `${def.name} can never be a starting province (${id === 'carthage' ? '4.b, 16.n, 20.l' : 'Roma is special, 12.g'}).`, id === 'carthage' ? '4.b' : '12.g');
    check(state.provinces[id].owner === null, 'START_TAKEN', `${def.name} is already someone's start province.`, '4.b');
    const fixed = fixedStartsFor(data, state.players.length);
    if (fixed) check(fixed.includes(id), 'START_NOT_FIXED', `On ${data.mapName ?? 'this map'} the starts are ${fixed.map(x => data.provincesById[x].name).join(', ')} (21.f).`, '21.f');
    const two = sidesApply(data, state.players.length); const sides = state.setup?.sides ?? null;
    if (two) {
      check(sideOf(data, id), 'START_NOT_ON_SIDE', `${def.name} is not a start province in a 2-player game (4.g, 21.g).`, '4.g');
      if (sides?.[f.player]) check(sideOf(data, id) === sides[f.player], 'START_WRONG_SIDE', `${def.name} is in the ${sideOf(data, id)}: you start in the ${sides[f.player]} (${sideProvinces(data, sides[f.player]).map(x => data.provincesById[x].name).join(', ')}) (4.g).`, '4.g');
    }
    if (!state.config.allowCloseStarts) {
      const D = distances(data, id);
      const isEx = (a, b) => data.rules.startDistanceExceptions.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));   // a listed pair is accepted when picking by hand (4.4)
      for (const p of state.players) if (p.startProvince && D[p.startProvince] < data.rules.startProvinceMinDistance && !isEx(id, p.startProvince))
        fail('START_TOO_CLOSE', `${def.name} is only ${D[p.startProvince]} step(s) from ${data.provincesById[p.startProvince].name}; start provinces need ${data.rules.startProvinceMinDistance} steps (Q3, Q55).`, 'Q3');
    }
    if (!state.config.allowCloseStarts) {   // never paint the table into a corner: the players still to pick need room (found by the M1.4 fuzz test)
      const remaining = state.players.filter(p => !p.startProvince && p.id !== f.player).length; const NP = state.players.length;
      const taken = state.players.filter(p => p.startProvince).map(p => p.startProvince).concat(id);
      const D = new Map(); const dist = x => D.get(x) ?? (D.set(x, distances(data, x)), D.get(x));
      const far = (x, ys) => ys.every(y => dist(x)[y] >= data.rules.startProvinceMinDistance);
      const okSide = (c, chosen) => !two || (sideOf(data, c) && !chosen.some(y => sideOf(data, y) === sideOf(data, c)));
      const fits = (k, chosen) => k === 0 || data.provinceIds.some(c => startAllowed(data, NP, c) && okSide(c, chosen) && !chosen.includes(c) && far(c, chosen) && fits(k - 1, chosen.concat(c)));
      check(fits(remaining, taken), 'START_LEAVES_NO_ROOM', `${def.name} would leave no valid start province (3 steps apart) for the players who still have to pick.`, 'Q3');
    }
    popFrame(ctx);
    placeStart(ctx, f.player, id);
  },
});

// ------------------------------------------------------------------ the setup state machine (settle hook)
function startFirstTurn(ctx) {
  const { state } = ctx;
  state.phase = 'turn'; state.setup = null;
  state.turn = { number: 1, round: 1, activePlayerId: state.turnOrder[0], step: 'resources', actionsUsed: 0, nonBattleCardPlayed: false, gameCardBought: false, bonusTroopsGained: [], revoltRollsExtra: 0, generalMoved: false, sub: {} };
  emit(ctx, 'turnStarted', { actor: state.turnOrder[0], rule: '17.a', pub: { number: 1, round: 1, player: state.turnOrder[0] } });
}

onSettle(ctx => {
  const { state, data } = ctx;
  if (state.phase !== 'setup' || state.pending.length || !state.setup) return false;
  const su = state.setup;
  if (su.stage === 'rollOff') {
    const ro = su.rollOff;
    if (ro.queue.length) { pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.rollOff, purpose: 'rollOff', player: ro.queue[0] }); return true; }
    const order = rollOffOrder(ro.keys);
    const keyOf = id => ro.keys[id].join(',');
    const tied = order.filter(id => order.some(o => o !== id && keyOf(o) === keyOf(id)));
    if (tied.length) {
      ro.round += 1; ro.queue = state.players.map(p => p.id).filter(id => tied.includes(id));
      emit(ctx, 'rollOffTie', { rule: 'Q2', pub: { players: ro.queue, round: ro.round } });
      return true;
    }
    state.turnOrder = order;
    emit(ctx, 'turnOrderSet', { rule: 'Q2', pub: { order, rolls: ro.keys } });
    su.stage = 'generals';
    return true;
  }
  if (su.stage === 'generals') {
    const next = [...state.turnOrder].reverse().find(id => !playerOf(state, id).general);   // reverse turn order (Q4)
    if (next && su.randomGenerals?.includes(next)) {   // v29.1: the setup screen's "Random general": drawn now, not asked
      const taken = new Set(state.players.filter(p => p.general).map(p => p.general.id));
      const free = data.generals.map(g => g.id).filter(g => !taken.has(g));
      const id = free[int(state.rng, free.length) - 1];
      playerOf(state, next).general = { id, at: null };
      emit(ctx, 'generalChosen', { actor: next, rule: 'Q4', pub: { player: next, general: id, random: true } });
      return true;
    }
    if (next) { pushFrame(ctx, { kind: 'setupGeneral', player: next }); return true; }
    state.players.forEach(p => { if (p.general && !data.generalsById[p.general.id]) fail('UNKNOWN_GENERAL', 'bad general'); });
    su.stage = 'provinces';
    return true;
  }
  if (su.stage === 'provinces') {
    // 15.i, 21.h (2026-11-01): no general-based ("classic") starts any more; an old save still in setup with that mode is dealt at random.
    // 21.f: fixed starts are always picked, in roll-off order (the highest roll first), whatever the start setting.
    const picks = state.config.startProvinceMode === 'pick' || !!fixedStartsFor(data, state.players.length);
    if (!picks) {
      if (state.players.some(p => !p.startProvince)) { pushFrame(ctx, { kind: 'roll', die: 'deal', purpose: 'startProvinces', player: null }); return true; }
    } else {
      if (su.presetStarts && Object.keys(su.presetStarts).length) {   // Selected starts from the setup screen (validated by validateSetup)
        for (const [pid, id] of Object.entries(su.presetStarts)) placeStart(ctx, pid, id);
        su.presetStarts = {};
        return true;
      }
      if (sidesApply(data, state.players.length) && !su.sides) {   // 4.g: the first picker chooses a side (or a pick / the setup screen already did)
        const known = state.players.find(p => p.startProvince && sideOf(data, p.startProvince)) ?? null;
        const preset = su.presetSides ? Object.entries(su.presetSides)[0] : null;
        if (known || preset) {
          const [pid, side] = known ? [known.id, sideOf(data, known.startProvince)] : preset;
          const other = state.players.find(p => p.id !== pid);
          su.sides = { [pid]: side, [other.id]: OTHER_SIDE[side] };
          emit(ctx, 'startSidesSet', { rule: '4.g', pub: { sides: state.players.map(p => ({ player: p.id, side: su.sides[p.id] })), by: pid } });
          return true;
        }
        const first = startPickOrder(state, data).find(id => !playerOf(state, id).startProvince);
        if (!su.randomStarts?.includes(first)) { pushFrame(ctx, { kind: 'setupSide', player: first }); return true; }
      }
      const next = startPickOrder(state, data).find(id => !playerOf(state, id).startProvince);
      if (next && su.randomStarts?.includes(next)) {   // v29.1: "Random for this seat": a random legal start (the same rules as a hand pick), on state.rng
        const opts = randomStartOptions(state, data, next);
        check(opts.length, 'START_LEAVES_NO_ROOM', 'No valid start province is left for a random start.', 'Q3');
        const id = opts[int(state.rng, opts.length) - 1];
        placeStart(ctx, next, id);
        emit(ctx, 'startProvinceRandom', { actor: next, rule: '4.b', pub: { player: next, province: id } });
        return true;
      }
      if (next) { pushFrame(ctx, { kind: 'setupStartProvince', player: next }); return true; }
    }
    su.stage = 'natives';
    return true;
  }
  if (su.stage === 'natives') {
    // v31.4: new games set native.rolled to 0 in placeStart, so this roll is skipped. An old save still on this step (rolled === null) still rolls.
    const next = state.turnOrder.find(id => state.provinces[playerOf(state, id).startProvince].native.rolled === null);
    if (next) { pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.native, purpose: 'startNative', player: next, province: playerOf(state, next).startProvince }); return true; }
    startFirstTurn(ctx);
    return true;
  }
  return false;
});

/** Convenience for tests and the console: a game with the setup dice rolled automatically (`autoSetup`) is built from plain actions. */
export function autoSetup(data, state, { dice } = {}) {
  let s = state, events = [];
  for (let guard = 0; guard < 200 && s.phase === 'setup'; guard++) {
    const f = s.pending[s.pending.length - 1];
    const who = f.player ?? s.players[0].id;
    let action;
    if (f.kind === 'roll') action = { type: 'ROLL', playerId: who };
    else if (f.kind === 'setupSide') action = { type: 'CHOOSE_SIDE', playerId: who, side: 'west' };
    else if (f.kind === 'setupGeneral') action = { type: 'CHOOSE_GENERAL', playerId: who, general: 'random' };
    else if (f.kind === 'setupStartProvince') {
      const D = (id) => distances(data, id);
      const side = s.setup?.sides?.[who] ?? null;
      const ok = data.provinceIds.find(id => startAllowed(data, s.players.length, id) && (!side || sideOf(data, id) === side) && s.provinces[id].owner === null && s.players.every(p => !p.startProvince || D(id)[p.startProvince] >= data.rules.startProvinceMinDistance));
      action = { type: 'CHOOSE_START_PROVINCE', playerId: who, province: ok };
    }
    const r = applyAction(s, action, { data, dice });
    if (r.error) throw new Error('autoSetup: ' + r.error.code + ' ' + r.error.message);
    s = r.state; events = events.concat(r.events);
  }
  return { state: s, events };
}
