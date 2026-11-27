// M3: card play (PLAN 4.2 row 11 PLAY_CARD, 5.5 handlers; rules 18.d-18.y, 16.m). One action, PLAY_CARD, does two jobs:
//   * in your own Actions step (no frame waiting): Revolt!, Assassin!, Bribe the Ally! (hold-a-turn, one non-battle card per turn, 18.h);
//   * as the answer to a response window: Kill Revolt leader! (window revoltResponse) and Busy Little Bee! (window displeasedResponse).
// Battle cards, the Horn and the Battlefield Imperator are played through the battle (battle.js); Prestige! and Garrison Requirement -1!
// act on draw (turn.js). Every target check lives in a pure selector below, so legalActions and the M4 AI use the same rules.
import { fail, check, emit, roll, pushFrame, popFrame, topFrame, mustPlayer, playerOf, toDiscard, toThrowaway, onSettle, awardPrestige } from './core.js';
import { int } from './rng.js';
import { define, defineRoll } from './actions.js';
import { registerEffect } from './registry.js';
import { changeTroops, processRevolts, resolveRevolt, moveSurvivors, provinceChoiceHandlers, responseWindows } from './turn.js';
import { attackBlock, declareAttack } from './battle.js';
import { OWNED_STATUSES } from './state.js';
import * as S from './selectors.js';

const isInt = n => Number.isInteger(n);
const nm = (data, id) => data.provincesById[id]?.name ?? id;
const rivals = (state, pid) => state.players.filter(p => p.id !== pid && !p.out).map(p => p.id);
const defOf = (state, uid) => state.cards[uid].def;

// ------------------------------------------------------------------ pure target selectors (shared with legalActions / AI)
/** Revolt! targets (18.m, Q38): a rival's CONQUERED province (not a start province, not allied, never Roma), fewer than 10 troops,
 * and never a province of a player with 2 or fewer provinces (small-empire protection, 18.m, v31.23). */
export const revoltTargets = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'conquered' && id !== 'roma' && S.canRevolt(state, data, id) && !S.isSmallEmpire(state, p.owner);
});
/** Rival conquered provinces that WOULD be Revolt! targets but for the owner's general stationed there (18.m, v31.10): for the denial reason. */
export const revoltGeneralBlocked = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'conquered' && id !== 'roma' && p.troops < data.rules.revoltImmuneAtTroops && S.generalProtects(state, id);
});
/** Rival conquered provinces that WOULD be Revolt! targets but for the owner's small empire (18.m, v31.23): for the denial reason. */
export const revoltSmallEmpireBlocked = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'conquered' && id !== 'roma' && S.canRevolt(state, data, id) && S.isSmallEmpire(state, p.owner);
});
/** Why Revolt! has no target right now: the general's protection, the small-empire rule, or no province under 10 troops (18.m). */
const revoltNoTarget = (state, data, pid) => {
  const blocked = revoltGeneralBlocked(state, data, pid);
  if (blocked.length) return { reason: 'the general is stationed in every rival conquered province under 10 troops', message: `The general is stationed in every rival conquered province with fewer than 10 troops (${blocked.map(id => nm(data, id)).join(', ')}), so none can revolt: Revolt! cannot be played and stays in your hand (18.m).` };
  const small = revoltSmallEmpireBlocked(state, data, pid);
  if (small.length) return { reason: 'every rival conquered province under 10 troops belongs to a player with 2 or fewer provinces', message: `Every rival conquered province with fewer than 10 troops (${small.map(id => `${nm(data, id)} (${playerOf(state, state.provinces[id].owner)?.name ?? state.provinces[id].owner})`).join(', ')}) belongs to a player with 2 or fewer provinces, so none can revolt: Revolt! cannot be played and stays in your hand (18.m).` };
  return { reason: 'no rival conquered province under 10 troops', message: 'No rival holds a conquered province with fewer than 10 troops: Revolt! cannot be played and stays in your hand (18.m).' };
};
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
/** Bandits on the Road! targets (18.ae): rivals whose current Merchant Bonus is above 0 — the same road-network formula the
 * Resources step pays (22.b), Augustus +1 included. A rival with no bonus cannot be robbed. */
export const banditTargets = (state, data, pid) => rivals(state, pid).map(id => ({ player: id, bonus: S.merchantBonusFor(state, data, id, S.roadNetwork(state, data, id).roads) })).filter(t => t.bonus > 0);
/** Spy in the Tent! targets (18.af): rivals holding at least 1 Game Card in hand. Resource cards live in savedResources and
 * Displeased cards never sit in a hand, so the hand IS the Game Cards; the deck filter in apply is a safety net. */
/** Cards a Spy may steal from `victim` (18.af, v32.8): any Game card, except a max-1-held card the thief already holds —
 * the same hold-at-most-1 rule the draw enforces (18.t, 18.w, 18.y) — so a Spy can never hand you a second
 * Battlefield Imperator, Garrison Requirement or Horn of Titus Pullus. A victim whose only Game cards are thus
 * excluded is not a target at all. */
const spyStealable = (state, data, pid, victim) => playerOf(state, victim).hand.filter(c => {
  const def = state.cards[c.uid].def;
  return state.cards[c.uid].deck === 'game' && !(data.rules.uniqueHeldCards.includes(def) && S.holdsUnique(state, pid, def));
});
export const spyTargets = (state, data, pid) => rivals(state, pid).filter(id => spyStealable(state, data, pid, id).length);
/** Bribe the Ally! targets (18.v, Q32): a province allied to a rival (never Carthage), with the Gold cost = its native count,
 * and never a province of a player with 2 or fewer provinces (small-empire protection, 18.v, v31.23). */
export const bribeTargets = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'allied' && id !== 'carthage' && !S.generalProtects(state, id) && !S.isSmallEmpire(state, p.owner);
}).map(id => ({ province: id, cost: bribeCost(state, id) }));
export const bribeCost = (state, id) => state.provinces[id].native.count ?? 0;
/** Rival allied provinces that would be Bribe targets but for their owner's general stationed there (18.v, 17.c). */
export const bribeGeneralBlocked = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'allied' && id !== 'carthage' && S.generalProtects(state, id);
});
/** Rival allied provinces that WOULD be Bribe targets but for their owner's small empire (18.v, v31.23): for the denial reason. */
export const bribeSmallEmpireBlocked = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id];
  return p.owner && p.owner !== pid && !playerOf(state, p.owner).out && p.status === 'allied' && id !== 'carthage' && !S.generalProtects(state, id) && S.isSmallEmpire(state, p.owner);
});
/** Why Bribe the Ally! has no target right now: the general's protection, the small-empire rule, or no allied province at all (18.v). */
const bribeNoTarget = (state, data, pid) => {
  const blocked = bribeGeneralBlocked(state, data, pid);
  if (blocked.length) return { reason: 'the general is stationed in every province allied to a rival', message: `The general is stationed in every province allied to a rival (${blocked.map(id => nm(data, id)).join(', ')}), so none can be bribed: Bribe the Ally! cannot be played and stays in your hand (18.v).` };
  const small = bribeSmallEmpireBlocked(state, data, pid);
  if (small.length) return { reason: 'every province allied to a rival belongs to a player with 2 or fewer provinces', message: `Every province allied to a rival (${small.map(id => `${nm(data, id)} (${playerOf(state, state.provinces[id].owner)?.name ?? state.provinces[id].owner})`).join(', ')}) belongs to a player with 2 or fewer provinces, so none can be bribed: Bribe the Ally! cannot be played and stays in your hand (18.v).` };
  return { reason: 'no province is allied to a rival, and you have no allied province of your own (Carthage never counts)', message: 'No province is allied to a rival and you have no allied province to turn into a conquered one: Bribe the Ally! cannot be played and stays in your hand (18.v).' };
};
/** Bribe the Ally! second use (18.v, 19.r; Vidi 2026-10-25): your own allied provinces (never Carthage), cost 1 Gold to the bank. */
export const bribeOwnTargets = (state, data, pid) => Object.keys(state.provinces).sort().filter(id => {
  const p = state.provinces[id]; return p.owner === pid && p.status === 'allied' && id !== 'carthage';
}).map(id => ({ province: id, cost: data.rules.bribeOwnAllyGold ?? 1, own: true }));
/** v31.27 (Tomas 2026-11-14, 18.v): after a RIVAL bribe, troops that may be moved into the newly-allied province from one of
 * the briber's own provinces. The cap is the stricter of the normal move limit (maxLeaving: the source keeps its floor of 1,
 * a held Roma keeps 10) and the source's minimum garrison — so the source never drops below its minimum, which is what the
 * batch spec means by "maxLeaving — cannot strip the source below its minimum garrison". For a starting or allied source the
 * two agree (minimum 1 = the floor); for a conquered source the minimum is the binding one (natives + 1, 17.f). No route or
 * adjacency is required: "from any one province" (Tomas's words) means any province the briber owns, however far away. */
export const maxBribeReinforce = (state, data, id) => {
  const p = state.provinces[id];
  if (!p || p.owner === null) return 0;
  const keep = Math.max(S.minGarrison(state, data, id).min, p.status === 'held' ? data.rules.romaFloorOnHold : data.rules.provinceFloor);
  return Math.max(0, p.troops - keep);
};
/** Sources for the reinforce prompt: the briber's own provinces except the target itself, with at least 1 troop to spare. */
export const bribeReinforceSources = (state, data, pid, target) => S.provincesOf(state, pid).filter(id => id !== target && maxBribeReinforce(state, data, id) >= 1);
/** Sneak Attack from the Sea! origins (18.z): your own coastal provinces that can send a troop — with a Road, or Pompey with the army (15.d). */
export const sneakOrigins = (state, data, pid) => S.provincesOf(state, pid).filter(id => S.isCoastal(data, id) && S.maxLeaving(state, data, id) >= 1
  && (state.provinces[id].road || (playerOf(state, pid).general?.id === 'pompey' && playerOf(state, pid).general?.at === id && S.generalPerksActive(state, pid))));
/** Every (origin, target, max troops) pair a Sneak Attack could legally declare right now (18.z): any coastal target, Roma still needs Battlefield Imperator. A target whose natives are not rolled yet is listable too: the only thing missing is the natives' roll, which happens when the target is picked (17.h), as for a normal attack's preview. */
export const sneakAttacks = (state, data, pid) => {
  const out = [];
  for (const from of sneakOrigins(state, data, pid)) {
    const max = S.maxLeaving(state, data, from);
    for (const target of data.provinceIds) {
      if (target === from || !S.isCoastal(data, target)) continue;
      if ([false, true].some(g => { const b = attackBlock(state, data, pid, from, target, { withGeneral: g, troops: max, sneak: true }); return !b || b.code === 'NATIVES_NOT_ROLLED'; })) out.push({ from, target, max });
    }
  }
  return out;
};

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
  // v31.4: a click during a roll or a draw must say why, not look like a dead button
  if (f?.kind === 'roll') {
    const what = f.purpose === 'battleRound' ? `battle round ${f.round}` : f.purpose === 'gameRoll' ? 'the Game Roll' : f.purpose === 'revoltRoll' || f.purpose === 'extraRevoltRoll' ? 'the Revolt Roll' : `the ${f.die} roll`;
    return B('WAITING_FOR_ROLL', `waiting for ${what}`, '18.h', `Can't play a card now: the game is waiting for ${what}.`);
  }
  if (f?.kind === 'draw') {
    const deck = f.deck === 'game' ? 'a Game Card' : f.deck === 'resource' ? 'a Resource card' : f.deck === 'displeased' ? 'a Rome Is Displeased card' : 'a card';
    return B('WAITING_FOR_DRAW', `waiting to draw ${deck}`, '18.h', `Can't play a card now: the game is waiting for ${deck} to be drawn.`);
  }
  if (d.type === 'battle') return B('USE_IN_BATTLE', 'a battle card: commit it when you attack or are attacked', '18.i', `${name} is a battle card: commit it when you attack or are attacked (18.i).`);
  if (def === 'battlefield_imperator') return B('USE_WITH_ATTACK', 'used by attacking Roma: choose Roma as your target', '18.w', 'Battlefield Imperator is used by attacking Roma (ATTACK on Roma, 18.w).');
  if (def === 'kill_revolt_leader') return B('ONLY_AGAINST_REVOLT', 'played only when a revolt is aimed at you', '18.f', 'Kill Revolt leader! is played when a revolt is aimed at you (18.f).');
  if (def === 'horn_of_titus_pullus') return B('ONLY_WHEN_ATTACKED', 'played only when one of your provinces is attacked', '18.y', 'Horn of Titus Pullus! is played when one of your provinces is attacked (18.y).');
  if (def === 'busy_little_bee') return B('ONLY_AGAINST_DISPLEASED', 'played only when you draw a Rome Is Displeased card', '18.x', 'Busy Little Bee! is played when you draw a Rome Is Displeased card (18.x).');
  if (def === 'elephant_panic') return B('ONLY_AGAINST_ELEPHANTS', 'played only when another player uses Elephants! in a battle', '18.ac', 'Elephant Panic! is played when another player uses Elephants! in a battle, before the first die is rolled (18.ac).');
  if (d.kind === 'passive') return B('PASSIVE_BONUS', 'a lasting bonus while you hold it: never played', d.rule?.[0] ?? '18.h', `${name} is never played: it works while you hold it (${d.rule?.[0] ?? '18.h'}).`);   // v31.37 Coin Master (18.aa, 18.ab)
  const play = TURN_PLAYS[def];
  if (!play) return B('NOT_PLAYABLE', 'never played by hand: it acts when drawn', '18.h', `${name} is never played by hand.`);
  if (state.phase !== 'turn') return B('NOT_IN_TURN', 'only during a turn', '18.h');
  if (state.turn.activePlayerId !== pid) return B('NOT_YOUR_TURN', 'only in your own turn', '18.h');
  if (f) return B('WRONG_FRAME', 'finish the current choice first', '18.h', `No card can be played now: the game waits for ${f.kind}.`);
  if (state.turn.step !== 'actions') return B('WRONG_STEP', `only in your Actions step (now: ${state.turn.step})`, '18.h');
  if (!heldLongEnough(state, data, entry)) return B('HOLD_A_TURN', `drawn on turn ${entry.drawnOnTurn}: you must hold it a turn, playable from turn ${entry.drawnOnTurn + (d.play?.delayTurns ?? 0)}`, '18.h', `${name} was drawn on turn ${entry.drawnOnTurn}: it can be played from turn ${entry.drawnOnTurn + 1} (18.h).`);
  if (state.turn.nonBattleCardPlayed && !S.cardSlotOpen(state, def)) {
    if (state.turn.forcedMarchExtra) return B('EXTRA_PLAY_NON_BATTLE_ONLY', `Forced March!'s extra play is for a non-battle card (Revolt!, Assassin!, Bribe the Ally!, Bandits on the Road!, Spy in the Tent!): not ${name}`, '18.ad', `Forced March!'s extra card play is for a non-battle Game card only (Revolt!, Assassin!, Bribe the Ally!, Bandits on the Road!, Spy in the Tent!, Busy Little Bee!), so ${name} cannot be it (18.ad).`);
    return B('CARD_SLOT_USED', 'you already played your one non-battle card this turn', '18.h', `You already played your one non-battle card this turn (18.h)${state.turn.forcedMarch ? ', and Forced March!\'s extra play is used too (18.ad)' : ''}.`);
  }
  if (def === 'revolt' && !revoltTargets(state, data, pid).length) { const n = revoltNoTarget(state, data, pid); return B('NO_LEGAL_TARGET', n.reason, '18.m', n.message); }
  if (def === 'assassin' && assassinKills(state, data, pid) < 1) return B('NO_LEGAL_TARGET', 'no province you do not control has 2+ troops (Roma, a neutral Carthage and provinces already struck do not count)', '18.e', 'No province you do not control has 2 or more troops (and has not been struck yet; never Roma or a neutral Carthage): the Assassin cannot be played and stays in your hand (18.e).');
  if (def === 'bribe_the_ally') {
    const ts = [...bribeTargets(state, data, pid), ...bribeOwnTargets(state, data, pid)];
    if (!ts.length) { const n = bribeNoTarget(state, data, pid); return B('NO_LEGAL_TARGET', n.reason, '18.v', n.message); }
    const cheap = Math.min(...ts.map(t => t.cost));
    if (pl.gold < cheap) return B('NEED_GOLD', `the cheapest use costs ${cheap} Gold; you have ${pl.gold}`, '18.v');
  }
  if (def === 'bandits_on_the_road' && !banditTargets(state, data, pid).length) return B('NO_LEGAL_TARGET', 'no other player has a Merchant Bonus to steal right now', '18.ae', 'No other player has a Merchant Bonus right now: Bandits on the Road! cannot be played and stays in your hand (18.ae).');
  if (def === 'spy_in_the_tent' && !spyTargets(state, data, pid).length) return B('NO_LEGAL_TARGET', 'no other player holds a Game Card to steal', '18.af', 'No other player holds a Game Card: Spy in the Tent! cannot be played and stays in your hand (18.af).');
  if (def === 'sneak_attack_sea' && state.turn.actionsUsed >= S.effectiveActionsPerTurn(state, data)) return B('NO_ACTIONS_LEFT', `you have already used your ${S.effectiveActionsPerTurn(state, data)} actions this turn`, '17.e', `You have already used your ${S.effectiveActionsPerTurn(state, data)} actions this turn (17.e).`);   // v32.7: TURN_PLAYS.sneak_attack_sea.validate refuses the play with no action left (v31.14, the attack costs 1 action), so cardBlock must say so too — otherwise the card looks playable while the dry run in legalActions drops it
  if (def === 'sneak_attack_sea' && !sneakAttacks(state, data, pid).length) return B('NO_LEGAL_TARGET', 'no coastal province of yours with a Road can sail to a coastal province (Germanica and Swiss have no sea link)', '18.z', 'No coastal province of yours with a Road can sail to a coastal province (Pompey with the army needs no Road): Sneak Attack from the Sea! cannot be played and stays in your hand (18.z).');
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
/** Removes a played card from the hand: to its discard pile (18.l), or to the throwaway pile (18.z, v31.11) when `dest` is
 * 'throwaway' — a Sneak Attack from the Sea! actually played to attack, gone for good. */
function spend(ctx, pid, uid, extra = {}, dest = 'discard') {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  pl.hand.splice(pl.hand.findIndex(c => c.uid === uid), 1);
  if (dest === 'throwaway') toThrowaway(state, uid); else toDiscard(state, uid);
  emit(ctx, 'cardPlayed', { actor: pid, rule: '18.h', pub: { player: pid, def: defOf(state, uid), uid, ...extra, ...(dest === 'throwaway' ? { dest: 'throwaway' } : {}) } });
}
/** Marks a card play in the turn: the normal slot if free, else Forced March!'s extra play (18.h, 18.ad). */
export function useCardSlot(state) {
  if (!state.turn.nonBattleCardPlayed) state.turn.nonBattleCardPlayed = true;
  else if (state.turn.forcedMarchExtra) { state.turn.forcedMarchExtra = false; state.turn.extraCardPlayed = true; }
}
const TURN_PLAYS = {};     // def id -> {rule, validate(ctx, pid, a) -> plan, apply(ctx, pid, plan)}

define('PLAY_CARD', {
  run(ctx, a) {
    const { state, data } = ctx; const f = topFrame(state);
    if (f) {                                                     // the answer to a response window
      const wait = f.kind === 'roll' ? 'Can\'t play a card now: the game is waiting for a roll.' : f.kind === 'draw' ? 'Can\'t play a card now: the game is waiting for a card to be drawn.' : `No card can be played now: the game waits for ${f.kind}.`;
      check(f.kind === 'responseWindow' && responseWindows[f.window]?.play, 'WRONG_FRAME', wait);
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
    useCardSlot(state);   // v32.1 (18.ad): the normal slot first, else Forced March!'s extra play
    // v31.11 (18.z): a Sneak Attack from the Sea! actually played to attack goes to the throwaway pile for good, never the discard
    spend(ctx, pid, entry.uid, { source: 'turn' }, defOf(state, entry.uid) === 'sneak_attack_sea' ? 'throwaway' : 'discard');
    play.apply(ctx, pid, plan, entry.uid);
  },
});

// ---- Revolt! (18.d, 18.m, Q38)
TURN_PLAYS.revolt = {
  validate(ctx, pid, a) {
    const { state, data } = ctx; const ok = revoltTargets(state, data, pid);
    check(ok.length, 'NO_LEGAL_TARGET', revoltNoTarget(state, data, pid).message, '18.m');
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

// ---- Elephant Panic! answers the elephantPanic window (18.ac): one committed Elephants! of the opponent is thrown away
responseWindows.elephantPanic = {
  rule: '18.ac',
  play(ctx, f, a) {
    const { state } = ctx; const b = state.battle;
    const entry = findCard(ctx, f.player, a);
    check(defOf(state, entry.uid) === 'elephant_panic', 'WRONG_CARD', 'Only Elephant Panic! answers this window (18.ac).', '18.ac');
    const oppSide = f.side === 'att' ? 'def' : 'att';
    const i = (b[oppSide].played ?? []).findIndex(c => c.def === 'elephants');
    check(i >= 0, 'NO_ELEPHANT', 'There is no Elephants! left to panic in this fight (18.ac).', '18.ac');
    popFrame(ctx);
    spend(ctx, f.player, entry.uid, { source: 'elephantPanic', battleId: b.id });
    const [gone] = b[oppSide].played.splice(i, 1);
    b[oppSide].elephants -= 1;   // the card is already in the discard pile (committed cards leave the hand at play time, 18.i); Panic only takes it out of the fight, and keeps it from being refunded on an early retreat (17.k)
    // v31.43 (18.b): Panic takes the FIRST committed Elephants! — the odd-rounds card — and the survivor keeps its own
    // parity (a 2-stack leaves the even-rounds card). A pre-v31.43 save has no parity on its played entries: the removed
    // card was the first committed, so any survivors cover the even rounds — stamp them so the fallback can't flip them.
    const goneParity = gone.parity ?? 'odd';
    if (goneParity === 'odd') b[oppSide].eleOdd = false; else b[oppSide].eleEven = false;
    if (!gone.parity && b[oppSide].elephants > 0) { for (const c of b[oppSide].played) if (c.def === 'elephants') c.parity = 'even'; b[oppSide].eleEven = true; }
    emit(ctx, 'elephantPanicked', { actor: f.player, rule: '18.ac', pub: { battleId: b.id, player: f.player, opponent: b[oppSide].player ?? null, side: f.side, uid: gone.uid, parity: goneParity } });
  },
  pass(ctx, f) { /* the window closes; advance() asks the other side, then the first die is rolled */ },
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
      else {   // neutral natives (v31.26, Tomas 2026-11-14): Assassin kills are PERMANENT — the native COUNT drops,
        // so they never heal back (18.e). Mirrors borrowing (17.u, battle.js loseBorrowed): reduce count, clamp
        // rolled, emit nativesReduced. No healAtTurn is set: the turn.js beginResources heal (17.v) only restores
        // present to the (reduced) count, and every refill (revolt, ally, conquest, displeased) reads count too,
        // so nothing can resurrect them. The old Q102 default (heal as in 17.v) is gone; the ruleset
        // assassinTargets.natives17v flag is now unused and kept only for schema/save compatibility (see ruleset.json).
        if (p.native.count !== null) {
          const from = p.native.count;
          p.native.count = Math.max(0, from - k.n);
          // v31.37 (18.e/17.v bug): the troops present die too — a depleted 5/10 struck for 2 is 3/8, not 5/8; then clamp to the new count
          if (p.native.present !== null) p.native.present = Math.min(Math.max(0, p.native.present - k.n), p.native.count);
          if (p.native.rolled !== null) p.native.rolled = Math.min(p.native.rolled, p.native.count);
          emit(ctx, 'nativesReduced', { rule: '18.e', pub: { province: k.province, from, to: p.native.count, reason: 'assassin' } });
        } else {
          p.native.present -= k.n;
        }
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
    const { state, data } = ctx; const pl = mustPlayer(state, pid);
    const own = bribeOwnTargets(state, data, pid).find(x => x.province === a.target);
    if (own) {                                                   // second use: own ally -> conquered (18.v, 19.r)
      check(pl.gold >= own.cost, 'NEED_GOLD', `Turning ${nm(data, a.target)} into a conquered province costs ${own.cost} Gold; you have ${pl.gold} (18.v).`, '18.v');
      return { target: a.target, cost: own.cost, own: true };
    }
    const ok = bribeTargets(state, data, pid); const mine = bribeOwnTargets(state, data, pid);
    check(ok.length || mine.length, 'NO_LEGAL_TARGET', 'No province is allied to a rival and you have no allied province of your own: Bribe the Ally! cannot be played and stays in your hand (18.v).', '18.v');
    const t = ok.find(x => x.province === a.target);
    check(t, 'ILLEGAL_TARGET', `Bribe the Ally! targets a province allied to a rival (never Carthage)${ok.length ? `: ${ok.map(x => nm(data, x.province)).join(', ')}` : ''}${mine.length ? `, or one of your own allied provinces to make it conquered: ${mine.map(x => nm(data, x.province)).join(', ')}` : ''} (18.v).`, '18.v');
    check(pl.gold >= t.cost, 'NEED_GOLD', `Bribing ${nm(data, a.target)} costs ${t.cost} Gold (its native count); you have ${pl.gold} (18.v).`, '18.v');
    return { target: a.target, cost: t.cost, owner: state.provinces[a.target].owner };
  },
  apply(ctx, pid, plan) {
    const { state, data } = ctx; const p = state.provinces[plan.target];
    if (plan.own) {
      mustPlayer(state, pid).gold -= plan.cost;
      Object.assign(p, { status: 'conquered' });
      emit(ctx, 'allyMadeConquered', { actor: pid, rule: '18.v', pub: { player: pid, province: plan.target, gold: plan.cost, troops: p.troops, prestige: 1 } });
      awardPrestige(ctx, pid, 1, 'own ally made conquered', '18.v');
      return;
    }
    const old = mustPlayer(state, plan.owner);
    mustPlayer(state, pid).gold -= plan.cost;
    const had = p.troops; const stay = Math.min(1, had); const lost = had >= 2 ? data.rules.bribeChaosLoss ?? 1 : 0; const flee = had - stay - lost;
    const general = old.general?.at === plan.target;
    Object.assign(p, { owner: pid, status: 'allied', troops: stay, startingOf: null, healAtTurn: null });
    emit(ctx, 'allyBribed', { actor: pid, rule: '18.v', pub: { player: pid, province: plan.target, from: plan.owner, gold: plan.cost, switched: stay, lost, fled: flee } });
    if (data.rules.bribeOwnerPrestigeLoss) awardPrestige(ctx, plan.owner, -data.rules.bribeOwnerPrestigeLoss, 'bribed', '18.v');   // Q89 flag (ruled 2026-11-15, default 0)
    if (flee > 0 || general) {
      const cand = S.nearestOwned(state, data, plan.owner, plan.target);
      if (!cand.length) { emit(ctx, 'survivorsLost', { actor: plan.owner, rule: '18.v', pub: { player: plan.owner, from: plan.target, n: flee, reason: 'no other province to flee to' } }); if (general) old.general.at = null; }
      else if (cand.length === 1) moveSurvivors(ctx, plan.owner, plan.target, flee, general, cand[0], '18.v');
      else pushFrame(ctx, { kind: 'chooseProvince', purpose: 'bribeSurvivors', player: plan.owner, options: cand, from: plan.target, survivors: flee, general });
    }
    // v31.27 (Tomas 2026-11-14, 18.v): the bribe no longer just leaves 1 troop there — the briber may now move troops into the
    // newly-allied province from any ONE of their own provinces, as part of the bribe resolution (no extra action: the bribe
    // already used the 1-non-battle-card slot, 18.h). Pushed last, so it sits on top of any bribeSurvivors frame and the briber
    // answers first. No frame when nothing can move: the bribe simply leaves the 1 troop, as before. The frame lives in
    // state.pending, so it survives saves like every other frame.
    const sources = bribeReinforceSources(state, data, pid, plan.target);
    if (sources.length) pushFrame(ctx, { kind: 'chooseProvince', purpose: 'bribeReinforce', player: pid, target: plan.target, options: sources });
  },
};
provinceChoiceHandlers.bribeSurvivors = (ctx, f, a) => moveSurvivors(ctx, f.player, f.from, f.survivors, f.general, a.province, '18.v');
/** The bribe-reinforce answer (18.v, v31.27): move 0..max troops from the chosen source into the newly-allied province.
 * 0 is legal — moving none is how the briber declines. No route is checked: any owned province may send troops. */
provinceChoiceHandlers.bribeReinforce = (ctx, f, a) => {
  const { state, data } = ctx;
  check(S.controls(state, f.player, a.province), 'NOT_YOURS', `${nm(data, a.province)} is not one of your provinces.`, '18.v');
  const n = a.troops ?? 0;
  check(isInt(n) && n >= 0, 'BAD_TROOPS', 'troops must be a whole number >= 0.', '18.v');
  const max = maxBribeReinforce(state, data, a.province);
  check(n <= max, 'TOO_MANY', `At most ${max} troop(s) may leave ${nm(data, a.province)} (it keeps its minimum garrison, 17.f).`, '18.v');
  if (n > 0) { changeTroops(ctx, a.province, -n); changeTroops(ctx, f.target, n); }
  emit(ctx, 'bribeReinforced', { actor: f.player, rule: '18.v', pub: { player: f.player, province: f.target, from: a.province, n } });
};

/** Sneak Attack from the Sea! (18.z, muse batch): in the Actions step, attack any coastal province from one of your coastal
 * provinces with a Road (Pompey with the army is exempt, 15.d). A sea attack (2 dice; Pompey 3, Scipio an extra die), costs
 * 1 action, no borrowing (move troops there first). Roma still needs a Battlefield Imperator (18.w); neutral Carthage cannot be attacked (16.n). */
TURN_PLAYS.sneak_attack_sea = {
  validate(ctx, pid, a) {
    const { state, data } = ctx;
    check(data.provincesById[a.from] && data.provincesById[a.target], 'UNKNOWN_PROVINCE', `Unknown province "${a.from ?? a.target}".`, '18.z');
    check(S.controls(state, pid, a.from), 'NOT_YOURS', `${nm(data, a.from)} is not one of your provinces.`, '17.e');
    check(S.isCoastal(data, a.from), 'ORIGIN_NOT_COASTAL', `${nm(data, a.from)} has no sea link: a Sneak Attack must sail from a coastal province (18.z).`, '18.z');
    check(S.isCoastal(data, a.target), 'TARGET_LANDLOCKED', `${nm(data, a.target)} has no sea link: a Sneak Attack can only target a coastal province (18.z).`, '18.z');
    // v31.14 fix: the attack itself costs 1 action (declared in apply, or after the native roll in the sneakNativeRoll
    // handler), so the play must be refused up front when no action is left — otherwise the card is spent, the roll frame
    // is pushed, and ROLL can never resolve it (NO_ACTIONS_LEFT on a frame with no way out). Found by the AI-vs-random test.
    check(state.turn.actionsUsed < S.effectiveActionsPerTurn(state, data), 'NO_ACTIONS_LEFT', `You have already used your ${S.effectiveActionsPerTurn(state, data)} actions this turn (17.e).`, '17.e');
    const block = attackBlock(state, data, pid, a.from, a.target, { withGeneral: a.withGeneral, troops: a.troops ?? null, sneak: true });
    check(!block || block.code === 'NATIVES_NOT_ROLLED', block?.code ?? 'ILLEGAL', block?.reason ?? '', block?.rule);
    const t = state.provinces[a.target];
    const needsNativeRoll = t.owner === null && a.target !== 'roma' && a.target !== 'carthage' && t.native.rolled === null;
    return { from: a.from, target: a.target, troops: a.troops, withGeneral: !!a.withGeneral, needsNativeRoll };
  },
  apply(ctx, pid, plan) {
    if (plan.needsNativeRoll) {   // v31.10: unrolled natives are rolled before the attack is declared (17.h), so the battle never starts against an unknown force
      const { data } = ctx;
      pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.native, purpose: 'sneakNativeRoll', player: pid, target: plan.target, from: plan.from, troops: plan.troops, withGeneral: plan.withGeneral });
      return;
    }
    declareAttack(ctx, pid, { from: plan.from, target: plan.target, troops: plan.troops, withGeneral: plan.withGeneral, borrow: 0 }, { sneak: true });
  },
};

// ---- Forced March! (18.ad): 3 actions this turn instead of 2, plus one extra NON-battle card play this turn (v32.1, Vidi 2026-11-23);
// playing the card costs no action and uses the normal one-card slot
TURN_PLAYS.forced_march = {
  validate(ctx, pid) {
    const { state } = ctx;
    check(!state.turn.forcedMarch, 'ALREADY_MARCHING', 'You already played Forced March! this turn (18.ad).', '18.ad');
    // v32.3 (18.ad, Vidi 2026-11-24): played after another card already used the normal slot, the March is the turn's 2nd card
    return { asSecondCard: S.forcedMarchAsSecondCard(state) };   // read before useCardSlot marks anything
  },
  apply(ctx, pid, plan = {}) {
    const { state } = ctx;
    state.turn.forcedMarch = true;
    if (plan.asSecondCard) { state.turn.forcedMarchExtra = false; state.turn.extraCardPlayed = true; }   // it IS the extra play: 2 cards played
    else state.turn.forcedMarchExtra = true;   // v32.1 (18.ad, Vidi 2026-11-23): one extra non-battle card play this turn
    emit(ctx, 'forcedMarchPlayed', { actor: pid, rule: '18.ad', pub: { player: pid, extraCardPlay: !plan.asSecondCard, ...(plan.asSecondCard ? { asSecondCard: true } : {}) } });
  },
};
// ---- Bandits on the Road! (18.ae): steal the victim's current Merchant Bonus in Gold now; they get none next turn
TURN_PLAYS.bandits_on_the_road = {
  validate(ctx, pid, a) {
    const { state, data } = ctx;
    const ok = banditTargets(state, data, pid);
    check(ok.length, 'NO_LEGAL_TARGET', 'No other player has a Merchant Bonus right now: Bandits on the Road! cannot be played and stays in your hand (18.ae).', '18.ae');
    const t = ok.find(x => x.player === a.targetPlayer);
    check(t, 'ILLEGAL_TARGET', `${playerOf(state, a.targetPlayer)?.name ?? a.targetPlayer} has no Merchant Bonus to steal (18.ae).`, '18.ae');
    return { victim: a.targetPlayer, gold: t.bonus };
  },
  apply(ctx, pid, plan) {
    const { state } = ctx; const pl = mustPlayer(state, pid); const victim = mustPlayer(state, plan.victim);
    pl.gold += plan.gold;
    victim.noMerchantBonus = true;
    (victim.banditsLosses ??= []).push({ gold: plan.gold, thief: pid, turn: state.turn.number });   // v32.6: the Roads popup's history of Gold stolen from this player
    emit(ctx, 'banditsPlayed', { actor: pid, rule: '18.ae', pub: { player: pid, victim: plan.victim, gold: plan.gold } });
  },
};
// ---- Spy in the Tent! (18.af): steal 1 random Game Card from a rival's hand — the pick is blind (seeded RNG, so all clients
// agree), but the stolen card is then revealed to everyone (v31.41: the popup and the game log name it, decided by Vidi 2026-11-22)
TURN_PLAYS.spy_in_the_tent = {
  validate(ctx, pid, a) {
    const { state, data } = ctx;
    const ok = spyTargets(state, data, pid);
    check(ok.length, 'NO_LEGAL_TARGET', 'No other player holds a Game Card: Spy in the Tent! cannot be played and stays in your hand (18.af).', '18.af');
    check(ok.includes(a.targetPlayer), 'ILLEGAL_TARGET', `${playerOf(state, a.targetPlayer)?.name ?? a.targetPlayer} holds no Game Card to steal (18.af).`, '18.af');
    return { victim: a.targetPlayer };
  },
  apply(ctx, pid, plan) {
    const { state, data } = ctx; const thief = mustPlayer(state, pid); const victim = mustPlayer(state, plan.victim);
    const pool = spyStealable(state, data, pid, plan.victim);
    check(pool.length, 'NO_GAME_CARD', 'The victim holds no Game Card to steal (18.af).', '18.af');
    const [stolen] = pool.splice(int(state.rng, pool.length) - 1, 1);
    victim.hand.splice(victim.hand.findIndex(c => c.uid === stolen.uid), 1);
    thief.hand.push(stolen);
    (victim.stolenCards ??= []).push({ def: state.cards[stolen.uid].def, thief: pid, turn: state.turn.number, source: 'spy' });   // v32.6: the Cards popup's list of cards lost from this player (v32.8: tax losses share the list, marked source 'tax')
    emit(ctx, 'spyPlayed', { actor: pid, rule: '18.af', pub: { player: pid, victim: plan.victim, def: state.cards[stolen.uid].def } });
  },
};

/** The natives of a Sneak Attack target are rolled when the attack is declared on unrolled natives (18.z, 17.h): the same d6 table as scouting, then the attack is declared with the stored plan. */
defineRoll('sneakNativeRoll', (ctx, f) => {
  const { state, data } = ctx;
  const v = roll(ctx, data.rules.dice.native, 'sneakNativeRoll', f.player);
  const count = data.rules.nativeRollTable.find(r => r.d6.includes(v)).count;
  state.provinces[f.target].native = { rolled: count, count, present: count };
  popFrame(ctx);
  emit(ctx, 'nativesRolled', { actor: f.player, rule: '17.h', pub: { player: f.player, province: f.target, d6: v, count } });
  declareAttack(ctx, f.player, { from: f.from, target: f.target, troops: f.troops, withGeneral: f.withGeneral, borrow: 0 }, { sneak: true });
});

// ------------------------------------------------------------------ registry: the handlers are implemented (PLAN 5.5)
registerEffect('inspireRevolt', TURN_PLAYS.revolt);
registerEffect('killTroops', TURN_PLAYS.assassin);
registerEffect('bribeAlly', TURN_PLAYS.bribe_the_ally);
registerEffect('sneakAttack', TURN_PLAYS.sneak_attack_sea);
registerEffect('forcedMarch', TURN_PLAYS.forced_march);
registerEffect('banditsOnTheRoad', TURN_PLAYS.bandits_on_the_road);
registerEffect('spyInTheTent', TURN_PLAYS.spy_in_the_tent);
registerEffect('elephantPanic', responseWindows.elephantPanic);
registerEffect('blockRevolt', responseWindows.revoltResponse);
registerEffect('gainPrestige', { onDraw: 'turn.js drawCard (18.k)' });
registerEffect('gainResources', { onDraw: 'turn.js drawCard (20.g)' });
registerEffect('freeBuild', { onDraw: 'turn.js drawCard / RESOURCE_BUILD / USE_SAVED_RESOURCE (20.f)' });
export { TURN_PLAYS, rivals };
