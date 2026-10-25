// Pure derived facts about a state (PLAN 3.2 "derived, never stored", 3.6). No mutation, no randomness. Provinces iterate by sorted id.
import { OWNED_STATUSES } from './state.js';

export const neighbours = (data, id) => [...data.provincesById[id].land, ...data.provincesById[id].sea];
export const isNeighbour = (data, a, b) => neighbours(data, a).includes(b);
export const linkType = (data, a, b) => (data.provincesById[a].land.includes(b) ? 'land' : data.provincesById[a].sea.includes(b) ? 'sea' : null);

export const provincesOf = (state, pid) => Object.keys(state.provinces).sort().filter(id => state.provinces[id].owner === pid);
export const conqueredOf = (state, pid) => provincesOf(state, pid).filter(id => state.provinces[id].status === 'conquered');
export const controls = (state, pid, id) => state.provinces[id]?.owner === pid && OWNED_STATUSES.includes(state.provinces[id].status);
export const totalTroops = (state, pid) => provincesOf(state, pid).reduce((t, id) => t + state.provinces[id].troops, 0);
export const romaHolder = state => state.provinces.roma.owner;
export const hasStartingProvince = (state, pid) => provincesOf(state, pid).some(id => state.provinces[id].status === 'starting');

/** Shortest path length over ALL land and sea links of the 13-province graph (Q55). */
export function distances(data, from) {
  const dist = { [from]: 0 }; const q = [from];
  while (q.length) { const c = q.shift(); for (const n of neighbours(data, c)) if (dist[n] === undefined) { dist[n] = dist[c] + 1; q.push(n); } }
  return dist;
}

export const generalPerksActive = (state, pid) => {
  const p = state.players.find(x => x.id === pid);
  return !!p?.general && !(p.generalRecalledThroughTurn !== null && state.turn.number <= p.generalRecalledThroughTurn);   // 18.o
};
export const hasGarrisonCard = (state, pid) => state.players.find(x => x.id === pid)?.inPlay.some(c => state.cards[c.uid].def === 'garrison_requirement') ?? false;
export const pompeyLowers = (state, pid) => state.players.find(x => x.id === pid)?.general?.id === 'pompey' && generalPerksActive(state, pid);

/**
 * Minimum garrison of an owned province for perks (17.f, 17.t, 15.d, 18.t, 16.n, 12.l) with the lines that explain it (PLAN 10.3).
 * Returns {min, lines[]}. `min` is never below the global floor (Vidi, Q57/Q64). Unowned provinces have no minimum (min 0).
 */
export function minGarrison(state, data, id) {
  const p = state.provinces[id]; const floor = data.rules.provinceFloor; const lines = [];
  if (!p || p.owner === null) return { min: 0, lines: ['unowned: no garrison minimum'] };
  if (p.status === 'starting') return { min: data.rules.startingProvinceMinGarrison, lines: ['starting province: flat minimum 1 (17.t); Pompey and the Garrison card never lower it'] };
  if (p.status === 'held') return { min: floor, lines: ['held Roma: no revolt-based minimum (12.l); its holder can never move troops out below 10 (12.l)'] };
  if (p.status === 'allied') return { min: floor, lines: ['allied: no minimum of its own (19.r), but the global floor of 1 applies (17.f)'] };
  const nat = p.native.count ?? 0; const card = hasGarrisonCard(state, p.owner), pomp = pompeyLowers(state, p.owner);
  let min;
  if (id === 'carthage') {
    min = data.rules.carthageFlatMin; lines.push(`Carthage: flat minimum ${min} (16.n)`);
    if (card) { min -= 1; lines.push('Garrison Requirement -1! (18.t): -1'); }
    if (pomp) { min -= 1; lines.push('Pompey: all minimums -1 (15.d)'); }
  } else {
    min = nat + data.rules.minGarrisonBonus; lines.push(`native count ${nat} + 1 = ${min} (17.f)`);
    if (card) { min = Math.max(nat, min - 1); lines.push('Garrison Requirement -1! (18.t): -1, never below the native count'); }
    if (pomp) { min -= 1; lines.push('Pompey: all minimums -1, may go below the native count (15.d)'); }
  }
  if (min < floor) { min = floor; lines.push(`never below the global floor of ${floor} (17.f)`); }
  return { min, lines };
}
export const isUnderGarrisoned = (state, data, id) => {
  const p = state.provinces[id];
  return p.owner !== null && (p.status === 'conquered') && p.troops < minGarrison(state, data, id).min;
};

/** Move route over provinces `pid` controls, land or sea (17.z). Fewest ally crossings wins; each ally crossed on the way (not the destination) costs 1 Gold (19.t). */
export function moveRoute(state, data, pid, from, to) {
  if (!controls(state, pid, from) || !controls(state, pid, to) || from === to) return null;
  const best = { [from]: { cost: 0, path: [from] } };
  const open = [from];
  while (open.length) {
    open.sort((a, b) => best[a].cost - best[b].cost || (a < b ? -1 : 1));
    const c = open.shift();
    for (const n of neighbours(data, c).slice().sort()) {
      const passNeutral = n === 'carthage' && state.carthage?.neutral && n !== to;   // neutral Carthage: move through, never stop (16.i, 16.n, 17.z)
      if (!controls(state, pid, n) && !passNeutral) continue;
      const step = (state.provinces[n].status === 'allied' && n !== to) ? 1 : 0;
      const cost = best[c].cost + step;
      if (!best[n] || cost < best[n].cost) { best[n] = { cost, path: [...best[c].path, n] }; if (!open.includes(n)) open.push(n); }
    }
  }
  const r = best[to];
  if (!r) return null;
  return { cost: r.cost, path: r.path, crossed: r.path.slice(1, -1).filter(id => state.provinces[id].status === 'allied') };
}

/** Troops that may LEAVE a province by choice (global floor of 1, Q60/Q64; a held Roma keeps 10, 12.l). */
export const maxMove = (state, data, id) => {
  const p = state.provinces[id];
  if (!p || p.owner === null) return 0;
  const keep = p.status === 'held' ? data.rules.romaFloorOnHold : data.rules.provinceFloor;
  return Math.max(0, p.troops - keep);
};
export const keepsFloor = (state, data, id, n) => { const p = state.provinces[id]; return p.troops - n >= (p.status === 'held' ? data.rules.romaFloorOnHold : data.rules.provinceFloor); };
/** Provinces that can spare a tax troop or a decree legion: troops >= 2 (Q64). */
export const sparingProvinces = (state, data, pid) => provincesOf(state, pid).filter(id => keepsFloor(state, data, id, 1));

export const displeasedQualifies = (state, data, pid) => {
  const p = state.players.find(x => x.id === pid);
  return p.prestige >= data.rules.displeasedThreshold.prestige || totalTroops(state, pid) >= data.rules.displeasedThreshold.troops;   // 16.m
};

/** Conquered provinces that count toward the 2-province threshold and can revolt: status "conquered" only (not starting, allied or held Roma; a captured start province IS conquered, Q62). */
export const revoltCandidates = (state, pid) => conqueredOf(state, pid);
export const revoltEligible = (state, data, pid) => revoltCandidates(state, pid).length >= data.rules.extraRevoltMinConqueredProvinces;

/**
 * Troops an allied province needs for its Game Roll reward (19.g, 19.r, 15.d, 18.t; Vidi 2026-10-22): native troops + 1; the Garrison
 * Requirement -1! card makes it 1 less but never below the native count on its own; Pompey's perk makes it 1 less and may go below
 * the native count (so both together: native - 1); never below 1 troop.
 */
export function alliedRewardNeed(state, data, id) {
  const p = state.provinces[id]; const nat = p.native.rolled ?? p.native.count ?? 0;
  let need = nat + data.rules.minGarrisonBonus;
  if (p.owner && hasGarrisonCard(state, p.owner)) need = Math.max(nat, need - 1);
  if (p.owner && pompeyLowers(state, p.owner)) need -= 1;
  return Math.max(data.rules.provinceFloor, need);
}
/** Does a province pay its Game Roll reward right now? (16.k, 17.t, 19.e, 19.g, 19.r, Q26) */
export function earnsReward(state, data, id) {
  const p = state.provinces[id];
  if (!p || p.owner === null || p.number === null) return false;
  if (p.status === 'starting') return true;
  if (p.status === 'allied') return p.troops >= alliedRewardNeed(state, data, id);
  return p.status === 'conquered' && p.troops >= minGarrison(state, data, id).min;
}
/** Does the province give its Resources-step bonus troop? (20.b, 20.k, 17.q) Allied provinces never do (19.r). */
export function earnsBonusTroop(state, data, id) {
  const p = state.provinces[id];
  if (!p || p.owner === null) return false;
  if (p.status === 'starting' || p.status === 'held') return true;
  return p.status === 'conquered' && p.troops >= minGarrison(state, data, id).min;
}

/** Owned provinces of `pid` nearest to `from` (graph distance over ALL links), excluding `from`. */
export function nearestOwned(state, data, pid, from) {
  const d = distances(data, from);
  const owned = provincesOf(state, pid).filter(id => id !== from && OWNED_STATUSES.includes(state.provinces[id].status));
  if (!owned.length) return [];
  const m = Math.min(...owned.map(id => d[id] ?? 99));
  return owned.filter(id => (d[id] ?? 99) === m);
}

/** Room left under Roma's cap of 20 (12.k). */
export const romaRoom = (state, data) => Math.max(0, data.rules.romaMaxTroops - state.provinces.roma.troops);
/** Can this conquered province revolt right now? 10+ troops never revolts (17.c, 18.m, 19.d); it still counts toward the threshold. */
export const canRevolt = (state, data, id) => state.provinces[id].troops < data.rules.revoltImmuneAtTroops;
/** Max-1-held cards: Garrison Requirement (in play) and Battlefield Imperator (in hand) (18.t, 18.w). */
export const holdsUnique = (state, pid, defId) => { const p = state.players.find(x => x.id === pid); return [...p.hand, ...p.inPlay].some(c => state.cards[c.uid].def === defId); };
/**
 * Own troops that may leave an attack origin (17.g, Vidi 2026-10-21): everything above the floor of 1 (a held Roma keeps 10, 12.l).
 * Replaces "troops above the origin's minimum garrison". Borrowed natives are extra (19.c). Used by ATTACK in M2.
 */
export const maxLeaving = (state, data, id) => maxMove(state, data, id);
/**
 * Borrowing limit at declaration (19.c, 17.q, Q73 default): floor(native.count / 2) from a conquered or starting origin that is NOT
 * under-garrisoned BEFORE the attackers leave; never from an allied province or Roma. Leaving the origin below its minimum afterwards
 * does not cancel the borrow (Q73).
 */
export function maxBorrow(state, data, id) {
  const p = state.provinces[id];
  if (!p || p.owner === null || !['conquered', 'starting'].includes(p.status) || id === 'roma') return 0;
  if (isUnderGarrisoned(state, data, id)) return 0;
  return Math.floor((p.native.count ?? 0) / 2);
}

export const holdsCard = (state, pid, defId) => state.players.find(p => p.id === pid).hand.some(c => state.cards[c.uid].def === defId);
export const handCounts = (state, pid) => {
  const o = {}; for (const c of state.players.find(p => p.id === pid).hand) { const d = state.cards[c.uid].def; o[d] = (o[d] || 0) + 1; } return o;
};
