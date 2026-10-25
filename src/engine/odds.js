// M8 (playtest batch 3, item 1): exact win odds of a battle for the AI, with everything the real battle code applies (battle.js):
// troops (and borrowed natives, 19.c), dice per side (land 3 / sea 2, 17.e, 17.n; defender 2, or 3 behind a Wall, 19.k, 12.i, 16.n),
// rolls with the Wall cancelled by Catapults and Germanicus (19.u, 15.h), Scipio (+1 on a tied pairing or an extra die, 15.c, 15.g),
// Pompey at sea (15.d), Germanicus' Fight to the Death (15.h, both sides), Caesar's fleeing troop (15.b, both sides), Roma's Ingrained
// Loyalty roll (12.j, cap 20, 12.k), Elephants (+1 every round, 18.b) and Moral Boost (+1 for one round each, 18.c, queued one per round),
// ties to the defender (Q16) and "both sides at 0: the defender keeps 1" (Q20).
// It is a dynamic program over (attackers, defenders, round) with exact per-round loss tables (sorted-dice multisets), so a call costs
// well under a millisecond once warm. It never peeks: a rival's hidden battle cards / Horn are not counted.
import { playerOf } from './core.js';
import * as S from './selectors.js';
import { attackPreview, battleCardsHeld, borrowLimit, attForce, defForce, wallsActive } from './battle.js';

// ---- sorted multisets of n six-sided dice, descending, with their probabilities
const msets = new Map();
function multisets(n) {
  if (msets.has(n)) return msets.get(n);
  const out = []; const fact = k => (k <= 1 ? 1 : k * fact(k - 1)); const total = 6 ** n;
  const rec = (start, left, acc) => {
    if (!left) { const c = {}; for (const v of acc) c[v] = (c[v] ?? 0) + 1; let ways = fact(n); for (const k of Object.values(c)) ways /= fact(k); out.push({ dice: [...acc], p: ways / total }); return; }
    for (let v = start; v >= 1; v--) { acc.push(v); rec(v, left - 1, acc); acc.pop(); }
  };
  rec(6, n, []); msets.set(n, out); return out;
}
// ---- one round: distribution of (attacker losses, defender losses)
const tables = new Map();
function roundTable(nA, nD, net) {
  const key = `${nA},${nD},${net}`;
  if (tables.has(key)) return tables.get(key);
  const acc = new Map();
  for (const A0 of multisets(nA)) for (const D of multisets(nD)) {
    const A = A0.dice.map(v => v + net);            // net = attacker bonus - defender bonus (both apply to every die of a side)
    let aL = 0, dL = 0; for (let k = 0; k < Math.min(nA, nD); k++) { if (A[k] > D.dice[k]) dL++; else aL++; }
    const kk = aL * 10 + dL; acc.set(kk, (acc.get(kk) ?? 0) + A0.p * D.p);
  }
  const t = [...acc].map(([kk, p]) => ({ aL: Math.floor(kk / 10), dL: kk % 10, p }));
  tables.set(key, t); return t;
}

/**
 * Exact odds of a battle fought to the end. p: {a, d, round (next round to roll, 1 = first), maxA (attacker dice before the force
 * limit), defDice, wall, ignore (rolls 1..ignore have the Wall cancelled), defWallDice, attBonus/defBonus (Elephants, all rounds),
 * attMoralUntil/defMoralUntil (+1 in rounds <= this), germAtt/germDef (+delta on a lone last die, only once that side has lost troops in the battle,
 * Q113: below its count at the start of these odds, or attLost/defLost already before them), delta}.
 * Returns {p: P(conquest), surv: E[attacker survivors on a conquest] (not conditional), lose: 1 - p}.
 */
export function fightOdds(q) {
  const P = { round: 1, maxA: 3, defDice: 2, wall: false, ignore: 0, defWallDice: 3, attBonus: 0, defBonus: 0, attMoralUntil: 0, defMoralUntil: 0, germAtt: false, germDef: false, attLost: false, defLost: false, delta: 2, ...q };
  const a0 = Math.max(0, Math.min(80, Math.round(P.a))), d0 = Math.max(0, Math.min(80, Math.round(P.d)));
  const rMax = Math.max(P.ignore, P.attMoralUntil, P.defMoralUntil, P.round) + 1;
  const memo = new Map();
  const f = (a, d, r) => {
    if (d <= 0) return a > 0 ? [1, a] : [0, 0];
    if (a <= 0) return [0, 0];
    const rc = Math.min(r, rMax); const key = (a * 128 + d) * 64 + rc;
    const m = memo.get(key); if (m) return m;
    const nA = Math.min(P.maxA, a);
    const nD = Math.min(P.wall && rc > P.ignore ? P.defWallDice : P.defDice, d);
    let net = P.attBonus - P.defBonus + (rc <= P.attMoralUntil ? 1 : 0) - (rc <= P.defMoralUntil ? 1 : 0);
    if (P.germAtt && a === 1 && nA === 1 && (P.attLost || a < a0)) net += P.delta;   // Q113: never for an army that started at 1
    if (P.germDef && d === 1 && nD === 1 && (P.defLost || d < d0)) net -= P.delta;
    net = Math.max(-7, Math.min(7, net));
    let pw = 0, sv = 0;
    for (const o of roundTable(nA, nD, net)) {
      const a2 = a - o.aL, d2 = d - o.dL;
      const [w, s] = a2 <= 0 ? [0, 0] : f(a2, d2, rc + 1);   // a2 = 0 and d2 = 0: the defender keeps 1 (Q20)
      pw += o.p * w; sv += o.p * s;
    }
    const res = [pw, sv]; memo.set(key, res); return res;
  };
  const [p, surv] = f(a0, d0, P.round);
  return { p, surv, lose: 1 - p };
}

const gen = (state, pid) => playerOf(state, pid)?.general ?? null;
const perksOn = (state, pid, id) => gen(state, pid)?.id === id && S.generalPerksActive(state, pid);

/** Mixes the Roma loyalty roll (12.j: d6 troops defect, at most romaLoyaltyMaxDefect, they join Roma up to 20) into fightOdds. */
function withLoyalty(data, q) {
  let p = 0, surv = 0; const max = data.rules.romaLoyaltyMaxDefect; const cap = data.rules.romaMaxTroops;
  for (let v = 1; v <= 6; v++) {
    const n = Math.min(v, max, q.a);
    if (n >= q.a) continue;                                  // the whole army defects: lost
    const o = fightOdds({ ...q, a: q.a - n, d: Math.min(cap, q.d + n) });
    p += o.p / 6; surv += o.surv / 6;
  }
  return { p, surv, lose: 1 - p };
}

/**
 * Win chance of an ATTACK the player is about to declare (action: {playerId, from, target, troops, withGeneral}), counting what it would
 * really use: opts.borrow (default: the full borrow limit, as the AI borrows when it helps), every battle card in its hand (opts.cards
 * false to leave them out), and for Scipio the better of his two perks. Returns {ok, p, surv, perk, params, reason}.
 */
export function attackOdds(state, data, action, opts = {}) {
  const pid = action.playerId ?? state.turn?.activePlayerId;
  const pv = attackPreview(state, data, { ...action, playerId: pid });
  if (!pv.ok) return { ok: false, p: 0, surv: 0, reason: pv.reason };
  const R = data.rules.battle; const t = state.provinces[action.target];
  const withGeneral = !!action.withGeneral && gen(state, pid)?.at === action.from;
  const on = id => withGeneral && perksOn(state, pid, id);
  const borrow = opts.borrow ?? borrowLimit(state, data, action.from, action.troops);
  let a = action.troops + borrow;
  let d = t.owner === null && action.target !== 'roma' ? (t.native.present ?? t.native.count ?? 0) : t.troops;
  if (opts.extraDefenders) d += opts.extraDefenders;
  const held = opts.cards === false ? {} : battleCardsHeld(state, data, pid);
  const minFlee = data.generalsById.caesar?.perks?.[0]?.params?.minEnemyTroops ?? data.rules.caesarFleeMinEnemy;
  const delta = data.generalsById.germanicus?.perks?.find(x => x.handler === 'fightToTheDeath')?.params?.delta ?? 2;
  const defPid = t.owner; const dg = defPid ? gen(state, defPid) : null;
  const defGen = id => !!(defPid && dg?.at === action.target && dg.id === id && S.generalPerksActive(state, defPid));
  if (on('caesar')) { if (d >= minFlee) d -= 1; }                          // 15.b: one enemy troop flees
  else if (defGen('caesar') && a >= minFlee) a -= 1;                         // 15.b defending: one of ours flees (it comes back if we lose)
  const base = {
    a, d, round: 1, maxA: pv.sea ? (on('pompey') ? Math.max(R.attackerDiceSea, R.pompeyDiceSea) : R.attackerDiceSea) : R.attackerDiceLand,
    defDice: R.defenderDice, defWallDice: R.defenderDiceWithWall, wall: pv.wall, ignore: pv.wallRollsIgnored,
    attBonus: held.elephants?.length ?? 0, attMoralUntil: held.moral_boost?.length ?? 0, germAtt: on('germanicus'), germDef: defGen('germanicus'), delta,
  };
  const run = q => (action.target === 'roma' ? withLoyalty(data, q) : fightOdds(q));
  let best = { ...run(base), perk: null, params: base };
  if (on('scipio')) {                                                       // 15.c (Vidi 2026-10-24): his only perk, the extra die, applies by itself
    const extra = { ...base, maxA: pv.sea ? R.scipioExtraDieSea : R.scipioExtraDieLand };
    best = { ...run(extra), perk: 'extraDie', params: extra };
  }
  return { ok: true, ...best };
}

/** Odds of the battle in progress (state.battle), from the next round on, as the AI would fight it to the end. */
export function liveOdds(state, data, b = state.battle, over = {}) {
  const R = data.rules.battle; const ap = b.att.player;
  const on = id => b.att.general && perksOn(state, ap, id);
  const nextRound = Math.max(1, b.round + (b.stage === 'continue' || b.round === 0 ? 1 : 0));
  let maxA;
  if (b.mode === 'decree') maxA = R.attackerDiceLand;
  else if (b.att.perk === 'extraDie') maxA = b.sea ? R.scipioExtraDieSea : R.scipioExtraDieLand;
  else maxA = b.sea ? (on('pompey') ? Math.max(R.attackerDiceSea, R.pompeyDiceSea) : R.attackerDiceSea) : R.attackerDiceLand;
  const moralLeft = side => b[side].queue.filter(u => state.cards[u].def === 'moral_boost').length;
  const dp = b.def.player; const delta = data.generalsById.germanicus?.perks?.find(x => x.handler === 'fightToTheDeath')?.params?.delta ?? 2;
  const q = {
    a: attForce(b), d: defForce(state, b), round: nextRound, maxA, defDice: R.defenderDice, defWallDice: R.defenderDiceWithWall,
    wall: wallsActive(state, data, b), ignore: b.wallRollsIgnored, attBonus: b.att.elephants, defBonus: b.def.elephants,
    attMoralUntil: nextRound - 1 + moralLeft('att'), defMoralUntil: nextRound - 1 + moralLeft('def'),
    germAtt: b.mode === 'attack' && on('germanicus'), germDef: b.mode === 'attack' && !!(dp && b.def.general && perksOn(state, dp, 'germanicus')), delta,
    attLost: b.rounds.some(r => r.attackerLoss > 0), defLost: b.rounds.some(r => r.defenderLoss > 0), ...over,
  };
  return fightOdds(q);
}
