// M3: card play (PLAN 4.2 row 11 PLAY_CARD, 5.5 handlers; rules 18.d-18.y, 16.m). One action, PLAY_CARD, does two jobs:
//   * in your own Actions step (no frame waiting): Revolt!, Assassin!, Bribe the Ally! (hold-a-turn, one non-battle card per turn, 18.h);
//   * as the answer to a response window: Kill Revolt leader! (window revoltResponse) and Busy Little Bee! (window displeasedResponse).
// Battle cards, the Horn and the Battlefield Imperator are played through the battle (battle.js); Prestige! and Garrison Requirement -1!
// act on draw (turn.js). Every target check lives in a pure selector below, so legalActions and the M4 AI use the same rules.
import { fail, check, emit, pushFrame, popFrame, topFrame, mustPlayer, playerOf, toDiscard, onSettle, awardPrestige } from './core.js';
import { define } from './actions.js';
import { registerEffect } from './registry.js';
import { changeTroops, processRevolts, resolveRevolt, moveSurvivors, provinceChoiceHandlers, responseWindows } from './turn.js';
import { OWNED_STATUSES } from './state.js';
import * as S from './selectors.js';

const isInt = n => Number.isInteger(n);
const nm = (data, id) => data.provincesById[id]?.name ?? id;
const rivals = (state, pid) => state.players.filter(p => p.id !== pid && !p.out).map(p => p.id);
const defOf = (state, uid) => state.cards[uid].def;

// ------------------------------------------------------------------ pure target selectors (shared with legalActions / AI)
/** Revolt! targets (18.m, Q38): a rival's CONQUERED province (not a start province, not allied, never Roma), fewer than 10 troops. */
export const revoltTargets = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'conquered' && id !== 'roma' && S.canRevolt(state, data, id);
});
/**
 * Assassin! targets (18.e, 18.i, 12.g, 12.l, 16.n; Vidi 2026-10-22): any province you do not control (a rival's, allied ones included,
 * or a neutral one held by natives) with 2+ troops, not struck during this occupation. Never Roma, whoever holds it; never a neutral
 * Carthage after a Senate Decree (Roma controls it). Natives whose count is not known yet are not a target (Q102 default, flag).
 */
export const strikeTroops = (state, id) => { const p = state.provinces[id]; return p.owner ? p.troops : (p.native.present ?? 0); };
const struckMark = p => p.owner ?? 'natives';
export const assassinTargets = (state, pid, data = null) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id]; const o = data?.rules.assassinTargets ?? { neutral: true, neutralNeedsKnownNatives: true };
  if (id === 'roma' || (p.struck ?? null) === struckMark(p)) return false;
  if (p.owner) return p.owner !== pid && !playerOf(state, p.owner).out && OWNED_STATUSES.includes(p.status) && p.troops >= 2;
  if (!o.neutral || (id === 'carthage' && state.carthage?.neutral)) return false;
  if (o.neutralNeedsKnownNatives && (p.native.count ?? null) === null) return false;
  return (p.native.present ?? 0) >= 2;
});
/** How many troops the Assassin must kill: as many as legally possible, up to 2 (18.e). */
export const assassinKills = (state, data, pid) => Math.min(data.rules.assassin?.kills ?? 2, assassinTargets(state, pid, data).reduce((t, id) => t + strikeTroops(state, id) - 1, 0));
/** Bribe the Ally! targets (18.v, Q32): a province allied to a rival (never Carthage), with the Gold cost = its native count. */
export const bribeTargets = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'allied' && id !== 'carthage';
}).map(id => ({ province: id, cost: bribeCost(state, id) }));
export const bribeCost = (state, id) => state.provinces[id].native.count ?? 0;

/** Is the card in hand playable in this turn by the hold-a-turn rule (18.h, Q9)? */
export const heldLongEnough = (state, data, entry) => entry.drawnOnTurn + (data.cardDefsById[defOf(state, entry.uid)].play?.delayTurns ?? 0) <= state.turn.number;

// ------------------------------------------------------------------ why a card cannot be played (M8 item 3, Vidi 2026-10-22)
/**
 * cardBlock(state, data, pid, uid) -> null when the card in pid's hand can be played by hand right now (in the Actions step, or as the
 * answer to the response window waiting for it), else {code, reason, message, rule}: `reason` is the short text the UI shows on the card,
 * `message` the full error. PLAY_CARD fails with exactly this, so the reason on screen and the legality check cannot drift apart.
 */
export function cardBlock(state, data, pid, uid) {
  const pl = state.players.find(p => p.id === pid); const entry = pl?.hand.find(c => c.uid === uid);
  const B = (code, reason, rule, message) => ({ code, reason, rule: rule ?? null, message: message ?? `${reason[0].toUpperCase()}${reason.slice(1)}${rule ? ` (${rule})` : ''}.` });
  if (!entry) return B('NOT_IN_HAND', 'not in your hand', '18.h');
  const def = defOf(state, uid); const d = data.cardDefsById[def]; const name = d?.name ?? def;
  const f = topFrame(state);
  if (f?.kind === 'responseWindow' && f.card && f.resolvableBy?.includes(pid) && responseWindows[f.window]?.play && (f.card === uid || defOf(state, f.card) === def)) {
    if (def === 'busy_little_bee' && !heldLongEnough(state, data, entry)) return B('HOLD_A_TURN', `drawn on turn ${entry.drawnOnTurn}: you must hold it a turn`, '18.h');
    return null;   // the window waiting for this card (any copy of it answers, 18.f / 18.x)
  }
  if (d.type === 'battle') return B('USE_IN_BATTLE', 'a battle card: commit it when you attack or are attacked', '18.i', `${name} is a battle card: commit it when you attack or are attacked (18.i).`);
  if (def === 'battlefield_imperator') return B('USE_WITH_ATTACK', 'used by attacking Roma: choose Roma as your target', '18.w', 'Battlefield Imperator is used by attacking Roma (ATTACK on Roma, 18.w).');
  if (def === 'kill_revolt_leader') return B('ONLY_AGAINST_REVOLT', 'played only when a revolt is aimed at you', '18.f', 'Kill Revolt leader! is played when a revolt is aimed at you (18.f).');
  if (def === 'horn_of_titus_pullus') return B('ONLY_WHEN_ATTACKED', 'played only when one of your provinces is attacked', '18.y', 'Horn of Titus Pullus! is played when one of your provinces is attacked (18.y).');
  if (def === 'busy_little_bee') return B('ONLY_AGAINST_DISPLEASED', 'played only when you draw a Rome Is Displeased card', '18.x', 'Busy Little Bee! is played when you draw a Rome Is Displeased card (18.x).');
  const play = TURN_PLAYS[def];
  if (!play) return B('NOT_PLAYABLE', 'never played by hand: it acts when drawn', '18.h', `${name} is never played by hand.`);
  if (state.phase !== 'turn') return B('NOT_IN_TURN', 'only during a turn', '18.h');
  if (state.turn.activePlayerId !== pid) return B('NOT_YOUR_TURN', 'only in your own turn', '18.h');
  if (f) return B('WRONG_FRAME', 'finish the current choice first', '18.h', `No card can be played now: the game waits for ${f.kind}.`);
  if (state.turn.step !== 'actions') return B('WRONG_STEP', `only in your Actions step (now: ${state.turn.step})`, '18.h');
  if (!heldLongEnough(state, data, entry)) return B('HOLD_A_TURN', `drawn on turn ${entry.drawnOnTurn}: you must hold it a turn, playable from turn ${entry.drawnOnTurn + (d.play?.delayTurns ?? 0)}`, '18.h', `${name} was drawn on turn ${entry.drawnOnTurn}: it can be played from turn ${entry.drawnOnTurn + 1} (18.h).`);
  if (state.turn.nonBattleCardPlayed) return B('CARD_SLOT_USED', 'you already played your one non-battle card this turn', '18.h', 'You already played your one non-battle card this turn (18.h).');
  if (def === 'revolt' && !revoltTargets(state, data, pid).length) return B('NO_LEGAL_TARGET', 'no rival conquered province under 10 troops', '18.m', 'No rival holds a conquered province with fewer than 10 troops: Revolt! cannot be played and stays in your hand (18.m).');
  if (def === 'assassin' && assassinKills(state, data, pid) < 1) return B('NO_LEGAL_TARGET', 'no province you do not control has 2+ troops (Roma, a neutral Carthage and provinces already struck do not count)', '18.e', 'No province you do not control has 2 or more troops (and has not been struck yet; never Roma or a neutral Carthage): the Assassin cannot be played and stays in your hand (18.e).');
  if (def === 'bribe_the_ally') {
    const ts = bribeTargets(state, data, pid);
    if (!ts.length) return B('NO_LEGAL_TARGET', 'no province is allied to a rival (Carthage never counts)', '18.v', 'No province is allied to a rival: Bribe the Ally! cannot be played and stays in your hand (18.v).');
    const cheap = Math.min(...ts.map(t => t.cost));
    if (pl.gold < cheap) return B('NEED_GOLD', `the cheapest bribe costs ${cheap} Gold; you have ${pl.gold}`, '18.v');
  }
  return null;
}

// ------------------------------------------------------------------ PLAY_CARD
function findCard(ctx, pid, a) {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  let entry = null;
  if (a.cardUid) entry = pl.hand.find(c => c.uid === a.cardUid);
  else if (a.card) entry = pl.hand.find(c => defOf(state, c.uid) === a.card);
  check(entry, 'NOT_IN_HAND', `You do not hold ${a.cardUid ?? a.card ?? 'that card'}.`, '18.h');
  return entry;
}
function spend(ctx, pid, uid, extra = {}) {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  pl.hand.splice(pl.hand.findIndex(c => c.uid === uid), 1); toDiscard(state, uid);
  emit(ctx, 'cardPlayed', { actor: pid, rule: '18.h', pub: { player: pid, def: defOf(state, uid), uid, ...extra } });
}
const TURN_PLAYS = {};     // def id -> {rule, validate(ctx, pid, a) -> plan, apply(ctx, pid, plan)}

define('PLAY_CARD', {
  run(ctx, a) {
    const { state, data } = ctx; const f = topFrame(state);
    if (f) {                                                     // the answer to a response window
      check(f.kind === 'responseWindow' && responseWindows[f.window]?.play, 'WRONG_FRAME', `No card can be played now: the game waits for ${f.kind}.`);
      check(f.resolvableBy.includes(a.playerId), 'NOT_YOUR_PROMPT', `The current prompt is for ${f.resolvableBy.join(', ')}.`);
      responseWindows[f.window].play(ctx, f, a);
      return;
    }
    check(state.phase === 'turn', 'NOT_IN_TURN', 'The game is not in a turn.');
    check(state.turn.activePlayerId === a.playerId, 'NOT_YOUR_TURN', `It is ${state.turn.activePlayerId}'s turn.`);
    check(state.turn.step === 'actions', 'WRONG_STEP', `Cards are played in your Actions step (now: ${state.turn.step}).`, '18.h');
    const pid = a.playerId; const entry = findCard(ctx, pid, a);
    const block = cardBlock(state, data, pid, entry.uid);     // the same reason the UI shows on the card (M8 item 3)
    if (block) fail(block.code, block.message, block.rule);
    const play = TURN_PLAYS[defOf(state, entry.uid)];
    const plan = play.validate(ctx, pid, a);                   // throws before anything changes: an illegal play spends nothing
    state.turn.nonBattleCardPlayed = true;
    spend(ctx, pid, entry.uid, { source: 'turn' });
    play.apply(ctx, pid, plan, entry.uid);
  },
});

// ---- Revolt! (18.d, 18.m, Q38)
TURN_PLAYS.revolt = {
  validate(ctx, pid, a) {
    const { state, data } = ctx; const ok = revoltTargets(state, data, pid);
    check(ok.length, 'NO_LEGAL_TARGET', 'No rival holds a conquered province with fewer than 10 troops: Revolt! cannot be played and stays in your hand (18.m).', '18.m');
    check(ok.includes(a.target), 'ILLEGAL_TARGET', `Revolt! targets a rival's conquered province with fewer than 10 troops (not a start province, not allied, never Roma): ${ok.map(i => nm(data, i)).join(', ')} (18.m, Q38).`, '18.m');
    return { target: a.target, owner: state.provinces[a.target].owner };
  },
  apply(ctx, pid, plan) {
    emit(ctx, 'revoltInspired', { actor: pid, rule: '18.m', pub: { player: pid, province: plan.target, owner: plan.owner } });
    processRevolts(ctx, plan.owner, [plan.target], { source: 'revoltCard', by: pid });
  },
};
// ---- Kill Revolt leader! answers the revoltResponse window (18.f, 18.m)
responseWindows.revoltResponse = {
  rule: '18.f',
  play(ctx, f, a) {
    const { state } = ctx; const entry = findCard(ctx, f.player, a);
    check(defOf(state, entry.uid) === 'kill_revolt_leader', 'WRONG_CARD', 'Only Kill Revolt leader! blocks a revolt (18.f).', '18.f');
    popFrame(ctx);
    spend(ctx, f.player, entry.uid, { source: 'revoltResponse', province: f.province });
    emit(ctx, 'revoltBlocked', { actor: f.player, rule: '18.f', pub: { player: f.player, province: f.province, source: f.source } });
    processRevolts(ctx, f.player, f.rest, { source: f.source });
  },
  pass(ctx, f) {
    if (resolveRevolt(ctx, f.player, f.province, f.rest, f.source, f.by ?? null)) processRevolts(ctx, f.player, f.rest, { source: f.source, by: f.by ?? null });
  },
};

// ---- Assassin! (18.e, 18.i, Q39): kills = min(2, legal); split 1 + 1 allowed; each province once per occupation
TURN_PLAYS.assassin = {
  validate(ctx, pid, a) {
    const { state, data } = ctx; const ok = assassinTargets(state, pid, data); const need = assassinKills(state, data, pid);
    check(need >= 1, 'NO_LEGAL_TARGET', 'No province you do not control has 2 or more troops (and has not been struck yet; never Roma or a neutral Carthage): the Assassin cannot be played and stays in your hand (18.e).', '18.e');
    const kills = Array.isArray(a.kills) ? a.kills : a.target ? [{ province: a.target, n: need }] : null;
    check(kills && kills.length >= 1 && kills.length <= 2, 'BAD_KILLS', 'kills: [{province, n}] with one or two provinces (18.e).', '18.e');
    const seen = new Set(); let total = 0;
    for (const k of kills) {
      check(ok.includes(k.province), 'ILLEGAL_TARGET', `${nm(data, k.province)} is not a legal Assassin target (a province you do not control with 2+ troops, not struck since it changed hands; never Roma or a neutral Carthage): ${ok.map(i => nm(data, i)).join(', ')} (18.e).`, '18.e');
      check(!seen.has(k.province), 'BAD_KILLS', 'Name each province once (both kills on one province are one strike).', '18.e'); seen.add(k.province);
      check(isInt(k.n) && k.n >= 1 && k.n <= strikeTroops(state, k.province) - 1, 'PROVINCE_FLOOR', `${nm(data, k.province)} can lose at most ${strikeTroops(state, k.province) - 1} (it keeps 1, 17.f).`, '18.e');
      total += k.n;
    }
    check(total === need, 'BAD_KILLS', `The Assassin kills exactly ${need} troop(s) here: as many as legally possible, up to 2 (18.e).`, '18.e');
    return { kills };
  },
  apply(ctx, pid, plan) {
    const { state } = ctx;
    for (const k of plan.kills) {
      const p = state.provinces[k.province]; const owner = p.owner;
      if (owner) changeTroops(ctx, k.province, -k.n);
      else {   // neutral natives (Vidi 2026-10-22): they stay depleted and heal after a full round, as after an attack (17.v, Q102 default)
        p.native.present -= k.n;
        if (ctx.data.rules.assassinTargets?.natives17v !== false && p.native.count !== null && p.native.present < p.native.count) p.healAtTurn = state.turn.number + state.players.filter(x => !x.out).length;
      }
      p.struck = struckMark(p);
      emit(ctx, 'troopsAssassinated', { actor: pid, rule: '18.e', pub: { player: pid, province: k.province, owner, n: k.n, left: strikeTroops(state, k.province) } });
    }
  },
};
// a province "struck once per occupation": the mark only holds while the same owner keeps it (18.e)
onSettle(ctx => {
  for (const p of Object.values(ctx.state.provinces)) if (p.struck && p.struck !== struckMark(p)) p.struck = null;
  return false;
});

// ---- Bribe the Ally! (18.v, Q32): pay its native count; 1 of the old owner's troops stays and changes sides, 1 more is lost, the rest flee
TURN_PLAYS.bribe_the_ally = {
  validate(ctx, pid, a) {
    const { state, data } = ctx; const ok = bribeTargets(state, data, pid); const pl = mustPlayer(state, pid);
    check(ok.length, 'NO_LEGAL_TARGET', 'No province is allied to a rival: Bribe the Ally! cannot be played and stays in your hand (18.v).', '18.v');
    const t = ok.find(x => x.province === a.target);
    check(t, 'ILLEGAL_TARGET', `Bribe the Ally! targets a province allied to a rival (never Carthage): ${ok.map(x => nm(data, x.province)).join(', ')} (18.v).`, '18.v');
    check(pl.gold >= t.cost, 'NEED_GOLD', `Bribing ${nm(data, a.target)} costs ${t.cost} Gold (its native count); you have ${pl.gold} (18.v).`, '18.v');
    return { target: a.target, cost: t.cost, owner: state.provinces[a.target].owner };
  },
  apply(ctx, pid, plan) {
    const { state, data } = ctx; const p = state.provinces[plan.target]; const old = mustPlayer(state, plan.owner);
    mustPlayer(state, pid).gold -= plan.cost;
    const had = p.troops; const stay = Math.min(1, had); const lost = had >= 2 ? data.rules.bribeChaosLoss ?? 1 : 0; const flee = had - stay - lost;
    const general = old.general?.at === plan.target;
    Object.assign(p, { owner: pid, status: 'allied', troops: stay, startingOf: null, healAtTurn: null });
    emit(ctx, 'allyBribed', { actor: pid, rule: '18.v', pub: { player: pid, province: plan.target, from: plan.owner, gold: plan.cost, switched: stay, lost, fled: flee } });
    if (data.rules.bribeOwnerPrestigeLoss) awardPrestige(ctx, plan.owner, -data.rules.bribeOwnerPrestigeLoss, 'bribed', '18.v');   // Q89 flag (default 0)
    if (flee > 0 || general) {
      const cand = S.nearestOwned(state, data, plan.owner, plan.target);
      if (!cand.length) { emit(ctx, 'survivorsLost', { actor: plan.owner, rule: '18.v', pub: { player: plan.owner, from: plan.target, n: flee, reason: 'no other province to flee to' } }); if (general) old.general.at = null; }
      else if (cand.length === 1) moveSurvivors(ctx, plan.owner, plan.target, flee, general, cand[0]);
      else pushFrame(ctx, { kind: 'chooseProvince', purpose: 'bribeSurvivors', player: plan.owner, options: cand, from: plan.target, survivors: flee, general });
    }
  },
};
provinceChoiceHandlers.bribeSurvivors = (ctx, f, a) => moveSurvivors(ctx, f.player, f.from, f.survivors, f.general, a.province);

// ------------------------------------------------------------------ registry: the handlers are implemented (PLAN 5.5)
registerEffect('inspireRevolt', TURN_PLAYS.revolt);
registerEffect('killTroops', TURN_PLAYS.assassin);
registerEffect('bribeAlly', TURN_PLAYS.bribe_the_ally);
registerEffect('blockRevolt', responseWindows.revoltResponse);
registerEffect('gainPrestige', { onDraw: 'turn.js drawCard (18.k)' });
registerEffect('gainResources', { onDraw: 'turn.js drawCard (20.g)' });
registerEffect('freeBuild', { onDraw: 'turn.js drawCard / RESOURCE_BUILD / USE_SAVED_RESOURCE (20.f)' });
export { TURN_PLAYS, rivals };
