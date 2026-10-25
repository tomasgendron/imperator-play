// M2: battles and the Senate Decree (PLAN 6, 16.4, 16.5; rules 12.g-12.l, 15.b-15.h, 16.n, 17.g-17.y, 18.b, 18.c, 18.i, 18.y, 19.b-19.d, 19.k, 19.u).
// A battle lives in `state.battle` while it runs; every decision is a pending frame with its `options` listed (AI-ready, M4):
//   chooseBorrow -> chooseBattleCards (attacker) -> choosePerk (Scipio) -> responseWindow defenceAnnounced (Horn) -> roll loyalty (Roma)
//   -> start (Caesar's flee) -> per round: cards -> roll battleRound -> battleContinue (continue / retreat) -> end
//   -> after: placeSurvivors, Game Card draw, extra Revolt Roll (frames pushed so they resolve in that order, Q29).
// The settle hook below drives the stages; it only acts when no frame is waiting. Turn and decree logic stay in turn.js.
import { fail, check, emit, roll, pushFrame, popFrame, topFrame, mustPlayer, playerOf, orderFrom, awardPrestige, toDiscard, onSettle } from './core.js';
import { define, defineRoll } from './actions.js';
import { registerPerk, registerEffect, registerDecree } from './registry.js';
import { changeTroops, spendAction, processRevolts, active, mustControl, provinceChoiceHandlers, turnHooks, responseWindows } from './turn.js';
import * as S from './selectors.js';

const isInt = n => Number.isInteger(n);
const nm = (data, id) => data.provincesById[id]?.name ?? id;
const BORROW = 'chooseBorrow', CARDS = 'chooseBattleCards', PERK = 'choosePerk', CONT = 'battleContinue', SURV = 'placeSurvivors';

// ------------------------------------------------------------------ selectors for attacks (pure)
const generalOf = (state, pid) => playerOf(state, pid)?.general ?? null;
const perksOn = (state, pid, id) => generalOf(state, pid)?.id === id && S.generalPerksActive(state, pid);
export const battleCardDefs = data => data.decks.game.filter(d => d.type === 'battle').map(d => d.id);
/** Battle cards in a hand: {defId: [uid]} (type "battle" only, 18.h). */
export function battleCardsHeld(state, data, pid) {
  const out = {}; const kinds = battleCardDefs(data);
  for (const c of playerOf(state, pid).hand) { const d = state.cards[c.uid].def; if (kinds.includes(d)) (out[d] ??= []).push(c.uid); }
  return out;
}
/**
 * How `from` reaches `target` for an attack: direct land/sea link (16.i), or through a NEUTRAL Carthage (16.n, 17.z; Q80).
 * Returns {ok, sea, via, code, reason}.
 */
export function attackRoute(state, data, pid, from, target) {
  if (!data.provincesById[target]) return { ok: false, code: 'UNKNOWN_PROVINCE', reason: `Unknown province "${target}".` };
  if (target === from || state.provinces[target].owner === pid) return { ok: false, code: 'OWN_TARGET', reason: `${nm(data, target)} is yours.` };
  if (target === 'carthage' && state.carthage.neutral) return { ok: false, code: 'CARTHAGE_NEUTRAL', reason: 'Neutral Carthage belongs to Roma: it cannot be attacked (16.n).', rule: '16.n' };
  const link = S.linkType(data, from, target);
  if (link) return { ok: true, sea: link === 'sea', via: null };
  const pass = data.rules.neutralCarthagePassable;
  if (state.carthage.neutral && pass.attackThrough && S.isNeighbour(data, from, 'carthage') && S.isNeighbour(data, 'carthage', target)) {
    return { ok: true, sea: S.linkType(data, from, 'carthage') === 'sea' || S.linkType(data, 'carthage', target) === 'sea', via: 'carthage' };
  }
  return { ok: false, code: 'NOT_ADJACENT', reason: `${nm(data, target)} does not border ${nm(data, from)} (16.i).`, rule: '16.i' };
}
/** Borrow limit for an attack of `troops` from `from` (19.c, 17.q). Q73 (Vidi): judged at declaration, before the attackers leave. */
export function borrowLimit(state, data, from, troops) {
  const max = S.maxBorrow(state, data, from);
  if (!max || data.rules.borrowJudgedAt === 'declaration') return max;
  const p = state.provinces[from];   // 'afterLeaving' alternative: the troops left behind must still meet the minimum
  return p.troops - troops >= S.minGarrison(state, data, from).min ? max : 0;
}
/** Every province `pid` could attack from `from` right now, with the reason when not (builder/AI helper). */
export function attackTargets(state, data, pid, from) {
  return data.provinceIds.filter(t => t !== from).map(t => ({ id: t, ...attackRoute(state, data, pid, from, t) })).filter(r => r.ok);
}

/**
 * Why `pid` cannot attack `target` from `from` right now (M8 item 4, Vidi 2026-10-22): null when the attack is legal (with
 * opts.withGeneral and, when given, opts.troops), else {code, reason, rule}. ATTACK fails with exactly this, in this order, so the
 * reason shown in the builder and the legality check cannot drift apart. Borrow, battle cards and the perk are checked by ATTACK itself.
 */
export function attackBlock(state, data, pid, from, target, opts = {}) {
  const B = (code, reason, rule = null) => ({ code, reason, rule });
  const pl = playerOf(state, pid);
  if (!data.provincesById[from]) return B('UNKNOWN_PROVINCE', `Unknown province "${from}".`);
  if (!S.controls(state, pid, from)) return B('NOT_YOURS', `${nm(data, from)} is not one of your provinces.`);
  const route = attackRoute(state, data, pid, from, target);
  if (!route.ok) return B(route.code, route.reason, route.rule ?? '16.i');
  const t = state.provinces[target]; const fp = state.provinces[from]; const withGeneral = !!opts.withGeneral;
  if (withGeneral && pl.general?.at !== from) return B('GENERAL_NOT_THERE', `Your general is not in ${nm(data, from)} (17.m).`, '17.m');
  const pompeySea = route.sea && withGeneral && perksOn(state, pid, 'pompey');
  if (!fp.road && !pompeySea) return B('NEED_ROAD', `${nm(data, from)} needs a Road to attack from it (19.b, 19.i${route.sea ? '; only Pompey with the army is exempt at sea, 15.d' : ''}).`, '19.b');
  if (t.owner === null && target !== 'roma' && target !== 'carthage' && t.native.rolled === null) return B('NATIVES_NOT_ROLLED', `Roll ${nm(data, target)}'s natives first (PREVIEW_TARGET, 17.h).`, '17.h');
  const n = opts.troops;
  if (n !== undefined && !(isInt(n) && n >= 1)) return B('BAD_TROOPS', 'troops must be a whole number >= 1 (a general is not a troop, 17.m).', '17.m');
  const max = S.maxLeaving(state, data, from); const held = fp.status === 'held';
  if (max < 1 || (n !== undefined && n > max)) return B(held ? 'ROMA_FLOOR' : 'PROVINCE_FLOOR', max < 1 ? `${nm(data, from)} has no troop to send: it must keep ${held ? data.rules.romaFloorOnHold : 1} (17.g${held ? ', 12.l' : ''}).` : `${nm(data, from)} can send at most ${max} troop(s): it keeps ${held ? data.rules.romaFloorOnHold : 1} (17.g${held ? ', 12.l' : ''}).`, '17.g');
  if (target === 'roma') {                                          // 12.h, 18.w: hold a Battlefield Imperator since an earlier turn; it is the turn's one card
    const c = pl.hand.find(x => state.cards[x.uid].def === data.rules.romaAttackNeedsCard);
    if (!c) return B('NEED_BATTLEFIELD_IMPERATOR', 'Attacking Roma needs a Battlefield Imperator card (12.h, 18.w).', '18.w');
    if (c.drawnOnTurn + data.rules.holdCardTurns > state.turn.number) return B('HOLD_A_TURN', 'The Battlefield Imperator must be held until the turn after it was drawn (18.w).', '18.w');
    if (state.turn.nonBattleCardPlayed) return B('CARD_SLOT_USED', 'You already played your one non-battle card this turn (18.h).', '18.h');
  }
  if (state.turn.actionsUsed >= data.rules.actionsPerTurn) return B('NO_ACTIONS_LEFT', `You have already used your ${data.rules.actionsPerTurn} actions this turn (17.e).`, '17.e');
  return null;
}
/** Why `from` cannot be the origin of any attack (builder, M8 item 4): null when some target can be attacked from it, else {code, reason, rule}. */
export function attackOriginBlock(state, data, pid, from) {
  if (!data.provincesById[from]) return { code: 'UNKNOWN_PROVINCE', reason: `Unknown province "${from}".`, rule: null };
  if (!S.controls(state, pid, from)) return { code: 'NOT_YOURS', reason: `${nm(data, from)} is not one of your provinces: an attack starts from one of yours.`, rule: '17.e' };
  const fp = state.provinces[from]; const max = S.maxLeaving(state, data, from); const held = fp.status === 'held';
  if (max < 1) return { code: held ? 'ROMA_FLOOR' : 'PROVINCE_FLOOR', reason: `${nm(data, from)} has no troop to send: it must keep ${held ? data.rules.romaFloorOnHold : 1} (17.g${held ? ', 12.l' : ''}).`, rule: '17.g' };
  if (state.turn.actionsUsed >= data.rules.actionsPerTurn) return { code: 'NO_ACTIONS_LEFT', reason: `You have already used your ${data.rules.actionsPerTurn} actions this turn (17.e).`, rule: '17.e' };
  let first = null;
  for (const t of data.provinceIds) {
    if (t === from || !attackRoute(state, data, pid, from, t).ok) continue;
    for (const g of [false, true]) {
      const b = attackBlock(state, data, pid, from, t, { withGeneral: g });
      if (!b || b.code === 'NATIVES_NOT_ROLLED') return null;   // unrolled natives: preview, then attack
      if (b.code !== 'GENERAL_NOT_THERE') first ??= b;
    }
  }
  return first ?? { code: 'NO_TARGET', reason: `${nm(data, from)} borders nothing it could attack (16.i).`, rule: '16.i' };
}

// ------------------------------------------------------------------ force bookkeeping
const defKind = (state, target) => {
  const p = state.provinces[target];
  if (p.owner !== null) return 'player';
  if (target === 'roma') return 'roma';
  return 'natives';                                   // natives, including an unowned Carthage (full spirit or back after Roma, 16.n)
};
export const defForce = (state, b) => (b.def.kind === 'natives' ? state.provinces[b.target].native.present ?? 0 : state.provinces[b.target].troops);
function setDefForce(state, b, n) {
  const p = state.provinces[b.target];
  if (b.def.kind === 'natives') p.native.present = n; else p.troops = n;
}
export const attForce = b => b.att.own + b.att.borrowed;
export const wallsActive = (state, data, b) => {
  const p = state.provinces[b.target];
  if (b.target === 'roma') return true;                                                   // 12.i
  if (b.target === 'carthage' && p.owner === null) return true;                           // 16.n: Walls on all sides while no player holds it
  const side = data.rules.attackThroughNeutralWalls === 'entrySide' && b.via ? b.via : b.att.from;   // Q80 (Vidi): the real origin's side
  return p.walls.includes(side);
};
/** Dice for this round, with the reasons (17.n, 17.x, 15.c, 15.d, 19.k, 19.u, 15.h, 12.i, Q16). */
export function diceCounts(state, data, b) {
  const R = data.rules.battle; const ar = []; const dr = [];
  let a;
  if (b.mode === 'decree') { a = R.attackerDiceLand; ar.push('decree legions: up to 3 dice (16.n)'); }
  else {
    a = b.sea ? R.attackerDiceSea : R.attackerDiceLand; ar.push(b.sea ? 'sea attack: 2 dice (17.n)' : 'land attack: 3 dice');
    if (b.att.perk === 'extraDie') { a = b.sea ? R.scipioExtraDieSea : R.scipioExtraDieLand; ar.push('Scipio: extra die (15.c)'); }
    else if (b.sea && b.att.general && perksOn(state, b.att.player, 'pompey')) { a = Math.max(a, R.pompeyDiceSea); ar.push('Pompey: Master of the Sea, 3 dice (15.d)'); }
  }
  const af = attForce(b); if (a > af) { a = af; ar.push(`only ${af} troop(s) left`); }
  let d = R.defenderDice; dr.push('defender: 2 dice');
  if (wallsActive(state, data, b)) {
    if (b.round <= b.wallRollsIgnored) dr.push(`Wall bonus cancelled in rolls 1-${b.wallRollsIgnored} (${b.wallSources.join(', ')})`);
    else { d = R.defenderDiceWithWall; dr.push(b.target === 'roma' ? 'Roma: Walls on all sides (12.i)' : b.target === 'carthage' && state.provinces.carthage.owner === null ? 'Carthage: Walls on all sides (16.n)' : 'Wall on this border (19.k)'); }
  }
  const df = defForce(state, b); if (d > df) { d = df; dr.push(`only ${df} defender(s) left`); }
  return { attacker: a, defender: d, attackerReasons: ar, defenderReasons: dr };
}

// ------------------------------------------------------------------ perk and effect handlers (registry, PLAN 5.5)
// They are small pure-ish helpers called by the battle code; registering them marks them implemented.
const perkFns = {
  caesarFlee: { minEnemy: (data) => data.generalsById.caesar.perks[0].params.minEnemyTroops ?? data.rules.caesarFleeMinEnemy },
  scipioExtraDie: {}, seaMaster: {},
  fightToTheDeath: { delta: data => data.generalsById.germanicus.perks.find(p => p.handler === 'fightToTheDeath').params.delta },
  disciplinedAdvance: { rolls: data => data.generalsById.germanicus.perks.find(p => p.handler === 'disciplinedAdvance').params.wallRollsIgnored },
};
for (const [k, v] of Object.entries(perkFns)) registerPerk(k, v);
registerEffect('battleModifier', { elephants: 'all rounds', moral_boost: 'one round' });
registerEffect('callReinforcements', {});
registerEffect('enableRomaAttack', {});
registerDecree('carthageDecree', {});

// ------------------------------------------------------------------ ATTACK (PLAN 4.2 row 5)
define('ATTACK', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid);
    const block = attackBlock(state, data, pid, a.from, a.target, { withGeneral: a.withGeneral, troops: a.troops ?? null });   // M8 item 4: the UI shows the same reason
    if (block) fail(block.code, block.reason, block.rule);
    const route = attackRoute(state, data, pid, a.from, a.target);
    const t = state.provinces[a.target];
    const withGeneral = !!a.withGeneral; const n = a.troops;
    const bfi = a.target === 'roma' ? pl.hand.find(x => state.cards[x.uid].def === data.rules.romaAttackNeedsCard).uid : null;
    const bmax = borrowLimit(state, data, a.from, n);
    if (a.borrow !== undefined && a.borrow !== null) check(isInt(a.borrow) && a.borrow >= 0 && a.borrow <= bmax, 'BORROW_MAX', `You may borrow 0 to ${bmax} native troop(s) from ${nm(data, a.from)} (19.c).`, '19.c');
    const held = battleCardsHeld(state, data, pid);
    let cards = null;
    if (a.battleCards !== undefined && a.battleCards !== null) cards = pickCards(data, held, a.battleCards);
    // 15.c (Vidi 2026-10-24): Scipio's only perk is the extra die, applied by itself; the old +1 perk is gone (supersedes Q112)
    if (a.perk !== undefined && a.perk !== null) check(withGeneral && perksOn(state, pid, 'scipio') && a.perk === 'extraDie', 'BAD_PERK', a.perk === 'plusOne' ? "Scipio's +1 perk was removed (15.c, Vidi 2026-10-24): he only rolls an extra die." : 'Only Scipio, attacking with the army, has a perk to choose: extraDie (15.c).', '15.c');
    spendAction(ctx, 'attack');
    if (bfi) {
      const i = pl.hand.findIndex(x => x.uid === bfi); pl.hand.splice(i, 1); toDiscard(state, bfi); state.turn.nonBattleCardPlayed = true;
      emit(ctx, 'cardPlayed', { actor: pid, rule: '18.w', pub: { player: pid, def: data.rules.romaAttackNeedsCard, uid: bfi, source: 'attackRoma' } });
    }
    changeTroops(ctx, a.from, -n);
    const b = state.battle = {
      id: 'b' + (state.eventSeq + 1), mode: 'attack', stage: 'borrow', round: 0, target: a.target, sea: route.sea, via: route.via,
      att: { player: pid, from: a.from, own: n, borrow: a.borrow ?? null, borrowMax: bmax, borrowed: 0, borrowedDead: 0, general: withGeneral, perk: a.perk ?? null, cards, queue: [], elephants: 0, playedRound: 0 },
      def: { player: t.owner, kind: defKind(state, a.target), general: false, cards: null, queue: [], elephants: 0, playedRound: 0, hornAsked: false, startForce: 0 },
      moral: { att: 0, def: 0 }, fled: null, wallRollsIgnored: 0, wallSources: [], loyaltyDone: a.target !== 'roma', rounds: [],
    };
    b.def.general = !!(t.owner && generalOf(state, t.owner)?.at === a.target);
    emit(ctx, 'attackDeclared', { actor: pid, rule: '17.e', pub: { battleId: b.id, player: pid, from: a.from, target: a.target, troops: n, general: withGeneral, sea: route.sea, via: route.via, defender: t.owner, underGarrisonedOrigin: S.isUnderGarrisoned(state, data, a.from) } });
  },
});
function pickCards(data, held, want) {
  check(want && typeof want === 'object', 'BAD_CARDS', 'battleCards must be {cardDefId: count}.');
  const uids = [];
  for (const [def, k] of Object.entries(want)) {
    check(data.cardDefsById[def]?.type === 'battle', 'NOT_A_BATTLE_CARD', `${def} is not a battle card (18.h).`, '18.h');
    check(isInt(k) && k >= 0 && k <= (held[def]?.length ?? 0), 'NOT_IN_HAND', `You hold ${held[def]?.length ?? 0} ${def} card(s).`, '18.i');
    uids.push(...(held[def] ?? []).slice(0, k));
  }
  return uids;
}

// ------------------------------------------------------------------ frame answers
define('CHOOSE_BORROW', {
  frame: [BORROW],
  run(ctx, a) {
    const b = ctx.state.battle; const f = topFrame(ctx.state);
    check(isInt(a.count) && a.count >= 0 && a.count <= f.max, 'BORROW_MAX', `Borrow 0 to ${f.max} (19.c).`, '19.c');
    popFrame(ctx); b.att.borrow = a.count;
  },
});
define('CHOOSE_BATTLE_CARDS', {
  frame: [CARDS],
  run(ctx, a) {
    const { state, data } = ctx; const b = state.battle; const f = topFrame(state);
    const uids = pickCards(data, battleCardsHeld(state, data, f.player), a.cards ?? {});
    popFrame(ctx);
    if (f.role === 'attacker') b.att.cards = uids; else { b.def.cards = uids; }
    emit(ctx, uids.length ? 'battleCardsCommitted' : 'battleCardsSkipped', { actor: f.player, rule: '18.i', pub: { battleId: b.id, player: f.player, role: f.role, n: uids.length, reason: uids.length ? undefined : 'none' } });
  },
});
define('CHOOSE_PERK', {
  frame: [PERK],
  run(ctx, a) {
    const f = topFrame(ctx.state);
    check(f.options.includes(a.perk) && a.perk === 'extraDie', 'BAD_PERK', `Choose one of: ${f.options.join(', ')} (15.c).`, '15.c');
    popFrame(ctx); ctx.state.battle.att.perk = a.perk;
    emit(ctx, 'perkChosen', { actor: f.player, rule: '15.c', pub: { battleId: ctx.state.battle.id, player: f.player, perk: a.perk } });
  },
});
define('CALL_REINFORCEMENTS', {
  frame: ['responseWindow'],
  run(ctx, a) {
    const { state, data } = ctx; const b = state.battle; const f = topFrame(state);
    check(f.window === 'defenceAnnounced', 'WRONG_WINDOW', 'Reinforcements answer an announced attack (18.y).', '18.y');
    const src = f.sources.find(x => x.province === a.from);
    check(src, 'NOT_AN_OPTION', `${nm(data, a.from)} cannot send reinforcements (an own province bordering ${nm(data, b.target)} with a troop to spare, allied ones included, 18.y).`, '18.y');
    check(isInt(a.troops) && a.troops >= 1 && a.troops <= src.max, 'BAD_TROOPS', `Send 1 to ${src.max} troop(s) from ${nm(data, a.from)} (1 stays, 17.f).`, '18.y');
    const pl = mustPlayer(state, f.player);
    if (a.withGeneral) check(pl.general?.at === a.from, 'GENERAL_NOT_THERE', 'Your general is not there.', '18.y');
    popFrame(ctx);
    const i = pl.hand.findIndex(c => c.uid === f.card); pl.hand.splice(i, 1); toDiscard(state, f.card);
    emit(ctx, 'cardPlayed', { actor: f.player, rule: '18.y', pub: { battleId: b.id, player: f.player, def: 'horn_of_titus_pullus', uid: f.card, source: 'defenceAnnounced' } });
    changeTroops(ctx, a.from, -a.troops); changeTroops(ctx, b.target, a.troops, 'reinforcements');
    if (a.withGeneral) { pl.general.at = b.target; b.def.general = true; }
    emit(ctx, 'reinforcementsCalled', { actor: f.player, rule: '18.y', pub: { battleId: b.id, player: f.player, from: a.from, to: b.target, troops: a.troops, general: !!a.withGeneral } });
  },
});
define('PASS', {
  frame: ['responseWindow'],
  run(ctx) {
    const f = topFrame(ctx.state); popFrame(ctx);
    emit(ctx, 'responsePassed', { actor: f.player, rule: responseWindows[f.window]?.rule ?? '18.y', pub: { player: f.player, window: f.window } });
    responseWindows[f.window]?.pass?.(ctx, f);
  },
});
define('BATTLE_CONTINUE', { frame: [CONT], run(ctx) { popFrame(ctx); const b = ctx.state.battle; b.round += 1; b.stage = 'roundCards'; } });
define('BATTLE_RETREAT', {
  frame: [CONT],
  run(ctx) { popFrame(ctx); emit(ctx, 'retreated', { rule: '17.k', pub: { battleId: ctx.state.battle.id, player: ctx.state.battle.att.player, to: ctx.state.battle.att.from, own: ctx.state.battle.att.own } }); finish(ctx, 'retreat'); },
});
define('PLACE_SURVIVORS', {
  frame: [SURV],
  run(ctx, a) {
    const f = topFrame(ctx.state);
    check(isInt(a.back) && a.back >= 0 && a.back <= f.maxBack, 'BAD_TROOPS', `Send 0 to ${f.maxBack} survivor(s) back to ${nm(ctx.data, f.origin)} (17.y, Q59).`, '17.y');
    check(a.generalBack === undefined || typeof a.generalBack === 'boolean', 'BAD_ACTION', 'generalBack must be true or false.');
    check(!a.generalBack || f.general, 'GENERAL_NOT_THERE', 'Your general did not take part in this attack (17.y).', '17.y');
    popFrame(ctx);
    if (a.back) { changeTroops(ctx, f.target, -a.back); changeTroops(ctx, f.origin, a.back); }
    if (f.general && a.generalBack) mustPlayer(ctx.state, f.player).general.at = f.origin;   // the attacker's choice after a win (17.y)
    emit(ctx, 'survivorsPlaced', { actor: f.player, rule: '17.y', pub: { player: f.player, target: f.target, stay: f.own - a.back, back: a.back, origin: f.origin, general: !!f.general, generalBack: !!(f.general && a.generalBack) } });
  },
});
for (const t of ['APPLY_PLUS_ONE', 'BATTLE_CARDS_DONE']) define(t, { run: () => fail('OBSOLETE', `${t} no longer exists: ${t === 'APPLY_PLUS_ONE' ? "Scipio's +1 is placed automatically (15.g, 2026-10-21)" : 'battle cards are committed before round 1 (18.i, Q17)'}.`) });

// ------------------------------------------------------------------ cards in a round (18.b, 18.c, 18.i, Q70, Q71)
function playCard(ctx, b, side, uid, source) {
  const { state } = ctx; const pid = side === 'att' ? b.att.player : b.def.player; const pl = mustPlayer(state, pid);
  const i = pl.hand.findIndex(c => c.uid === uid); if (i < 0) return;
  pl.hand.splice(i, 1); toDiscard(state, uid);
  const def = state.cards[uid].def;
  if (def === 'elephants') b[side].elephants += 1; else b.moral[side] = 1;
  emit(ctx, 'cardPlayed', { actor: pid, rule: def === 'elephants' ? '18.b' : '18.c', pub: { battleId: b.id, round: b.round, player: pid, role: side === 'att' ? 'attacker' : 'defender', def, uid, source } });
}
function playSide(ctx, b, side) {
  const S2 = b[side];
  if (S2.playedRound === b.round) return; S2.playedRound = b.round;
  if (b.round === 1) {
    const cards = S2.cards ?? []; let moralDone = false;
    for (const uid of cards) {
      const def = ctx.state.cards[uid].def;
      if (def === 'moral_boost') { if (moralDone) { S2.queue.push(uid); continue; } moralDone = true; }
      playCard(ctx, b, side, uid, 'commit');
    }
  } else if (S2.queue.length) playCard(ctx, b, side, S2.queue.shift(), 'queue');
}

// ------------------------------------------------------------------ the driver
function hornWindow(state, data, b) {
  if (b.mode !== 'attack' || !b.def.player || b.def.hornAsked) return null;
  const pl = playerOf(state, b.def.player);
  const card = pl.hand.find(c => state.cards[c.uid].def === 'horn_of_titus_pullus');
  if (!card) return null;
  if (data.rules.hornOnlyUnderGarrisoned && !S.isUnderGarrisoned(state, data, b.target)) return { card: card.uid, sources: [], skip: 'notUnderGarrisoned' };   // Q85
  // 18.y (Vidi 2026-10-24): any own province bordering the attacked one, allied ones included (the defender's own troops there)
  const sources = S.provincesOf(state, b.def.player).filter(id => id !== b.target && S.isNeighbour(data, id, b.target))
    .map(id => ({ province: id, max: b.target === 'roma' ? Math.min(S.maxMove(state, data, id), S.romaRoom(state, data)) : S.maxMove(state, data, id), general: pl.general?.at === id }))
    .filter(x => x.max >= 1);
  return { card: card.uid, sources, skip: sources.length ? null : (b.target === 'roma' && S.romaRoom(state, data) < 1 ? 'romaFull' : 'noSource') };
}

function advance(ctx) {
  const { state, data } = ctx; const b = state.battle;
  switch (b.stage) {
    case 'borrow':
      if (b.att.borrow === null) {
        if (b.att.borrowMax >= 1) { pushFrame(ctx, { kind: BORROW, player: b.att.player, battleId: b.id, from: b.att.from, max: b.att.borrowMax, nativeCount: state.provinces[b.att.from].native.count, options: { min: 0, max: b.att.borrowMax } }); return; }
        b.att.borrow = 0;
      }
      b.att.borrowed = b.att.borrow;
      if (b.mode === 'attack') emit(ctx, 'borrowDecided', { actor: b.att.player, rule: '19.c', pub: { battleId: b.id, player: b.att.player, from: b.att.from, count: b.att.borrow, max: b.att.borrowMax } });
      b.stage = 'cards'; return;
    case 'cards':
      if (b.att.cards === null) {
        const held = battleCardsHeld(state, data, b.att.player);
        if (Object.keys(held).length) { pushFrame(ctx, { kind: CARDS, player: b.att.player, role: 'attacker', battleId: b.id, held: Object.fromEntries(Object.entries(held).map(([k, v]) => [k, v.length])) }); return; }
        b.att.cards = [];
      }
      b.stage = 'perk'; return;
    case 'perk':
      if (b.att.perk === null) {
        // 15.c (Vidi 2026-10-24): no choice any more: Scipio attacking with the army always rolls the extra die
        if (b.att.general && perksOn(state, b.att.player, 'scipio')) { b.att.perk = 'extraDie'; emit(ctx, 'perkChosen', { actor: b.att.player, rule: '15.c', pub: { battleId: b.id, player: b.att.player, perk: 'extraDie', auto: true } }); }
        else b.att.perk = 'none';
      }
      b.stage = 'horn'; return;
    case 'horn': {
      const w = hornWindow(state, data, b); b.def.hornAsked = true;
      // a defender who holds the Horn but cannot use it is told why in the log (Vidi 2026-10-24)
      if (w?.skip) emit(ctx, 'hornSkipped', { actor: b.def.player, rule: '18.y', pub: { battleId: b.id, player: b.def.player, target: b.target }, priv: { reason: w.skip, card: w.card }, privTo: [b.def.player] });   // private: the hand is hidden (Q95)
      else if (w) pushFrame(ctx, { kind: 'responseWindow', window: 'defenceAnnounced', player: b.def.player, battleId: b.id, target: b.target, card: w.card, sources: w.sources, options: ['CALL_REINFORCEMENTS', 'PASS'] });
      b.stage = 'loyalty'; return;
    }
    case 'loyalty':
      if (!b.loyaltyDone) { pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.loyalty, purpose: 'loyalty', player: b.att.player, battleId: b.id }); return; }
      b.stage = 'start'; return;
    case 'start': startBattle(ctx, b); b.stage = 'roundCards'; return;
    case 'roundCards':
      if (b.mode === 'attack') {
        playSide(ctx, b, 'att');
        if (b.round === 1 && b.def.cards === null) {
          if (b.def.player && Object.keys(battleCardsHeld(state, data, b.def.player)).length) {
            pushFrame(ctx, { kind: CARDS, player: b.def.player, role: 'defender', battleId: b.id, held: Object.fromEntries(Object.entries(battleCardsHeld(state, data, b.def.player)).map(([k, v]) => [k, v.length])), attackerPlayed: b.att.elephants + b.moral.att });
            return;
          }
          b.def.cards = [];
          emit(ctx, 'battleCardsSkipped', { rule: '18.i', pub: { battleId: b.id, role: 'defender', reason: b.def.player ? 'none' : 'natives' } });
        }
        playSide(ctx, b, 'def');
      }
      b.stage = 'roll'; return;
    case 'roll':
      if (defForce(state, b) === 0) { finish(ctx, 'conquered'); return; }
      pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.battle, purpose: 'battleRound', player: b.att.player, battleId: b.id, round: b.round, dice: diceCounts(state, data, b) });
      return;
    case 'continue':
      if (b.mode === 'decree') { b.round += 1; b.stage = 'roundCards'; return; }        // legions cannot withdraw (16.n)
      pushFrame(ctx, { kind: CONT, player: b.att.player, battleId: b.id, round: b.round, attacker: attForce(b), defender: defForce(state, b), options: ['BATTLE_CONTINUE', 'BATTLE_RETREAT'] });
      return;
    default: throw new Error('battle: unknown stage ' + b.stage);
  }
}
onSettle(ctx => {
  const { state } = ctx;
  if (state.phase !== 'turn' || state.pending.length) return false;
  if (state.battle) { advance(ctx); return true; }
  if (state.decree) { advanceDecree(ctx); return true; }
  return false;
});

function startBattle(ctx, b) {
  const { state, data } = ctx;
  b.round = 1;
  if (b.mode === 'attack') {
    const cat = mustPlayer(state, b.att.player).items.catapult;
    if (cat) { b.wallRollsIgnored += cat * data.rules.catapult.wallRollsIgnoredEach; b.wallSources.push(`${cat} Catapult${cat > 1 ? 's' : ''} (19.u)`); }
    if (b.att.general && perksOn(state, b.att.player, 'germanicus')) { b.wallRollsIgnored += perkFns.disciplinedAdvance.rolls(data); b.wallSources.push('Germanicus: Disciplined Advance (15.h)'); }
    // Caesar (15.b, Q19, Q68): one ENEMY troop flees, never from a force of 1
    const min = perkFns.caesarFlee.minEnemy(data);
    if (b.att.general && perksOn(state, b.att.player, 'caesar')) {
      if (defForce(state, b) >= min) { setDefForce(state, b, defForce(state, b) - 1); b.fled = { side: 'def', from: 'own' }; emit(ctx, 'enemyFled', { actor: b.att.player, rule: '15.b', pub: { battleId: b.id, side: 'defender', owner: b.def.player, province: b.target, n: 1 } }); }
      else emit(ctx, 'generalPerkTriggered', { actor: b.att.player, rule: '15.b', pub: { battleId: b.id, general: 'caesar', effect: 'none', reason: 'the enemy has a lone troop: no one flees' } });
    } else if (b.def.general && b.def.player && perksOn(state, b.def.player, 'caesar')) {
      if (attForce(b) >= min) {
        // Q88 (Vidi 2026-10-21): a borrowed troop flees first, an own one only when no borrowed troop is left. A fled borrowed troop is
        // not a death (no native-count drop, no extra Revolt Roll): it stays home if Caesar loses and joins him if he wins.
        // ('ownFirst', the old default: own first, but never the last own troop while borrowed ones fight.)
        const fromOwn = data.rules.caesarFledFromAttacker === 'ownFirst' ? (b.att.own >= 2 || b.att.borrowed < 1) : b.att.borrowed < 1;
        if (fromOwn) b.att.own -= 1; else b.att.borrowed -= 1;
        b.fled = { side: 'att', from: fromOwn ? 'own' : 'borrowed' };
        emit(ctx, 'enemyFled', { actor: b.def.player, rule: '15.b', pub: { battleId: b.id, side: 'attacker', owner: b.att.player, province: b.att.from, n: 1 } });
      } else emit(ctx, 'generalPerkTriggered', { actor: b.def.player, rule: '15.b', pub: { battleId: b.id, general: 'caesar', effect: 'none', reason: 'the enemy has a lone troop: no one flees' } });
    }
  }
  b.def.startForce = defForce(state, b);
  emit(ctx, 'battleStarted', { actor: b.att.player, rule: '17.e', pub: { battleId: b.id, mode: b.mode, target: b.target, attacker: attForce(b), borrowed: b.att.borrowed, defender: b.def.startForce, wallRollsIgnored: b.wallRollsIgnored, perk: b.att.perk } });
}

// ------------------------------------------------------------------ rolls: loyalty and a battle round
defineRoll('loyalty', (ctx, f) => {
  const { state, data } = ctx; const b = state.battle;
  const v = roll(ctx, data.rules.dice.loyalty, 'loyalty', f.player);
  popFrame(ctx); b.loyaltyDone = true;
  const force = attForce(b);
  const n = Math.min(v, data.rules.romaLoyaltyMaxDefect, force);
  const own = Math.min(n, b.att.own); const borrowed = n - own;   // own troops first, then borrowed (12.j, Q66)
  b.att.own -= own; b.att.borrowed -= borrowed;
  if (borrowed) loseBorrowed(ctx, b, borrowed, 'loyalty');
  changeTroops(ctx, 'roma', n, 'loyalty');                         // they join Roma (cap 20, 12.k)
  emit(ctx, 'loyaltyDefected', { actor: f.player, rule: '12.j', pub: { battleId: b.id, d6: v, defected: n, own, borrowed, wholeArmy: n >= force } });
  if (n >= force) finish(ctx, 'loyaltyWipe');
});
function loseBorrowed(ctx, b, k, why) {
  const p = ctx.state.provinces[b.att.from]; const from = p.native.count;
  b.att.borrowedDead += k;
  p.native.count = Math.max(0, from - k); if (p.native.present !== null) p.native.present = Math.min(p.native.present, p.native.count);
  if (p.native.rolled !== null) p.native.rolled = Math.min(p.native.rolled, p.native.count);
  emit(ctx, 'nativesReduced', { rule: '17.u', pub: { battleId: b.id, province: b.att.from, from, to: p.native.count, reason: why } });
}
defineRoll('battleRound', (ctx, f) => {
  const { state, data } = ctx; const b = state.battle;
  const dc = diceCounts(state, data, b);
  const raw = { att: [], def: [] };
  for (let i = 0; i < dc.attacker; i++) raw.att.push(roll(ctx, data.rules.dice.battle, 'battleAttack', b.att.player));
  for (let i = 0; i < dc.defender; i++) raw.def.push(roll(ctx, data.rules.dice.battle, 'battleDefence', b.def.player));
  popFrame(ctx);
  emit(ctx, 'battleRoundRolled', { actor: b.att.player, rule: '17.e', pub: { battleId: b.id, round: b.round, attacker: { player: b.att.player, dice: [...raw.att], reasons: dc.attackerReasons }, defender: { player: b.def.player, dice: [...raw.def], reasons: dc.defenderReasons } } });
  const adj = []; const fin = { att: [...raw.att], def: [...raw.def] };
  for (const side of ['att', 'def']) {
    const bonus = b[side].elephants + b.moral[side];
    if (bonus) fin[side] = fin[side].map(v => v + bonus);
    // v22 (Vidi's bug, 2026-10-24): one labelled adjustment per card, so the Battle panel never shows "undefined: +2"
    const who = side === 'att' ? 'attacker' : 'defender';
    if (b[side].elephants) adj.push({ side: who, source: 'elephants', delta: b[side].elephants, appliesTo: 'all', why: `Elephants!${b[side].elephants > 1 ? ' x' + b[side].elephants : ''} (18.b)` });
    if (b.moral[side]) adj.push({ side: who, source: 'moral_boost', delta: b.moral[side], appliesTo: 'all', why: 'Moral boost! this roll (18.c)' });
  }
  if (b.mode === 'attack') {
    // Q113 (Vidi 2026-10-22): only once his side has LOST troops in this battle (killed in an earlier roll) and is down to exactly 1;
    // an army that started at 1 never triggers it
    const delta = perkFns.fightToTheDeath.delta(data); const lost = side => b.rounds.some(r => r[side + 'Loss'] > 0);
    if (b.att.general && perksOn(state, b.att.player, 'germanicus') && attForce(b) === 1 && fin.att.length === 1 && lost('attacker')) { fin.att[0] += delta; adj.push({ side: 'attacker', source: 'germanicus', delta, why: 'Fight to the Death (15.h)' }); }
    if (b.def.general && b.def.player && perksOn(state, b.def.player, 'germanicus') && defForce(state, b) === 1 && fin.def.length === 1 && lost('defender')) { fin.def[0] += delta; adj.push({ side: 'defender', source: 'germanicus', delta, why: 'Fight to the Death (15.h)' }); }
  }
  if (adj.length) emit(ctx, 'battleDiceAdjusted', { rule: '15.g, 18.b, 18.c', pub: { battleId: b.id, round: b.round, adjustments: adj, attackerFinal: [...fin.att], defenderFinal: [...fin.def] } });
  const A = [...fin.att].sort((x, y) => y - x), D = [...fin.def].sort((x, y) => y - x);
  const pairs = []; let aLoss = 0, dLoss = 0;
  for (let k = 0; k < Math.min(A.length, D.length); k++) {
    const w = A[k] > D[k] ? 'attacker' : 'defender';                                   // ties go to the defender (Q16)
    pairs.push({ a: A[k], d: D[k], winner: w }); if (w === 'attacker') dLoss++; else aLoss++;
  }
  const bl = Math.min(aLoss, b.att.borrowed); b.att.borrowed -= bl; b.att.own -= aLoss - bl;   // borrowed troops die first (19.d)
  if (aLoss) emit(ctx, 'casualtiesApplied', { rule: '19.d', pub: { battleId: b.id, round: b.round, borrowed: bl, own: aLoss - bl } });
  if (bl) loseBorrowed(ctx, b, bl, 'battle');
  setDefForce(state, b, defForce(state, b) - dLoss);
  b.moral = { att: 0, def: 0 };
  let af = attForce(b), df = defForce(state, b);
  b.rounds.push({ round: b.round, attackerDice: raw.att, defenderDice: raw.def, attackerFinal: fin.att, defenderFinal: fin.def, attackerLoss: aLoss, defenderLoss: dLoss });
  emit(ctx, 'battleRoundResolved', { rule: '17.e', pub: { battleId: b.id, round: b.round, attackerFinal: A, defenderFinal: D, pairs, attackerLoss: aLoss, defenderLoss: dLoss, attackerTroopsAfter: af, defenderTroopsAfter: df } });
  if (af === 0 && df === 0) {                                                          // Q20: the defender's last troop survives
    setDefForce(state, b, 1); df = 1;
    emit(ctx, 'bothSidesZero', { rule: 'Q20', pub: { battleId: b.id, defenderKeeps: 1 } });
  }
  if (df === 0) finish(ctx, 'conquered');
  else if (af === 0) finish(ctx, 'defended');
  else b.stage = 'continue';
});

// ------------------------------------------------------------------ end of a battle (PLAN 4.4 conquest, Q28, Q29)
const healAt = state => state.turn.number + state.players.filter(p => !p.out).length;   // one full round (17.v)
function finish(ctx, outcome) {
  const { state, data } = ctx; const b = state.battle;
  if (b.mode === 'decree') { finishDecree(ctx, b, outcome); return; }
  const A = b.att.player; const D = b.def.player; const t = b.target; const tp = state.provinces[t];
  // Caesar's fled troop (15.b): joins the winning Caesar army, otherwise returns home
  if (b.fled) {
    const caesarSide = b.fled.side === 'def' ? 'att' : 'def';
    const caesarWon = caesarSide === 'att' ? outcome === 'conquered' : outcome !== 'conquered';
    if (caesarWon) {
      if (caesarSide === 'att') b.att.own += 1; else changeTroops(ctx, t, 1, 'fledTroop');
      emit(ctx, 'fledTroopJoined', { rule: '15.b', pub: { battleId: b.id, to: caesarSide === 'att' ? A : D, province: caesarSide === 'att' ? t : t } });
    } else {
      if (b.fled.side === 'def') setDefForce(state, b, defForce(state, b) + 1);
      else if (b.fled.from === 'own') changeTroops(ctx, b.att.from, 1, 'fledTroop');
      emit(ctx, 'fledTroopReturned', { rule: '15.b', pub: { battleId: b.id, owner: b.fled.side === 'def' ? D : A, province: b.fled.side === 'def' ? t : b.att.from } });
    }
  }
  emit(ctx, 'battleEnded', { actor: A, rule: '17.e', pub: { battleId: b.id, outcome, winner: outcome === 'conquered' ? A : outcome === 'retreat' ? null : (D ?? 'defender'), rounds: b.rounds.length, attackerLeft: b.att.own, borrowedDead: b.att.borrowedDead, target: t, from: b.att.from, defender: D ?? null, sea: !!b.sea, defenderLeft: outcome === 'conquered' ? 0 : defForce(state, b) } });
  const after = [];   // frames, pushed bottom-first: extra Revolt Roll, then card, then survivors on top (Q29)
  let exclude = null;
  if (outcome === 'conquered') { exclude = t; conquer(ctx, b, after); }
  else {
    if (outcome === 'retreat' && b.att.own) changeTroops(ctx, b.att.from, b.att.own);
    if (b.def.kind === 'natives' && tp.native.present < tp.native.count) tp.healAtTurn = healAt(state);   // depleted natives heal after a full round (17.v)
    if (outcome === 'defended' && D && data.rules.battleWinCard.defender) after.push({ kind: 'draw', deck: 'game', reason: 'battleWon', player: D });
  }
  if (state.phase !== 'turn') { state.battle = null; return; }
  if (b.att.borrowedDead > 0) after.unshift(extraRevoltFrame(ctx, A, exclude));
  state.battle = null;
  for (const f of after) if (f) pushFrame(ctx, f);
}
function extraRevoltFrame(ctx, pid, exclude) {
  const { state, data } = ctx;
  emit(ctx, 'extraRevoltRollTriggered', { actor: pid, rule: '19.d', pub: { player: pid, exclude } });
  if (!S.revoltEligible(state, data, pid)) { emit(ctx, 'revoltRollSkipped', { actor: pid, rule: '19.h', pub: { player: pid, conquered: S.conqueredOf(state, pid).length, reason: 'fewer than 2 conquered provinces', extra: true } }); return null; }
  return { kind: 'roll', die: 'd' + data.rules.dice.revoltRoll, purpose: 'extraRevoltRoll', player: pid, exclude };
}
defineRoll('extraRevoltRoll', (ctx, f) => {
  const { state, data } = ctx; const pid = f.player;
  const v = roll(ctx, data.rules.dice.revoltRoll, 'extraRevoltRoll', pid);
  popFrame(ctx);
  const match = S.revoltCandidates(state, pid).filter(id => state.provinces[id].number === v && id !== f.exclude);   // just conquered: exempt (19.d, 19.h)
  const hit = match.filter(id => S.canRevolt(state, data, id));                                                    // 10+ troops: exempt (17.c)
  emit(ctx, 'revoltRoll', { actor: pid, rule: '19.d', pub: { player: pid, value: v, provinces: hit, extra: true, exempt: f.exclude } });
  for (const id of match.filter(m => !hit.includes(m))) emit(ctx, 'revoltImmune', { actor: pid, rule: '17.c', pub: { player: pid, province: id, troops: state.provinces[id].troops, reason: `${data.rules.revoltImmuneAtTroops} or more troops never revolt` } });
  processRevolts(ctx, pid, hit, { source: 'extraRevoltRoll' });
});

function conquer(ctx, b, after) {
  const { state, data } = ctx; const A = b.att.player; const t = b.target; const p = state.provinces[t];
  const prev = p.owner; const wasStart = p.status === 'starting'; const pl = mustPlayer(state, A);
  let own = b.att.own; let gain = data.rules.prestige.conquest; let back = 0;
  if (prev) {                                                     // the previous owner's general escapes (Q86)
    const g = generalOf(state, prev);
    if (g?.at === t) {
      const cand = data.rules.defendingGeneralOnCapture === 'nearestOwned' ? S.nearestOwned(state, data, prev, t) : [];
      g.at = cand[0] ?? null;
      emit(ctx, 'generalEscaped', { actor: prev, rule: 'Q86', pub: { player: prev, from: t, to: g.at } });
    }
    if (wasStart) { const pp = mustPlayer(state, prev); if (pp.startIncome) { pp.startIncome = false; emit(ctx, 'startIncomeLost', { actor: prev, rule: '20.k', pub: { player: prev, province: t } }); } }
  }
  if (t === 'roma') {                                             // 12.g, 12.l: held, fresh 10, Gold pile reset, +3
    gain = data.rules.prestige.roma;
    p.troops = data.rules.romaStartTroops;
    const stay = Math.min(own, data.rules.romaMaxTroops - p.troops); back = own - stay; p.troops += stay; own = stay;
    Object.assign(p, { owner: A, status: 'held', startingOf: null, healAtTurn: null });
    Object.assign(state.roma, { holder: A, heldSinceTurn: state.turn.number, goldPile: 0 });
    if (back) changeTroops(ctx, b.att.from, back, 'romaFull');
    emit(ctx, 'romaHeld', { actor: A, rule: '12.l', pub: { player: A, previous: prev, troops: p.troops, survivorsInRoma: stay, sentBack: back } });
  } else {
    if (t === 'carthage' && prev === null) {                       // 16.n: +2, salt the earth
      gain = data.rules.prestige.carthage; state.carthage.defeated = true;
      const n = data.rules.carthageNative[1]; p.native = { rolled: n, count: n, present: n };
      emit(ctx, 'carthageDefeated', { actor: A, rule: '16.n', pub: { player: A } });
    }
    if (p.native.count !== null) p.native.present = p.native.count;   // natives stay / refill (17.f, 17.w)
    Object.assign(p, { owner: A, status: 'conquered', startingOf: null, troops: own, healAtTurn: null });
  }
  if (b.att.general) pl.general.at = t;
  const min = S.minGarrison(state, data, t).min;
  emit(ctx, 'provinceConquered', { actor: A, rule: '17.y', pub: { battleId: b.id, player: A, province: t, from: prev, troops: p.troops, min, underGarrisoned: t !== 'roma' && p.troops < min } });
  awardPrestige(ctx, A, gain, t === 'roma' ? 'roma' : t === 'carthage' && gain === data.rules.prestige.carthage ? 'carthage' : 'conquest', t === 'roma' ? '12.g' : '12.f');
  if (state.phase !== 'turn') return;
  if (prev) { emit(ctx, 'provinceLost', { actor: prev, rule: '12.f', pub: { player: prev, province: t, to: A } }); awardPrestige(ctx, prev, -data.rules.prestige.loss, 'provinceLost', '12.f'); if (state.phase !== 'turn') return; }
  if (t === 'roma' && state.carthage.neutral) {                   // Carthage is back (12.g, 16.n)
    const n = data.rules.carthageBackTroops; Object.assign(state.carthage, { neutral: false, defeated: false, decreeLegionsLost: 0 });
    state.provinces.carthage.native = { rolled: n, count: n, present: n }; state.provinces.carthage.healAtTurn = null;
    emit(ctx, 'carthageBack', { rule: '16.n', pub: { troops: n } });
  }
  // after-frames (pushed in order; the last is on top): card draw, then survivors
  if (data.rules.battleWinCard.attacker) after.push({ kind: 'draw', deck: 'game', reason: 'battleWon', player: A });
  // survivors (17.y, Q59) and, if he came along, the general: he stays in the conquered province or goes back to the origin (17.y, Vidi 2026-10-22)
  const maxBack = data.rules.survivorsMayReturn ? (t === 'roma' ? own : own - 1) : 0;
  const general = !!b.att.general;
  if ((maxBack >= 1 || general) && S.controls(state, A, b.att.from)) after.push({ kind: SURV, player: A, target: t, origin: b.att.from, own, maxBack: Math.max(0, maxBack), general, options: { min: 0, max: Math.max(0, maxBack), general } });
}

// ------------------------------------------------------------------ Senate Decree (16.n, PLAN 16.5)
turnHooks.startDecree = (ctx, pid) => {
  const { state } = ctx;
  state.decree = { roller: pid, queue: orderFrom(state, pid).filter(id => !playerOf(state, id).out), legions: 0, senders: [] };
};
function sendLegion(ctx, pid, province) {
  const { state, data } = ctx;
  check(S.keepsFloor(state, data, province, 1), 'DECREE_NO_SPARE', `${nm(data, province)} must keep 1 troop (17.f).`, '16.n');
  changeTroops(ctx, province, -1);
  state.decree.legions += 1; state.decree.senders.push(pid);
  emit(ctx, 'decreeLegionSent', { actor: pid, rule: '16.n', pub: { player: pid, from: province } });
}
provinceChoiceHandlers.decreeLegion = (ctx, f, a) => sendLegion(ctx, f.player, a.province);
function advanceDecree(ctx) {
  const { state, data } = ctx; const d = state.decree;
  if (d.queue.length) {
    const pid = d.queue.shift();
    const options = S.sparingProvinces(state, data, pid);
    if (!options.length) emit(ctx, 'decreeLegionSkipped', { actor: pid, rule: '16.n', pub: { player: pid, reason: 'no province can spare a troop' } });
    else if (options.length === 1) sendLegion(ctx, pid, options[0]);
    else pushFrame(ctx, { kind: 'chooseProvince', purpose: 'decreeLegion', player: pid, options });
    return;
  }
  if (!d.legions) { emit(ctx, 'decreeResolved', { rule: '16.n', pub: { legions: 0, result: 'noBattle' } }); state.decree = null; return; }
  const c = state.provinces.carthage;
  state.battle = {
    id: 'b' + (state.eventSeq + 1), mode: 'decree', stage: 'start', round: 0, target: 'carthage', sea: false, via: null,
    att: { player: d.roller, from: null, own: d.legions, borrow: 0, borrowMax: 0, borrowed: 0, borrowedDead: 0, general: false, perk: 'none', cards: [], queue: [], elephants: 0, playedRound: 0 },
    def: { player: null, kind: 'natives', general: false, cards: [], queue: [], elephants: 0, playedRound: 0, hornAsked: true, startForce: c.native.present },
    moral: { att: 0, def: 0 }, fled: null, wallRollsIgnored: 0, wallSources: [], loyaltyDone: true, rounds: [], senders: [...d.senders],
  };
  emit(ctx, 'decreeBattle', { actor: d.roller, rule: '16.n', pub: { legions: d.legions, senders: d.senders, carthage: c.native.present, roller: d.roller } });
}
function finishDecree(ctx, b, outcome) {
  const { state, data } = ctx; const D = data.rules.decree; const c = state.provinces.carthage;
  state.battle = null; state.decree = null;
  if (outcome === 'conquered') {                                  // Carthage destroyed: +1 per sender, survivors to Roma, neutral (16.n, 17.y)
    const survivors = b.att.own;
    const n = D.neutralCarthageTroops;
    c.native = { rolled: n, count: n, present: n }; c.healAtTurn = null;
    Object.assign(state.carthage, { neutral: true, defeated: false, decreeLegionsLost: 0 });
    emit(ctx, 'carthageNeutral', { rule: '16.n', pub: { troops: n, survivorsToRoma: survivors } });
    if (survivors) changeTroops(ctx, 'roma', survivors, 'decreeSurvivors');
    emit(ctx, 'decreeResolved', { rule: '16.n', pub: { result: 'destroyed', senders: b.senders, survivors } });
    for (const pid of b.senders) { awardPrestige(ctx, pid, D.prestigePerSender, 'decree', '16.n'); if (state.phase !== 'turn') return; }
    return;
  }
  const lost = b.def.startForce - c.native.present;
  state.carthage.decreeLegionsLost += Math.max(0, lost);
  let healed = 0;
  if (lost >= 1 && c.native.present < D.healOnlyBelow) { healed = Math.min(D.healPerDecree, D.healMax - c.native.present); c.native.present += healed; }
  if (healed) emit(ctx, 'carthageHealed', { rule: '16.n', pub: { healed, troops: c.native.present } });
  emit(ctx, 'decreeResolved', { rule: '16.n', pub: { result: 'held', lost, carthage: c.native.present } });
}

// ------------------------------------------------------------------ attack preview (M6, for the Attack Builder; pure, no mutation)
/**
 * What an ATTACK `a` ({playerId, from, target, troops, withGeneral, borrow}) would face, before it is declared: the route, the Wall,
 * the borrow limit and every general perk that will (or will not) apply in that battle, for both sides (15.b-15.h, 15.f, 18.o, 19.k, 19.u).
 * Returns {ok, reason, sea, via, wall, wallRollsIgnored, wallSources, borrowMax, defender, perks: [{side, general, applies, text, rule}]}.
 */
export function attackPreview(state, data, a) {
  const pid = a.playerId ?? state.turn?.activePlayerId; const pl = playerOf(state, pid);
  const route = attackRoute(state, data, pid, a.from, a.target);
  if (!route.ok) return { ok: false, reason: route.reason, perks: [] };
  const t = state.provinces[a.target];
  const withGeneral = !!a.withGeneral && pl.general?.at === a.from;
  const b = { target: a.target, via: route.via, att: { from: a.from }, def: { kind: defKind(state, a.target) } };
  const wall = wallsActive(state, data, b);
  const wallSources = []; let wallRollsIgnored = 0;
  const cat = pl.items?.catapult ?? 0;
  if (cat) { wallRollsIgnored += cat * data.rules.catapult.wallRollsIgnoredEach; wallSources.push(`${cat} Catapult${cat > 1 ? 's' : ''} (19.u)`); }
  const gName = id => data.generalsById[id]?.name ?? id;
  const perks = [];
  const myGen = pl.general?.id ?? null;
  const defForceNow = t.owner === null && a.target !== 'roma' ? (t.native.present ?? t.native.count ?? 0) : t.troops;
  const attForceNow = (a.troops ?? 0) + (a.borrow ?? 0);
  const minFlee = perkFns.caesarFlee.minEnemy(data);
  if (myGen) {
    if (!withGeneral) perks.push({ side: 'attacker', general: myGen, applies: false, text: `${gName(myGen)} stays ${pl.general?.at ? 'in ' + nm(data, pl.general.at) : 'away'}: no general perks in this battle (15.f).`, rule: '15.f' });
    else if (!S.generalPerksActive(state, pid)) perks.push({ side: 'attacker', general: myGen, applies: false, text: `${gName(myGen)} is recalled to Rome: no perks (18.o).`, rule: '18.o' });
    else if (myGen === 'caesar') perks.push(defForceNow >= minFlee
      ? { side: 'attacker', general: 'caesar', applies: true, text: 'Caesar: 1 enemy troop flees into the hills at the start; if you win, it joins you (+1 troop) (15.b).', rule: '15.b' }
      : { side: 'attacker', general: 'caesar', applies: false, text: 'Caesar: the enemy has a lone troop, so no one flees (15.b).', rule: '15.b' });
    else if (myGen === 'scipio') perks.push({ side: 'attacker', general: 'scipio', applies: true, text: `Scipio: an extra attack die (${route.sea ? '3' : '4'} dice v 2) (15.c).`, rule: '15.c' });
    else if (myGen === 'pompey') {
      if (route.sea) perks.push({ side: 'attacker', general: 'pompey', applies: true, text: 'Pompey, Master of the Sea: 3 dice v 2 by sea, and no Road needed for a sea attack (15.d).', rule: '15.d' });
      else perks.push({ side: 'attacker', general: 'pompey', applies: false, text: 'Pompey: his sea perk only works at sea; this is a land attack (15.d). (His garrison -1 always applies.)', rule: '15.d' });
    } else if (myGen === 'germanicus') {
      perks.push({ side: 'attacker', general: 'germanicus', applies: true, text: 'Germanicus, Fight to the Death: +2 on your last die once you have lost troops in this battle and are down to 1 (15.h, Q113).', rule: '15.h' });
      perks.push(wall
        ? { side: 'attacker', general: 'germanicus', applies: true, text: `Germanicus, Disciplined Advance: the defender's Wall is ignored for the first ${perkFns.disciplinedAdvance.rolls(data)} rolls (15.h).`, rule: '15.h' }
        : { side: 'attacker', general: 'germanicus', applies: false, text: 'Germanicus, Disciplined Advance: no Wall to ignore here (15.h).', rule: '15.h' });
      if (wall) { wallRollsIgnored += perkFns.disciplinedAdvance.rolls(data); wallSources.push('Germanicus: Disciplined Advance (15.h)'); }
    }
  }
  if (t.owner) {
    const dg = playerOf(state, t.owner)?.general;
    if (dg?.at === a.target && S.generalPerksActive(state, t.owner)) {
      if (dg.id === 'caesar' && !(withGeneral && myGen === 'caesar')) perks.push(attForceNow >= minFlee
        ? { side: 'defender', general: 'caesar', applies: true, text: 'Defending Caesar: 1 of your troops flees at the start (a borrowed one first); it returns if Caesar loses (15.b).', rule: '15.b' }
        : { side: 'defender', general: 'caesar', applies: false, text: 'Defending Caesar: you attack with a lone troop, so no one flees (15.b).', rule: '15.b' });
      else if (dg.id === 'germanicus') perks.push({ side: 'defender', general: 'germanicus', applies: true, text: 'Defending Germanicus, Fight to the Death: +2 on his last die once his side has lost troops in this battle and is down to 1 (15.h, Q113).', rule: '15.h' });
      else if (dg.id === 'scipio' || dg.id === 'pompey') perks.push({ side: 'defender', general: dg.id, applies: false, text: `Defending ${gName(dg.id)}: no perks when defending (${dg.id === 'scipio' ? '15.c' : '15.d'}).`, rule: dg.id === 'scipio' ? '15.c' : '15.d' });
    }
  }
  return { ok: true, sea: route.sea, via: route.via, wall, wallRollsIgnored: wall ? wallRollsIgnored : 0, wallSources: wall ? wallSources : [], borrowMax: borrowLimit(state, data, a.from, a.troops ?? 0), defender: t.owner, defenderForce: defForceNow, perks };
}
