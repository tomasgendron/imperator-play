// M4: the AI player (PLAN 12 M4). A deterministic, engine-level policy: chooseAction(state, data, {seed}) returns ONE legal action for
// whoever has to act now (whoActs), for every frame of the game: setup, the turn, battles, decrees, card plays and response windows.
//   * Candidates always come from legalActions, so the AI can never play an illegal action.
//   * Battles are judged with exact odds (odds.js, M8): a dynamic program over (attackers, defenders, round) with everything the battle
//     code applies (dice, Walls and the rolls Catapults / Germanicus cancel, generals' perks, battle cards in hand, Roma's loyalty roll).
//     M8 item 1: an attack is only started when that chance clears a bar (aiConfig.js: 60%+, higher for a rival, Carthage and Roma,
//     raised when the attack leaves the origin weak: under its minimum, no longer revolt-proof, or outnumbered next door).
//   * Everything else is a 1-ply look-ahead: apply the candidate to a copy and score the result with evaluate() (Prestige first, then
//     provinces that pay, garrisons at their minimum, troops, threats, Gold, cards; rivals' scores count against).
//   * It never peeks: buying a Game Card is valued by its average, and a Revolt! is judged as if it is not blocked (the rival's hand is hidden).
//   * Deterministic: no Math.random; ties break by a hash of (seed, state.eventSeq, candidate), so two seeds can play differently.
import { applyAction } from './apply.js';
import { topFrame, playerOf } from './core.js';
import { legalActions, whoActs } from './legal.js';
import { defForce, attackTargets } from './battle.js';
import * as S from './selectors.js';
import { attackOdds, liveOdds } from './odds.js';
import { aiConfig } from './aiConfig.js';

// ------------------------------------------------------------------ battle odds (exact)
const tables = new Map();
/** Loss distribution of one round: [{aL, dL, p}] for `a` attacker dice vs `d` defender dice, attacker dice + `bonus` (net). */
function roundTable(a, d, bonus) {
  const key = a + ',' + d + ',' + bonus;
  if (tables.has(key)) return tables.get(key);
  const n = a + d; const counts = new Map(); const total = 6 ** n; const dice = new Array(n).fill(1);
  for (let i = 0; i < total; i++) {
    let x = i; for (let k = 0; k < n; k++) { dice[k] = (x % 6) + 1; x = Math.floor(x / 6); }
    const A = dice.slice(0, a).map(v => v + bonus).sort((p, q) => q - p), D = dice.slice(a).sort((p, q) => q - p);
    let aL = 0, dL = 0; for (let k = 0; k < Math.min(a, d); k++) { if (A[k] > D[k]) dL++; else aL++; }
    const kk = aL * 10 + dL; counts.set(kk, (counts.get(kk) ?? 0) + 1);
  }
  const t = [...counts].map(([kk, c]) => ({ aL: Math.floor(kk / 10), dL: kk % 10, p: c / total }));
  tables.set(key, t); return t;
}
const odds = new Map();
/**
 * Probability that `a` attackers beat `d` defenders when fighting to the end, and the expected attacker survivors on a win.
 * maxA/maxD = dice per round before the force limit; bonus = attacker die bonus minus defender die bonus (all rounds).
 */
export function battleOdds(a, d, maxA = 3, maxD = 2, bonus = 0) {
  a = Math.max(0, Math.min(60, Math.round(a))); d = Math.max(0, Math.min(60, Math.round(d)));
  const key = `${a},${d},${maxA},${maxD},${bonus}`;
  if (odds.has(key)) return odds.get(key);
  let r;
  if (d <= 0) r = { p: a > 0 ? 1 : 0, surv: a };
  else if (a <= 0) r = { p: 0, surv: 0 };
  else {
    let p = 0, surv = 0;
    for (const o of roundTable(Math.min(maxA, a), Math.min(maxD, d), Math.max(-3, Math.min(3, bonus)))) {
      const s = battleOdds(a - o.aL, d - o.dL, maxA, maxD, bonus); p += o.p * s.p; surv += o.p * s.surv * (s.p > 0 ? 1 : 0);
    }
    r = { p, surv: p > 0 ? surv : 0 };   // surv = E[survivors AND win] (not conditional)
  }
  odds.set(key, r); return r;
}

// ------------------------------------------------------------------ evaluation
const W = { prestige: 60, province: 10, bonusTroop: 4, reward: 3, troop: 2.5, troopOver10: 0.8, gold: 1.2, card: 6, saved: 4, catapult: 4, road: 3, revolt: 6, threat: 0.35, under: 6 };
const CARD_VALUE = { revolt: 5, assassin: 4, bribe_the_ally: 4, kill_revolt_leader: 5, busy_little_bee: 5, battlefield_imperator: 4, elephants: 6, moral_boost: 5, horn_of_titus_pullus: 5 };
const handValue = (state, p) => p.hand.reduce((t, c) => t + (CARD_VALUE[state.cards[c.uid].def] ?? W.card), 0);

function playerScore(state, data, pid, cache) {
  const p = playerOf(state, pid);
  if (p.out) return -500;
  let s = p.prestige * W.prestige;
  const mine = S.provincesOf(state, pid);
  const conquered = mine.filter(id => state.provinces[id].status === 'conquered').length;
  for (const id of mine) {
    const pr = state.provinces[id]; const t = pr.troops;
    s += W.province;
    if (S.earnsBonusTroop(state, data, id)) s += W.bonusTroop;
    if (S.earnsReward(state, data, id)) s += W.reward;
    s += Math.min(t, 10) * W.troop + Math.max(0, t - 10) * W.troopOver10;
    if (S.isUnderGarrisoned(state, data, id)) s -= W.under;
    if (pr.status === 'conquered' && conquered >= 2 && t < data.rules.revoltImmuneAtTroops) s -= W.revolt;
    const nb = S.neighbours(data, id);
    if (pr.road) {   // a Road is what lets an army attack or ally from here (19.b): worth most next to targets, with troops to send
      const targets = nb.filter(n => state.provinces[n].owner !== pid && n !== 'roma' && !(n === 'carthage' && state.carthage.neutral)).length;
      s += targets ? W.road + Math.min(targets, 3) * Math.min(t - 1, 6) * 0.6 : 1;
    }
    s += (pr.walls?.length ?? 0) * 0.8;
    // threat: the strongest rival army next door that has a Road to attack from (19.b)
    let threat = 0;
    for (const n of nb) {
      const q = state.provinces[n];
      if (q.owner && q.owner !== pid && q.road) threat = Math.max(threat, q.troops - 1);
    }
    if (threat > t) s -= W.threat * (W.province + W.prestige * (pr.status === 'starting' ? 0.5 : 1)) * Math.min(1, (threat - t) / 4);
  }
  s += Math.min(p.gold, 12) * W.gold + Math.max(0, p.gold - 12) * 0.4;
  s += handValue(state, p) + p.savedResources.length * W.saved + p.inPlay.length * W.saved + (p.items?.catapult ?? 0) * W.catapult;
  if (p.general && p.general.at && S.generalPerksActive(state, pid)) s += 2;
  return s;
}
/** Score of the position for `pid` (higher is better): own score minus 0.7 x the average rival score; a win/loss is decisive. */
export function evaluate(state, data, pid) {
  if (state.winner) return state.winner === pid ? 1e6 : -1e6;
  const rivals = state.players.filter(p => p.id !== pid && !p.out);
  const own = playerScore(state, data, pid);
  const rv = rivals.length ? rivals.reduce((t, p) => t + playerScore(state, data, p.id), 0) / rivals.length : 0;
  const lead = rivals.length ? Math.max(...rivals.map(p => p.prestige)) : 0;
  return own - 0.7 * rv - (lead >= data.rules.winPrestige - 2 ? 15 * lead : 0);
}

// ------------------------------------------------------------------ helpers
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; }
const after = (state, data, action) => { const r = applyAction(state, action, { data }); return r.error ? null : r.state; };
const lite = state => ({ ...state, log: [] });   // the log does not matter for any decision

/**
 * M8 item 1: the bar an attack must clear (AI config): a base chance by target (natives, a rival, Carthage, Roma), raised when the
 * attackers leave the origin weak: under its minimum garrison (17.q), no longer revolt-proof (10+ troops, 17.c), or outnumbered by a
 * rival army next door that has a Road to attack from (19.b). Returns {bar, why[]}.
 */
export function attackBar(state, data, pid, action, cfg = aiConfig()) {
  const A = cfg.attack; const t = state.provinces[action.target]; const from = state.provinces[action.from];
  let bar = action.target === 'roma' ? A.minWinRoma : action.target === 'carthage' ? A.minWinCarthage : t.owner ? A.minWinRival : A.minWin;
  const why = [];
  const left = from.troops - action.troops;
  if (from.status !== 'allied' && left < S.minGarrison(state, data, action.from).min) { bar += A.exposedOrigin; why.push('origin under its minimum'); }
  const immune = data.rules.revoltImmuneAtTroops;
  if (from.status === 'conquered' && from.troops >= immune && left < immune) { bar += A.revoltRisk; why.push('origin no longer revolt-proof'); }
  const threat = Math.max(0, ...S.neighbours(data, action.from).map(n => state.provinces[n]).filter(q => q.owner && q.owner !== pid && q.road && q.status !== 'held').map(q => q.troops - 1));
  if (threat > left + 1) { bar += A.counterAttack; why.push('a rival army next door would outnumber the origin'); }
  return { bar: Math.min(A.maxBar, bar), why };
}
/** Value of attacking with `action` (troops chosen): the expected gain from the exact odds, minus what the attack costs now. */
function attackValue(state, data, pid, action, base, cfg) {
  const t = state.provinces[action.target];
  const o = attackOdds(state, data, { ...action, playerId: pid });
  if (!o.ok || o.p < attackBar(state, data, pid, action, cfg).bar) return -Infinity;   // only a battle with a good chance of winning
  const s1 = after(state, data, { ...action, borrow: 0, battleCards: {}, perk: undefined });
  const s2 = s1 ?? after(state, data, action);
  if (!s2 || !s2.battle) return -Infinity;
  const d = t.owner === null && action.target !== 'roma' ? (t.native.present ?? 0) : t.troops;
  const gainP = action.target === 'roma' ? data.rules.prestige.roma : action.target === 'carthage' ? data.rules.prestige.carthage : data.rules.prestige.conquest;
  let gain = gainP * W.prestige + W.province + W.bonusTroop;
  if (t.owner) gain += 0.7 * (W.prestige * data.rules.prestige.loss + W.province + d * W.troop) / Math.max(1, state.players.filter(p => !p.out && p.id !== pid).length);
  const v = evaluate(s2, data, pid) - base;   // the origin is emptied, the action is spent
  return v + o.p * gain + o.surv * W.troop - (1 - o.p) * 4 + (o.p < 0.45 ? -40 : 0);
}

// ------------------------------------------------------------------ the policy
/** AI strength levels (Q94, Vidi 2026-10-21: one normal level now; easy/hard can plug in here later as weight sets / search depth). */
export const AI_LEVELS = Object.freeze({ normal: { id: 'normal', name: 'Normal' } });

/**
 * The AI's move for the player who must act now. Returns a legal action ({type, playerId, ...}) or null when nobody can act.
 * opts.seed varies tie-breaks; opts.legal may pass a precomputed legalActions list; opts.level is a key of AI_LEVELS (only 'normal' now).
 */
export function chooseAction(state, data, opts = {}) {
  const seed = opts.seed ?? 'ai'; const cfg = aiConfig(opts);
  const legal = opts.legal ?? legalActions(state, data);
  if (!legal.length) return null;
  if (legal.length === 1) return legal[0].action;
  const me = whoActs(state); const f = topFrame(state);
  const st = lite(state);
  const jitter = (i, x) => hash(`${seed}|${state.eventSeq}|${i}|${x.type}`) * 0.05;
  const pickBest = scored => { let best = null; scored.forEach((x, i) => { const v = x.v + jitter(i, x.a); if (!best || v > best.v) best = { v, a: x.a }; }); return best.a; };
  const byType = t => legal.filter(d => d.type === t);
  const base = evaluate(st, data, me);
  const oneply = (action, adjust = 0) => { const s = after(st, data, action); return s ? evaluate(s, data, me) - base + adjust : -Infinity; };

  if (f) switch (f.kind) {
    case 'roll': return byType('ROLL')[0]?.action ?? legal[0].action;
    case 'draw': return legal[0].action;
    case 'setupGeneral': {   // Q96 (Vidi 2026-10-21): an AI seat with no general named takes a RANDOM free general, drawn from the seeded game RNG
      const d = legal.find(x => x.action.general === 'random');
      return (d ?? legal[0]).action;
    }
    case 'setupStartProvince': {
      const score = id => S.neighbours(data, id).reduce((t, n) => t + (data.provincesById[n].startingEligible ? 1.2 : 0.5) + (data.provincesById[n].land.includes(id) ? 0.3 : 0), 0);
      return pickBest(legal.map(d => ({ a: d.action, v: score(d.action.province) })));
    }
    case 'chooseBorrow': {
      const b = state.battle;
      const p0 = liveOdds(state, data, b, { a: b.att.own }).p, p1 = liveOdds(state, data, b, { a: b.att.own + f.max }).p;
      return { ...legal[0].action, count: p0 >= 0.9 || p1 - p0 < 0.04 ? 0 : f.max };
    }
    case 'chooseBattleCards': {   // commit every battle card when the exact odds move enough (18.b, 18.c, 18.i)
      const b = state.battle;
      const n = x => Object.values(x.action.cards).reduce((t, k) => t + k, 0);
      const all = legal.reduce((m, x) => (n(x) > n(m) ? x : m), legal[0]);
      const none = legal.find(x => !n(x)) ?? legal[0];
      const el = all.action.cards.elephants ?? 0, mo = all.action.cards.moral_boost ?? 0;
      const p0 = liveOdds(state, data, b).p;
      const p1 = liveOdds(state, data, b, f.role === 'attacker' ? { attBonus: b.att.elephants + el, attMoralUntil: mo } : { defBonus: b.def.elephants + el, defMoralUntil: mo }).p;
      const swing = f.role === 'attacker' ? p1 - p0 : p0 - p1;
      const stakes = f.role === 'defender' ? (state.provinces[b.target].status === 'starting' || b.target === 'roma' ? 1.5 : 1) : 1;
      return swing * stakes > 0.1 ? all.action : none.action;
    }
    case 'choosePerk': return legal[0].action;   // Scipio (15.c): only the extra die is left (an old save)
    case 'battleContinue': {
      const b = state.battle;
      const o = liveOdds(state, data, b);
      const t = b.target; const big = t === 'roma' || t === 'carthage' || state.provinces[t].owner;
      return byType(o.p >= (big ? 0.3 : 0.38) ? 'BATTLE_CONTINUE' : 'BATTLE_RETREAT')[0]?.action ?? legal[0].action;
    }
    case 'responseWindow':
      if (f.window === 'defenceAnnounced') {
        const b = state.battle;
        const horn = byType('CALL_REINFORCEMENTS');
        if (!horn.length) return legal[0].action;
        const p0 = liveOdds(state, data, b).p;
        const best = horn.reduce((m, x) => (x.action.troops > m.action.troops ? x : m), horn[0]);
        const p1 = liveOdds(state, data, b, { d: defForce(state, b) + best.action.troops }).p;
        return p0 - p1 > 0.15 ? best.action : byType('PASS')[0].action;
      }
      break;   // Kill Revolt leader! and Busy Little Bee!: the 1-ply look-ahead below compares playing with passing
    default: break;
  }

  // ---- generic: 1-ply look-ahead over the legal list (frames and the Actions step)
  const inActions = !f && state.phase === 'turn' && state.turn.step === 'actions';
  const unused = inActions ? data.rules.actionsPerTurn - state.turn.actionsUsed : 0;
  const ACTION_COST = new Set(['MOVE', 'ATTACK', 'ALLY', 'BUY_TROOP', 'BUY_GAME_CARD', 'BUILD_ROAD', 'BUILD_WALL', 'BUY_CATAPULT']);
  const scored = [];
  for (const d of legal) {
    let a = d.action; let v;
    const cost = ACTION_COST.has(d.type) ? -data.rules.unusedActionGold * W.gold : 0;
    switch (d.type) {
      case 'END_TURN': v = 0.5; break;
      case 'PREVIEW_TARGET': v = 3; break;
      case 'MOVE_GENERAL': {   // free (15.j): walk him to the strongest front (most troops able to attack); stay if he is already near it
        const front = id => (attackTargets(state, data, me, id).length ? S.maxLeaving(state, data, id) : -1);
        const at = playerOf(state, me).general.at;
        v = front(a.to) >= Math.max(1, front(at) + 2) ? 1 + front(a.to) * 0.01 : -Infinity;
        break;
      }
      case 'SELL_CARD': {      // conservative (20.p): only trims a big hand (the Emperor's tax, 18.u) by its least useful card
        const pl = playerOf(state, me); const all = [...pl.hand, ...pl.savedResources];
        const val = uid => (pl.savedResources.some(c => c.uid === uid) ? W.saved : CARD_VALUE[state.cards[uid].def] ?? W.card);
        const worst = all.reduce((m, c) => (val(c.uid) < val(m.uid) ? c : m), all[0]);
        v = all.length >= 5 && a.cardUid === worst.uid ? 0.6 : -Infinity;
        break;
      }
      case 'BUY_GAME_CARD': {    // never peek at the card it draws: pay the price, gain an average card
        v = -data.rules.costs.gameCardGold * W.gold - data.rules.costs.gameCardTroops * W.troop + W.card * 0.75 + (2 / 31) * W.prestige + cost;   // 2 of 31 are Prestige! (18.a)
        break;
      }
      case 'ATTACK': {
        const max = d.range?.max ?? a.troops;
        const keep = Math.max(0, S.minGarrison(state, data, a.from).min - 1);
        const tries = [...new Set([max, Math.max(1, max - keep), Math.max(1, Math.ceil(max * 0.75))])];
        let best = -Infinity, bestN = max;
        for (const n of tries) { const val = attackValue(st, data, me, { ...a, troops: n }, base, cfg); if (val > best) { best = val; bestN = n; } }
        a = { ...a, troops: bestN }; v = best;
        break;
      }
      case 'MOVE': {
        if (d.range) {
          const dest = state.provinces[a.to]; const need = Math.max(1, S.minGarrison(state, data, a.to).min - dest.troops);
          const tries = [...new Set([d.range.max, Math.max(1, Math.ceil(d.range.max / 2)), Math.min(d.range.max, need), Math.min(d.range.max, Math.max(1, 10 - dest.troops))])];
          let best = -Infinity, bestN = d.range.max;
          for (const n of tries) { const val = oneply({ ...a, troops: n }, cost); if (val > best) { best = val; bestN = n; } }
          a = { ...a, troops: bestN }; v = best;
        } else v = oneply(a, cost);
        break;
      }
      case 'ALLY': {
        const need = d.range?.min ?? a.troops;
        a = { ...a, troops: need }; v = oneply(a, cost);
        break;
      }
      case 'PLAY_CARD': {
        const s = after(st, data, a);
        if (!s) { v = -Infinity; break; }
        let s2 = s; const tf = topFrame(s);
        if (tf?.kind === 'responseWindow' && tf.window === 'revoltResponse' && tf.player !== me) s2 = after(s, data, { type: 'PASS', playerId: tf.player }) ?? s;   // judged as unblocked
        v = (evaluate(s2, data, me) - base) * (s2 !== s ? 0.85 : 1);
        break;
      }
      case 'PLACE_SURVIVORS': {
        const mx = d.range?.max ?? 0;
        const tries = [...new Set([0, mx, Math.max(0, Math.min(mx, f.own - S.minGarrison(state, data, f.target).min))])];
        let best = -Infinity, bestN = 0;
        for (const n of tries) { const val = oneply({ ...a, back: n }); if (val > best) { best = val; bestN = n; } }
        a = { ...a, back: bestN }; v = best;
        if (f.general) {   // 17.y: the general stays on the new front unless the origin is the better place to attack from next
          const front = id => (attackTargets(state, data, me, id).length ? 1 : 0);
          const want = front(f.target) < front(f.origin);
          v += a.generalBack === want ? 0.5 : 0;
        }
        break;
      }
      case 'CHOOSE_BORROW': a = { ...a, count: d.range.max }; v = 0; break;
      case 'CALL_REINFORCEMENTS': v = -1; break;
      default: v = oneply(a, cost);
    }
    if (inActions && d.type !== 'END_TURN' && d.type !== 'PREVIEW_TARGET' && ACTION_COST.has(d.type) && unused <= 0) v = -Infinity;
    scored.push({ a, v });
  }
  return pickBest(scored);
}

/** Plays the AI for `pid` until someone else must act (or the game ends). Returns {state, events, actions}. Handy for tests and bots. */
export function playAiUntilOther(state, data, pid, opts = {}) {
  let s = state; const events = []; const actions = [];
  for (let guard = 0; guard < (opts.maxSteps ?? 500) && s.phase !== 'finished' && whoActs(s) === pid; guard++) {
    const a = chooseAction(s, data, opts);
    if (!a) break;
    const r = applyAction(s, a, { data, dice: opts.dice });
    if (r.error) throw new Error(`AI chose an illegal action ${JSON.stringify(a)}: ${r.error.code} ${r.error.message}`);
    s = r.state; events.push(...r.events); actions.push(a);
  }
  return { state: s, events, actions };
}
