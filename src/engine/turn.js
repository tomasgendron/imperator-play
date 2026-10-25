// The turn machine and everything that happens inside a turn (PLAN 4.1 to 4.4; rules 16, 17, 18.k, 18.t, 19, 20).
// Steps: resources -> gameRoll -> revoltRoll -> actions (17.a). The settle hook moves the turn along and stops whenever a frame
// (a dice click, a deck click, a choice) is waiting. `turn.sub` records which step has already started this turn.
import { fail, check, emit, roll, pushFrame, popFrame, topFrame, mustPlayer, playerOf, orderFrom, awardPrestige, toDiscard, drawTop, shuffleIn, onSettle } from './core.js';
import { shuffle } from './rng.js';
import { define, defineRoll } from './actions.js';
import * as S from './selectors.js';

const isInt = n => Number.isInteger(n);
const nm = (data, id) => data.provincesById[id]?.name ?? id;

// ------------------------------------------------------------------ small shared mutations
export function changeTroops(ctx, id, delta, reason = null) {
  const { state, data } = ctx;
  const p = state.provinces[id];
  if (id === 'roma' && delta > 0) {                                   // Roma's cap of 20: any troop above it is simply lost (12.k)
    const room = Math.max(0, data.rules.romaMaxTroops - p.troops);
    if (delta > room) { emit(ctx, 'romaCapLost', { rule: '12.k', pub: { lost: delta - room, cap: data.rules.romaMaxTroops, reason } }); delta = room; }
    if (!delta) return 0;
  }
  const wasUnder = S.isUnderGarrisoned(state, data, id);
  p.troops += delta;
  const nowUnder = S.isUnderGarrisoned(state, data, id);
  if (wasUnder !== nowUnder) emit(ctx, 'garrisonStatusChanged', { rule: '17.q', pub: { province: id, own: p.troops, min: S.minGarrison(state, data, id).min, underGarrisoned: nowUnder } });
  return delta;
}
/** Player-chosen additions to Roma may not overflow its cap (Q77 default: refused, not silently lost). */
export const checkRomaRoom = (ctx, id, n) => check(id !== 'roma' || n <= S.romaRoom(ctx.state, ctx.data), 'ROMA_CAP', `Roma can hold at most ${ctx.data.rules.romaMaxTroops} troops; it has room for ${S.romaRoom(ctx.state, ctx.data)} more (12.k).`, '12.k');

function buildPiece(ctx, pid, piece, province, facing, { free }) {
  const { state, data } = ctx;
  check(S.controls(state, pid, province), 'NOT_YOURS', `${nm(data, province)} is not one of your provinces.`, '19.f');
  const p = state.provinces[province];
  if (piece === 'road') {
    check(!p.road, 'ROAD_EXISTS', `${nm(data, province)} already has a Road.`, '19.f');
    p.road = true;
    emit(ctx, 'roadBuilt', { actor: pid, rule: '19.f', pub: { player: pid, province, free } });
  } else {
    check(facing && S.isNeighbour(data, province, facing), 'BAD_FACING', 'A Wall faces an adjacent province (land or sea).', '19.k');
    check(!p.walls.includes(facing), 'WALL_EXISTS', `${nm(data, province)} already has a Wall facing ${nm(data, facing)} (19.l: one per side).`, '19.l');
    p.walls.push(facing); p.walls.sort();
    emit(ctx, 'wallBuilt', { actor: pid, rule: '19.k', pub: { player: pid, province, facing, free } });
  }
}

export function spendAction(ctx, what) {
  const { state, data } = ctx; const t = state.turn;
  check(t.actionsUsed < data.rules.actionsPerTurn, 'NO_ACTIONS_LEFT', `You have already used your ${data.rules.actionsPerTurn} actions this turn.`, '17.e');
  t.actionsUsed += 1;
  emit(ctx, 'actionSpent', { rule: '17.e', pub: { player: t.activePlayerId, action: what, used: t.actionsUsed, of: data.rules.actionsPerTurn } });
}

// ------------------------------------------------------------------ start of a turn: Resources step (17.d, 20.b, 20.c)
function beginResources(ctx) {
  const { state, data } = ctx; const t = state.turn; const pid = t.activePlayerId;
  for (const id of Object.keys(state.provinces).sort()) {    // natives heal when their timer is up (17.v, Q27)
    const p = state.provinces[id];
    if (p.healAtTurn !== null && t.number >= p.healAtTurn) {
      p.healAtTurn = null;
      if (p.native.count !== null && p.native.present !== p.native.count) { p.native.present = p.native.count; emit(ctx, 'nativesHealed', { rule: '17.v', pub: { province: id, present: p.native.count } }); }
    }
  }
  t.bonusTroopsGained = [];
  for (const id of S.provincesOf(state, pid)) {
    if (!S.earnsBonusTroop(state, data, id)) continue;
    changeTroops(ctx, id, 1);
    t.bonusTroopsGained.push({ province: id, n: 1 });
    emit(ctx, 'bonusTroopsGranted', { actor: pid, rule: '20.b', pub: { player: pid, province: id, n: 1 } });
  }
  const pl = mustPlayer(state, pid);
  if (pl.startIncome && pl.startProvince && state.provinces[pl.startProvince].status === 'starting' && state.provinces[pl.startProvince].owner === pid) {
    pl.gold += data.rules.startProvinceGold;                           // +1 Gold while the start province is held and never defeated (17.d, 20.k)
    emit(ctx, 'startProvinceGold', { actor: pid, rule: '20.k', pub: { player: pid, province: pl.startProvince, gold: data.rules.startProvinceGold } });
  }
  pushFrame(ctx, { kind: 'draw', deck: 'resource', reason: 'resourcesStep', player: pid });
}

// ------------------------------------------------------------------ drawing cards (PLAN 4.1 row 2)
function drawCard(ctx, f) {
  const { state, data } = ctx; const pid = f.player; const pl = mustPlayer(state, pid);
  popFrame(ctx);
  let uid = drawTop(ctx, f.deck);                                     // an empty pile is rebuilt from its discard pile first (18.l)
  if (uid === null) { emit(ctx, 'deckEmpty', { actor: pid, rule: '18.l, Q46', pub: { deck: f.deck, player: pid } }); return; }
  // max 1 held: a 2nd Garrison Requirement, Battlefield Imperator or Horn of Titus Pullus is shuffled back and the player draws again (18.t, 18.w)
  const blockedFor = u => data.rules.uniqueHeldCards.includes(state.cards[u].def) && S.holdsUnique(state, pid, state.cards[u].def);
  for (let guard = 0; f.deck === 'game' && blockedFor(uid); guard++) {
    const blocked = state.cards[uid].def;
    shuffleIn(state, uid);
    emit(ctx, 'cardReshuffled', { actor: pid, rule: { garrison_requirement: '18.t', battlefield_imperator: '18.w', horn_of_titus_pullus: '18.y' }[blocked] ?? '18.l', pub: { player: pid, def: blocked, reason: 'max 1 held; shuffled back, drawing again' } });
    if (!state.decks.game.some(u => !blockedFor(u))) {
      // Q78 (Vidi 2026-10-21): only unholdable cards left in the draw pile -> shuffle the discard pile, draw a valid card from it,
      // and put the rest of that shuffled discard pile UNDERNEATH the cards left in the draw pile (18.l)
      const pile = shuffle(state.rng, state.discards.game); state.discards.game = [];
      const i = pile.findIndex(u => !blockedFor(u));
      state.decks.game.push(...(i < 0 ? pile : [...pile.slice(0, i), ...pile.slice(i + 1)]));
      if (i < 0) { emit(ctx, 'deckEmpty', { actor: pid, rule: '18.t, Q78', pub: { deck: 'game', player: pid, reason: 'only cards you may not hold are left' } }); return; }
      emit(ctx, 'discardShuffledUnder', { actor: pid, rule: '18.l, Q78', pub: { deck: 'game', player: pid, underneath: pile.length - 1 } });
      uid = pile[i]; break;
    }
    if (guard > 200) { emit(ctx, 'deckEmpty', { actor: pid, rule: '18.t, Q78', pub: { deck: 'game', player: pid, reason: 'guard' } }); return; }
    uid = drawTop(ctx, 'game');
  }
  const defId = state.cards[uid].def; const def = data.cardDefsById[defId];
  if (f.deck === 'resource') {
    const e = def.effect;
    emit(ctx, 'cardDrawn', { actor: pid, rule: '20.c', pub: { player: pid, deck: 'resource', def: defId, uid, reason: f.reason } });
    if (e.handler === 'gainResources') {
      const { gold = 0, troops = 0 } = e.params;
      pl.gold += gold;
      emit(ctx, 'resourceApplied', { actor: pid, rule: '20.g', pub: { player: pid, def: defId, gold, troops } });
      toDiscard(state, uid);
      const allowed = S.provincesOf(state, pid).filter(id => id !== 'roma' || S.romaRoom(state, data) > 0);
      if (troops > 0 && allowed.length) pushFrame(ctx, { kind: 'placeTroops', player: pid, count: troops, allowed, reason: 'resourceCard' });
      else if (troops > 0) emit(ctx, 'romaCapLost', { rule: '12.k', pub: { lost: troops, cap: data.rules.romaMaxTroops, reason: 'resourceCard' } });
    } else {   // freeBuild: build now or save (20.f); the card waits in savedResources so it is never lost (13.1)
      pl.savedResources.push({ uid, drawnOnTurn: state.turn.number });
      pushFrame(ctx, { kind: 'resourceBuild', player: pid, card: uid, piece: e.params.piece });
    }
    return;
  }
  if (f.deck === 'displeased') {
    emit(ctx, 'displeasedDrawn', { actor: pid, rule: '16.m', pub: { player: pid, def: defId, uid } });
    toDiscard(state, uid);
    turnHooks.displeased(ctx, pid, defId);   // displeased.js: the Busy Little Bee! window, then the effect (18.o-18.u, 18.x)
    return;
  }
  // game deck
  if (def.onDraw === 'autoPlay') {                      // Prestige: played at once, +1, to the bottom (18.k)
    emit(ctx, 'cardPlayed', { actor: pid, rule: '18.k', pub: { player: pid, def: defId, uid, auto: true } });
    toDiscard(state, uid);
    awardPrestige(ctx, pid, def.effect.params.amount, 'prestigeCard', '18.g');
    return;
  }
  if (def.onDraw === 'autoPlayInPlay') {                // Garrison Requirement -1: in play at once, one per player (a duplicate was shuffled back above, 18.t, Q11)
    pl.inPlay.push({ uid, since: state.turn.number });
    emit(ctx, 'cardPlayed', { actor: pid, rule: '18.t', pub: { player: pid, def: defId, uid, auto: true, inPlay: true } });
    return;
  }
  pl.hand.push({ uid, drawnOnTurn: state.turn.number });
  emit(ctx, 'cardDrawn', { actor: pid, rule: '18.j', pub: { player: pid, deck: 'game', reason: f.reason }, priv: { uid, def: defId }, privTo: [pid] });
}
define('DRAW_CARD', { frame: ['draw'], run: (ctx) => drawCard(ctx, topFrame(ctx.state)) });

// ------------------------------------------------------------------ placement and building frames
define('PLACE_TROOPS', {
  frame: ['placeTroops'],
  run(ctx, a) {
    const { state, data } = ctx; const f = topFrame(state);
    check(Array.isArray(a.placements) && a.placements.length, 'BAD_PLACEMENT', 'placements: [{province, n}] is required.');
    let total = 0;
    for (const x of a.placements) {
      check(isInt(x.n) && x.n >= 1, 'BAD_PLACEMENT', 'Each placement needs a whole number n >= 1.');
      check(f.allowed.includes(x.province), 'NOT_ALLOWED', `${nm(data, x.province)} is not a legal place for these troops.`, '20.j');
      total += x.n;
    }
    check(total === f.count, 'WRONG_COUNT', `Place exactly ${f.count} troop(s) (you placed ${total}).`, '20.j');
    for (const x of a.placements) checkRomaRoom(ctx, x.province, a.placements.filter(y => y.province === x.province).reduce((t, y) => t + y.n, 0));
    popFrame(ctx);
    for (const x of a.placements) {
      const n = changeTroops(ctx, x.province, x.n);
      emit(ctx, 'troopsPlaced', { actor: f.player, rule: '20.j', pub: { player: f.player, province: x.province, n: x.n, reason: f.reason } });
      if (f.reason === 'resourceCard' && f.player === state.turn.activePlayerId && n) state.turn.bonusTroopsGained.push({ province: x.province, n, source: 'resourceCard' });   // 18.r, Q41
    }
  },
});

function takeSavedCard(ctx, pid, uid) {
  const pl = mustPlayer(ctx.state, pid);
  const i = pl.savedResources.findIndex(c => c.uid === uid);
  check(i >= 0, 'NO_SUCH_CARD', 'That saved Resource card is not yours.');
  pl.savedResources.splice(i, 1);
  toDiscard(ctx.state, uid);
}
const pieceOf = (ctx, uid) => ctx.data.cardDefsById[ctx.state.cards[uid].def].effect.params.piece;

define('RESOURCE_BUILD', {
  frame: ['resourceBuild'],
  run(ctx, a) {
    const f = topFrame(ctx.state);
    check(['build', 'save'].includes(a.mode), 'BAD_MODE', 'mode must be "build" or "save".');
    if (a.mode === 'build') {
      buildPiece(ctx, f.player, f.piece, a.province, a.facing, { free: true });
      takeSavedCard(ctx, f.player, f.card);
    } else emit(ctx, 'resourceSaved', { actor: f.player, rule: '20.f', pub: { player: f.player, piece: f.piece } });
    popFrame(ctx);
  },
});
define('USE_SAVED_RESOURCE', {
  turn: true,
  run(ctx, a) {
    const pid = ctx.state.turn.activePlayerId;
    const pl = mustPlayer(ctx.state, pid);
    check(pl.savedResources.some(c => c.uid === a.cardUid), 'NO_SUCH_CARD', 'That saved Resource card is not yours.');
    buildPiece(ctx, pid, pieceOf(ctx, a.cardUid), a.province, a.facing, { free: true });   // free, not an action (20.f, 19.p)
    takeSavedCard(ctx, pid, a.cardUid);
  },
});

// ------------------------------------------------------------------ free general move (15.j, 17.e, 17.z; Vidi 2026-10-22)
/** Where the active player's general may go with the free move right now ([] when it is not available). */
export function generalMoveTargets(state, data, pid) {
  const o = data.rules.generalMove ?? { free: true, oncePerTurn: true, chainOnly: true };
  const pl = state.players.find(p => p.id === pid); const at = pl?.general?.at;
  if (!o.free || !at || (o.oncePerTurn && state.turn.generalMoved)) return [];
  return S.provincesOf(state, pid).filter(id => id !== at && (!o.chainOnly || S.moveRoute(state, data, pid, at, id))).sort();
}
define('MOVE_GENERAL', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const o = data.rules.generalMove;
    const g = data.generalsById[pl.general?.id]?.name ?? 'Your general';
    check(pl.general?.at, 'NO_GENERAL', `${g} is not on the map.`, '15.j');
    check(!(o.oncePerTurn && state.turn.generalMoved), 'GENERAL_MOVED', `${g} already moved this turn: the free general move is once per turn (15.j).`, '15.j');
    mustControl(ctx, a.to, pid);
    check(a.to !== pl.general.at, 'SAME_PROVINCE', `${g} is already in ${nm(data, a.to)}.`);
    const route = S.moveRoute(state, data, pid, pl.general.at, a.to);
    if (o.chainOnly) check(route, 'NO_ROUTE', `No chain of your own provinces connects ${nm(data, pl.general.at)} and ${nm(data, a.to)} (15.j, 17.z).`, '15.j');
    const from = pl.general.at; pl.general.at = a.to; state.turn.generalMoved = true;   // free: no action, no Gold, no troops (15.j)
    emit(ctx, 'generalMoved', { actor: pid, rule: '15.j', pub: { player: pid, from, to: a.to, path: route?.path ?? [from, a.to] } });
  },
});

// ------------------------------------------------------------------ selling cards (20.p, 17.o; Vidi 2026-10-22)
/** Cards the active player may sell right now: Game Cards in hand and saved Resource cards; 2 Gold each from the bank. */
export function sellableCards(state, data, pid) {
  const o = data.rules.sellCard; const pl = state.players.find(p => p.id === pid);
  if (!o || !pl) return [];
  const out = [];
  for (const c of pl.hand) if (o.decks.includes(state.cards[c.uid].deck)) out.push(c.uid);
  if (o.fromSaved) for (const c of pl.savedResources) if (o.decks.includes(state.cards[c.uid].deck)) out.push(c.uid);
  return out;
}
define('SELL_CARD', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const gold = data.rules.sellCard.gold;
    check(sellableCards(state, data, pid).includes(a.cardUid), 'NO_SUCH_CARD', 'Pick a Game Card or Resource card from your hand to sell (20.p).', '20.p');
    const saved = pl.savedResources.some(c => c.uid === a.cardUid);
    const list = saved ? pl.savedResources : pl.hand;
    list.splice(list.findIndex(c => c.uid === a.cardUid), 1);
    toDiscard(state, a.cardUid);
    pl.gold += gold;   // from the bank, never Roma's Gold pile (12.k); not an action (17.e, 17.o)
    emit(ctx, 'cardSold', { actor: pid, rule: '20.p', pub: { player: pid, card: state.cards[a.cardUid].def, deck: state.cards[a.cardUid].deck, gold, saved } });
  },
});

// ------------------------------------------------------------------ Game Roll (16.c to 16.n, 17.b)
export function romaConvert(ctx) {
  const { state, data } = ctx; const per = data.rules.romaGoldPerTroop;
  while (state.roma.goldPile >= per) {
    state.roma.goldPile -= per; changeTroops(ctx, 'roma', 1, 'goldPile');
    emit(ctx, 'romaGoldConverted', { rule: '12.k', pub: { goldPile: state.roma.goldPile, romaTroops: state.provinces.roma.troops } });
  }
}

function afterTax(ctx, pid) {
  const { state, data } = ctx;
  if (S.displeasedQualifies(state, data, pid)) pushFrame(ctx, { kind: 'draw', deck: 'displeased', reason: 'romeRoll', player: pid });
  else emit(ctx, 'displeasedSkipped', { actor: pid, rule: '16.m', pub: { player: pid, prestige: playerOf(state, pid).prestige, troops: S.totalTroops(state, pid), reason: 'does not qualify (needs 4 Prestige or 20 troops)' } });
}

function romeRoll(ctx, pid, number) {
  const { state, data } = ctx; const pl = mustPlayer(state, pid); const holder = S.romaHolder(state);
  emit(ctx, 'romeRoll', { actor: pid, rule: '16.d', pub: { roller: pid, number, carthageDefeated: state.carthage.defeated } });
  const tax = data.rules.romeRollTaxGold;
  if (holder === pid) emit(ctx, 'romeTaxPaid', { actor: pid, rule: '12.l', pub: { player: pid, nothing: true, reason: 'the holder of Roma pays nothing' } });
  else if (pl.gold >= tax) {
    pl.gold -= tax;
    if (holder) mustPlayer(state, holder).gold += tax; else { state.roma.goldPile += tax; }
    emit(ctx, 'romeTaxPaid', { actor: pid, rule: '16.j', pub: { player: pid, gold: tax, to: holder ?? 'roma' } });
    if (!holder) romaConvert(ctx);
  } else {
    const options = S.sparingProvinces(state, data, pid);
    if (!options.length) emit(ctx, 'taxTroopSkipped', { actor: pid, rule: '16.j', pub: { player: pid, reason: 'merciful' } });
    else { pushFrame(ctx, { kind: 'chooseProvince', purpose: 'taxTroop', player: pid, options }); return; }
  }
  afterTax(ctx, pid);
}

defineRoll('gameRoll', (ctx, f) => {
  const { state, data } = ctx; const pid = f.player;
  let v = roll(ctx, data.rules.dice.gameRoll, 'gameRoll', pid);
  const pl = mustPlayer(state, pid); const eg = data.rules.earlyGameRerolls;
  if (pl.gameRollsTaken < eg.gameRollsPerPlayer) {                   // early-game protection: re-roll 1, 2, 9, 10 in a player's first 2 Game Rolls (16.d, 17.b)
    for (let guard = 0; eg.reroll.includes(v) && guard < 100; guard++) {
      emit(ctx, 'gameRollRerolled', { actor: pid, rule: '16.d', pub: { value: v, rollNo: pl.gameRollsTaken + 1, reason: 'early-game protection' } });
      v = roll(ctx, data.rules.dice.gameRoll, 'gameRoll', pid);
    }
  }
  pl.gameRollsTaken += 1;
  popFrame(ctx);
  const rome = data.rules.romeRollNumbers.includes(v) || (data.rules.decreeNumbers.includes(v) && (state.carthage.defeated || state.carthage.neutral));   // neutral Carthage counts as defeated (16.d, 16.n)
  if (rome) { emit(ctx, 'gameRollResolved', { actor: pid, rule: '16.d', pub: { value: v, kind: 'rome' } }); romeRoll(ctx, pid, v); return; }
  if (data.rules.decreeNumbers.includes(v)) {
    emit(ctx, 'gameRollResolved', { actor: pid, rule: '16.n', pub: { value: v, kind: 'decree' } });
    emit(ctx, 'senateDecree', { actor: pid, rule: '16.n', pub: { number: v } });
    turnHooks.startDecree(ctx, pid);                              // battle.js: legions, one combined battle (16.n, M2)
    return;
  }
  const matches = Object.keys(state.provinces).sort().filter(id => state.provinces[id].number === v && state.provinces[id].owner !== null);
  emit(ctx, 'gameRollResolved', { actor: pid, rule: '16.c', pub: { value: v, kind: 'number', owners: matches.map(id => ({ province: id, owner: state.provinces[id].owner })) } });
  const cards = [];
  for (const who of orderFrom(state, pid)) {                    // turn order from the active player (16.c, 16.l)
    let got = false;
    for (const id of matches.filter(m => state.provinces[m].owner === who)) {
      if (!S.earnsReward(state, data, id)) { emit(ctx, 'rewardDenied', { actor: who, rule: '17.q', pub: { player: who, province: id, reason: 'below the garrison needed (17.q, 19.g)' } }); continue; }
      const p = state.provinces[id];
      if (p.reward === 'gold') mustPlayer(state, who).gold += 1; else changeTroops(ctx, id, 1);   // a reward troop goes into the province that earned it (Q6)
      emit(ctx, 'rewardGranted', { actor: who, rule: '16.k', pub: { player: who, province: id, reward: p.reward, number: v } });
      got = true;
    }
    if (got) cards.push(who);                                   // one Game Card per player per roll, even with two matching provinces (16.l)
  }
  for (const who of cards.reverse()) pushFrame(ctx, { kind: 'draw', deck: 'game', reason: 'reward', player: who });   // first player ends on top
});

// ------------------------------------------------------------------ Revolt Roll and revolt (17.c, 17.r, 18.m)
export function moveSurvivors(ctx, pid, from, survivors, withGeneral, dest) {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  if (survivors > 0) { changeTroops(ctx, dest, survivors); emit(ctx, 'survivorsMoved', { actor: pid, rule: '17.c', pub: { player: pid, from, to: dest, n: survivors, general: withGeneral } }); }
  if (withGeneral && pl.general) pl.general.at = dest;
}

export function resolveRevolt(ctx, pid, id, rest, source = 'revoltRoll', by = null) {
  const { state, data } = ctx; const pl = mustPlayer(state, pid); const p = state.provinces[id];
  const min = S.minGarrison(state, data, id).min;                                  // Pompey's lowered minimum when he is the owner (17.c, 15.d)
  const killed = Math.min(p.troops, Math.floor(min / 2) + 1);
  const survivors = p.troops - killed;
  const generalHere = pl.general?.at === id;
  Object.assign(p, { owner: null, status: 'native', startingOf: null, troops: 0, healAtTurn: null });   // roads and walls stay (17.c)
  if (p.native.count !== null) p.native.present = p.native.count;
  let regained = false;
  if (id === 'carthage' && state.carthage.defeated) {
    state.carthage.defeated = false; state.carthage.decreeLegionsLost = 0;
    const n = data.rules.carthageNative[0]; p.native = { rolled: n, count: n, present: n }; regained = true;
  }
  emit(ctx, 'provinceRevolted', { actor: pid, rule: '17.c', pub: { player: pid, province: id, minimum: min, killed, survivors, carthageRegainedSpirit: regained, source, by, general: generalHere } });
  if (regained) emit(ctx, 'carthageRegainedSpirit', { rule: '16.n', pub: {} });
  awardPrestige(ctx, pid, -data.rules.prestige.loss, 'revolt', '12.f');
  if (survivors > 0 || generalHere) {
    const cand = S.nearestOwned(state, data, pid, id);
    if (!cand.length) {
      emit(ctx, 'survivorsLost', { actor: pid, rule: '17.c', pub: { player: pid, from: id, n: survivors, reason: 'no other province to move to' } });
      if (generalHere) pl.general.at = null;
    } else if (cand.length === 1) moveSurvivors(ctx, pid, id, survivors, generalHere, cand[0]);
    else { pushFrame(ctx, { kind: 'chooseProvince', purpose: 'revoltSurvivors', player: pid, options: cand, from: id, survivors, general: generalHere, rest, source, by }); return false; }
  }
  return true;
}

/**
 * Resolves the revolts in `queue` one by one. Before each one, an owner who holds a Kill Revolt leader! is asked whether to block it
 * (18.f, 18.m: instant, any revolt aimed at its owner, no hold-a-turn, no card slot). `source` names what caused it (revoltRoll,
 * extraRevoltRoll, revoltCard). `asked` is the province whose question was just answered "let it happen".
 */
export function processRevolts(ctx, pid, queue, { source = 'revoltRoll', asked = null, by = null } = {}) {
  const { state, data } = ctx;
  const q = [...queue];
  while (q.length) {
    const id = q.shift();
    if (state.phase !== 'turn') return;
    if (state.provinces[id].owner !== pid || state.provinces[id].status !== 'conquered') continue;
    const krl = id === asked ? null : mustPlayer(state, pid).hand.find(c => state.cards[c.uid].def === 'kill_revolt_leader');
    if (krl && data.rules.killRevoltLeaderAsked !== false) {
      pushFrame(ctx, { kind: 'responseWindow', window: 'revoltResponse', player: pid, province: id, rest: [...q], source, by, card: krl.uid, options: ['PLAY_CARD', 'PASS'] });
      return;
    }
    if (!resolveRevolt(ctx, pid, id, [...q], source, by)) return;           // a choice is needed: the frame carries the rest of the queue
  }
}
/** Response windows answered by PLAY_CARD / PASS, by `frame.window` (cards.js and battle.js fill this). */
export const responseWindows = {};

defineRoll('revoltRoll', (ctx, f) => {
  const { state, data } = ctx; const pid = f.player;
  const v = roll(ctx, data.rules.dice.revoltRoll, 'revoltRoll', pid);
  popFrame(ctx);
  const match = S.revoltCandidates(state, pid).filter(id => state.provinces[id].number === v);   // every matching conquered province revolts (Q7)
  const hit = match.filter(id => S.canRevolt(state, data, id));
  emit(ctx, 'revoltRoll', { actor: pid, rule: '17.c', pub: { player: pid, value: v, provinces: hit } });
  for (const id of match.filter(m => !hit.includes(m))) emit(ctx, 'revoltImmune', { actor: pid, rule: '17.c', pub: { player: pid, province: id, troops: state.provinces[id].troops, reason: `${data.rules.revoltImmuneAtTroops} or more troops never revolt` } });
  processRevolts(ctx, pid, hit);
});

// ------------------------------------------------------------------ choosing a province
/** Other modules (battle.js: decree legions) add purposes here. */
export const provinceChoiceHandlers = {};
/** Late-bound hooks set by battle.js (avoids a circular import). */
export const turnHooks = { startDecree: () => {}, displeased: () => {} };
define('CHOOSE_PROVINCE', {
  frame: ['chooseProvince'],
  run(ctx, a) {
    const { state, data } = ctx; const f = topFrame(state);
    check(f.options.includes(a.province), 'NOT_AN_OPTION', `${nm(data, a.province)} is not one of the choices (${f.options.map(o => nm(data, o)).join(', ')}).`, f.purpose === 'taxTroop' ? '16.j' : '17.c');
    popFrame(ctx);
    if (f.purpose === 'taxTroop') {
      const pid = f.player;
      check(S.keepsFloor(state, data, a.province, 1), 'TAX_NO_SPARE', `${nm(data, a.province)} must keep 1 troop.`, '17.f');
      changeTroops(ctx, a.province, -1); changeTroops(ctx, 'roma', 1, 'taxTroop');
      emit(ctx, 'romeTaxPaid', { actor: pid, rule: '16.j', pub: { player: pid, troop: true, from: a.province, to: 'roma' } });
      afterTax(ctx, pid);
    } else if (f.purpose === 'revoltSurvivors') {
      moveSurvivors(ctx, f.player, f.from, f.survivors, f.general, a.province);
      processRevolts(ctx, f.player, f.rest, { source: f.source ?? 'revoltRoll', by: f.by ?? null });
    } else if (provinceChoiceHandlers[f.purpose]) provinceChoiceHandlers[f.purpose](ctx, f, a);
    else fail('NOT_IMPLEMENTED', `chooseProvince purpose "${f.purpose}" is not built yet (milestone M3).`);
  },
});

// ------------------------------------------------------------------ turn actions
const mustControl = (ctx, id, who) => {
  check(ctx.data.provincesById[id], 'UNKNOWN_PROVINCE', `Unknown province "${id}".`);
  check(S.controls(ctx.state, who, id), 'NOT_YOURS', `${nm(ctx.data, id)} is not one of your provinces.`);
};
export const active = ctx => ctx.state.turn.activePlayerId;
export { mustControl };

define('MOVE', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid);
    mustControl(ctx, a.from, pid); mustControl(ctx, a.to, pid);
    check(a.from !== a.to, 'SAME_PROVINCE', 'Pick two different provinces.');
    const n = a.troops ?? 0; const withGeneral = !!a.withGeneral;
    check(isInt(n) && n >= 0, 'BAD_TROOPS', 'troops must be a whole number >= 0.');
    const route = S.moveRoute(state, data, pid, a.from, a.to);
    check(route, 'NO_ROUTE', `No chain of your own provinces connects ${nm(data, a.from)} and ${nm(data, a.to)} (land or sea, 17.z).`, '17.z');
    check(n >= 1 || !withGeneral || !ctx.data.rules.generalMove?.free, 'GENERAL_MOVE_IS_FREE', 'Moving the general on his own is free and not an action: use Move general (15.j).', '15.j');
    check(n >= 1 || withGeneral, 'NOTHING_TO_MOVE', 'Move at least 1 troop (the general alone moves for free, 15.j).', '17.z');
    if (withGeneral) check(pl.general?.at === a.from, 'GENERAL_NOT_THERE', `${data.generalsById[pl.general?.id]?.name ?? 'Your general'} is not in ${nm(data, a.from)}.`, '17.m');
    const max = S.maxMove(state, data, a.from);
    check(n <= max, state.provinces[a.from].status === 'held' ? 'ROMA_FLOOR' : 'PROVINCE_FLOOR',
      `${nm(data, a.from)} can send at most ${max} troop(s): it must keep ${state.provinces[a.from].status === 'held' ? data.rules.romaFloorOnHold : data.rules.provinceFloor} (${state.provinces[a.from].status === 'held' ? '12.l' : '17.f'}).`, state.provinces[a.from].status === 'held' ? '12.l' : '17.f');
    checkRomaRoom(ctx, a.to, n);
    check(pl.gold >= route.cost, 'NEED_GOLD', `Crossing ${route.crossed.map(i => nm(data, i)).join(', ')} costs ${route.cost} Gold (19.t); you have ${pl.gold}.`, '19.t');
    spendAction(ctx, 'move');
    if (route.cost) { pl.gold -= route.cost; emit(ctx, 'allyCrossingPaid', { actor: pid, rule: '19.t', pub: { player: pid, gold: route.cost, crossed: route.crossed } }); }
    if (n) { changeTroops(ctx, a.from, -n); changeTroops(ctx, a.to, n); }
    if (withGeneral) pl.general.at = a.to;
    emit(ctx, 'troopsMoved', { actor: pid, rule: '17.z', pub: { player: pid, from: a.from, to: a.to, troops: n, general: withGeneral, path: route.path } });
  },
});

define('BUY_TROOP', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const cost = data.rules.costs.troop;
    mustControl(ctx, a.province, pid);
    check(pl.gold >= cost, 'NEED_GOLD', `A troop costs ${cost} Gold; you have ${pl.gold}.`, '17.p');
    checkRomaRoom(ctx, a.province, 1);
    spendAction(ctx, 'buyTroop');
    pl.gold -= cost; changeTroops(ctx, a.province, 1);
    emit(ctx, 'troopsBought', { actor: pid, rule: '17.p', pub: { player: pid, province: a.province, gold: cost } });
  },
});

define('BUY_GAME_CARD', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const c = data.rules.costs;
    check(!state.turn.gameCardBought, 'GAME_CARD_LIMIT', 'You may buy at most 1 Game Card per turn.', '17.s');
    check(pl.gold >= c.gameCardGold, 'NEED_GOLD', `A Game Card costs ${c.gameCardGold} Gold and ${c.gameCardTroops} troop; you have ${pl.gold} Gold.`, '17.s');
    mustControl(ctx, a.fromProvince, pid);
    const p = state.provinces[a.fromProvince];
    check(S.keepsFloor(state, data, a.fromProvince, c.gameCardTroops), p.status === 'held' ? 'ROMA_FLOOR' : 'PROVINCE_FLOOR', `${nm(data, a.fromProvince)} cannot pay a troop and still keep ${p.status === 'held' ? data.rules.romaFloorOnHold : 1}.`, '17.s');
    spendAction(ctx, 'buyGameCard');
    pl.gold -= c.gameCardGold; changeTroops(ctx, a.fromProvince, -c.gameCardTroops); state.turn.gameCardBought = true;
    emit(ctx, 'gameCardBought', { actor: pid, rule: '17.s', pub: { player: pid, from: a.fromProvince, gold: c.gameCardGold, troops: c.gameCardTroops } });
    pushFrame(ctx, { kind: 'draw', deck: 'game', reason: 'purchase', player: pid });
  },
});

define('BUILD_ROAD', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const cost = data.rules.costs.road;
    mustControl(ctx, a.province, pid);
    check(!state.provinces[a.province].road, 'ROAD_EXISTS', `${nm(data, a.province)} already has a Road.`, '19.f');
    check(pl.gold >= cost, 'NEED_GOLD', `A Road costs ${cost} Gold; you have ${pl.gold}.`, '19.j');
    spendAction(ctx, 'buildRoad');
    pl.gold -= cost; buildPiece(ctx, pid, 'road', a.province, null, { free: false });
  },
});
define('BUILD_WALL', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const cost = data.rules.costs.wall;
    mustControl(ctx, a.province, pid);
    check(a.facing && S.isNeighbour(data, a.province, a.facing), 'BAD_FACING', 'A Wall faces an adjacent province (land or sea).', '19.k');
    check(!state.provinces[a.province].walls.includes(a.facing), 'WALL_EXISTS', `${nm(data, a.province)} already has a Wall facing ${nm(data, a.facing)}.`, '19.l');
    check(pl.gold >= cost, 'NEED_GOLD', `A Wall costs ${cost} Gold; you have ${pl.gold}.`, '19.j');
    spendAction(ctx, 'buildWall');
    pl.gold -= cost; buildPiece(ctx, pid, 'wall', a.province, a.facing, { free: false });
  },
});

// ---- natives preview and Ally (no fight, so it lives in M1; the Attack is M2)
defineRoll('nativeRoll', (ctx, f) => {
  const { state, data } = ctx;
  const v = roll(ctx, data.rules.dice.native, 'nativeRoll', f.player);
  const count = data.rules.nativeRollTable.find(r => r.d6.includes(v)).count;
  state.provinces[f.target].native = { rolled: count, count, present: count };
  popFrame(ctx);
  emit(ctx, 'nativesRolled', { actor: f.player, rule: '17.h', pub: { player: f.player, province: f.target, d6: v, count } });
});

function checkTargetable(ctx, pid, target) {
  const { state, data } = ctx;
  check(data.provincesById[target], 'UNKNOWN_PROVINCE', `Unknown province "${target}".`);
  const t = state.provinces[target];
  check(t.owner === null, 'TARGET_OWNED', `${nm(data, target)} already belongs to someone.`);
  check(target !== 'roma', 'TARGET_ROMA', 'Roma is attacked, never allied (12.g).', '12.g');
}

define('PREVIEW_TARGET', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx);
    checkTargetable(ctx, pid, a.target);
    check(S.provincesOf(state, pid).some(id => S.isNeighbour(data, id, a.target)), 'NOT_ADJACENT', `${nm(data, a.target)} does not border any of your provinces (16.i).`, '16.i');
    const t = state.provinces[a.target];
    check(t.native.rolled === null && a.target !== 'carthage', 'ALREADY_ROLLED', `${nm(data, a.target)}'s natives are already known (${t.native.present}).`, '17.h');
    pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.native, purpose: 'nativeRoll', player: pid, target: a.target });
  },
});

define('ALLY', {
  turn: true,
  run(ctx, a) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid);
    mustControl(ctx, a.from, pid);
    check(!(a.target === 'carthage'), 'CARTHAGE_CANNOT_ALLY', 'Carthage can never be allied: it can only be attacked or fought in a Senate Decree (17.j).', '17.j');
    checkTargetable(ctx, pid, a.target);
    check(S.isNeighbour(data, a.from, a.target), 'NOT_ADJACENT', `${nm(data, a.target)} does not border ${nm(data, a.from)} (16.i).`, '16.i');
    const from = state.provinces[a.from], t = state.provinces[a.target];
    const poolSea = S.linkType(data, a.from, a.target) === 'sea';
    const pompeySea = poolSea && !!a.withGeneral && pl.general?.id === 'pompey' && pl.general.at === a.from && S.generalPerksActive(state, pid);   // 15.d
    check(from.road || pompeySea, 'NEED_ROAD', `${nm(data, a.from)} needs a Road to act from it (19.b, 19.i).`, '19.b');
    check(t.native.rolled !== null, 'NATIVES_NOT_ROLLED', `Roll ${nm(data, a.target)}'s natives first (PREVIEW_TARGET, 17.h).`, '17.h');
    const n = a.troops;
    check(isInt(n) && n >= 1, 'BAD_TROOPS', 'troops must be a whole number >= 1.');
    check(n <= from.troops - data.rules.provinceFloor, 'PROVINCE_FLOOR', `${nm(data, a.from)} can send at most ${Math.max(0, from.troops - 1)} troop(s): it keeps 1 (17.f, Q64).`, '17.f');
    check(n > t.native.present, 'NOT_ENOUGH_TROOPS', `You need more than ${t.native.present} troops (your own, not borrowed) to ally with ${nm(data, a.target)} (17.j).`, '17.j');
    spendAction(ctx, 'ally');
    changeTroops(ctx, a.from, -n);
    Object.assign(t, { owner: pid, status: 'allied', troops: n, startingOf: null });
    t.native.present = t.native.count; t.healAtTurn = null;
    if (a.withGeneral && pl.general?.at === a.from) pl.general.at = a.target;
    emit(ctx, 'provinceAllied', { actor: pid, rule: '17.j', pub: { player: pid, province: a.target, from: a.from, troops: n } });
  },
});

// ------------------------------------------------------------------ End Turn (17.o)
export function nextTurn(ctx) {
  const { state, data } = ctx; const t = state.turn; const prev = t.activePlayerId;
  const order = state.turnOrder;
  let i = order.indexOf(prev);
  do i = (i + 1) % order.length; while (playerOf(state, order[i]).out && order[i] !== prev);   // eliminated players are skipped (12.m)
  const next = order[i];
  state.turn = { number: t.number + 1, round: Math.ceil((t.number + 1) / order.length), activePlayerId: next, step: 'resources', actionsUsed: 0, nonBattleCardPlayed: false, gameCardBought: false, bonusTroopsGained: [], revoltRollsExtra: 0, generalMoved: false, sub: {} };
  emit(ctx, 'turnStarted', { actor: next, rule: '17.a', pub: { number: state.turn.number, round: state.turn.round, player: next } });
}
define('END_TURN', {
  turn: true,
  run(ctx) {
    const { state, data } = ctx; const t = state.turn; const pid = t.activePlayerId; const pl = mustPlayer(state, pid);
    const unused = Math.max(0, data.rules.actionsPerTurn - t.actionsUsed);   // +1 Gold per unused action (17.o, replaces the pass bonus)
    if (unused) { const g = unused * data.rules.unusedActionGold; pl.gold += g; emit(ctx, 'unusedActionGold', { actor: pid, rule: '17.o', pub: { player: pid, unused, gold: g } }); }
    emit(ctx, 'turnEnded', { actor: pid, rule: '17.a', pub: { number: t.number, player: pid, actionsUsed: t.actionsUsed } });
    nextTurn(ctx);
  },
});

// ------------------------------------------------------------------ the turn state machine (settle hook)
onSettle(ctx => {
  const { state, data } = ctx;
  if (state.phase !== 'turn' || state.pending.length || state.battle || state.decree) return false;   // a battle or decree in progress drives itself (battle.js)
  const t = state.turn; const pid = t.activePlayerId;
  const stepStart = step => emit(ctx, 'stepStarted', { actor: pid, rule: '17.a', pub: { step, player: pid, number: t.number } });
  if (t.step === 'resources') {
    if (!t.sub.resources) { t.sub.resources = 1; stepStart('resources'); beginResources(ctx); return true; }
    t.step = 'gameRoll'; return true;
  }
  if (t.step === 'gameRoll') {
    if (!t.sub.gameRoll) { t.sub.gameRoll = 1; stepStart('gameRoll'); pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.gameRoll, purpose: 'gameRoll', player: pid }); return true; }
    t.step = 'revoltRoll'; return true;
  }
  if (t.step === 'revoltRoll') {
    if (!t.sub.revolt) {
      t.sub.revolt = 1; stepStart('revoltRoll');
      if (S.revoltEligible(state, data, pid)) pushFrame(ctx, { kind: 'roll', die: 'd' + data.rules.dice.revoltRoll, purpose: 'revoltRoll', player: pid });
      else emit(ctx, 'revoltRollSkipped', { actor: pid, rule: '17.c', pub: { player: pid, conquered: S.conqueredOf(state, pid).length, reason: 'fewer than 2 conquered provinces' } });
      return true;
    }
    t.step = 'actions'; stepStart('actions'); return true;
  }
  return false;
});

// ------------------------------------------------------------------ Catapult (19.u, 19.j, 19.p): 5 Gold, an action, permanent
define('BUY_CATAPULT', {
  turn: true,
  run(ctx) {
    const { state, data } = ctx; const pid = active(ctx); const pl = mustPlayer(state, pid); const cost = data.itemsById.catapult.cost.gold;
    check(pl.gold >= cost, 'NEED_GOLD', `A Catapult costs ${cost} Gold; you have ${pl.gold}.`, '19.j');
    spendAction(ctx, 'buyCatapult');
    pl.gold -= cost; pl.items.catapult += 1;
    emit(ctx, 'catapultBought', { actor: pid, rule: '19.u', pub: { player: pid, gold: cost, catapults: pl.items.catapult } });
  },
});

// ------------------------------------------------------------------ Elimination (12.m): no province at all = out of the game
export function eliminate(ctx, pid) {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  pl.out = true;
  for (const c of [...pl.hand, ...pl.inPlay, ...pl.savedResources]) toDiscard(state, c.uid);
  pl.hand = []; pl.inPlay = []; pl.savedResources = [];
  if (pl.general) pl.general.at = null;
  state.pending = state.pending.filter(f => f.player !== pid);
  emit(ctx, 'playerEliminated', { actor: pid, rule: '12.m', pub: { player: pid } });
  const left = state.players.filter(p => !p.out);
  if (ctx.data.rules.lastStandingWins && left.length === 1 && state.winner === null) {                  // last player standing wins (Q76 default)
    state.winner = left[0].id; state.phase = 'finished'; state.pending = [];
    emit(ctx, 'gameWon', { actor: left[0].id, rule: '12.m, Q76', pub: { player: left[0].id, prestige: left[0].prestige, lastStanding: true } });
  }
}
onSettle(ctx => {
  const { state, data } = ctx;
  if (state.phase !== 'turn' || !data.rules.eliminateWithoutProvinces) return false;
  let changed = false;
  // every real player had a start province (setup); bare test scenarios without one are skipped
  for (const p of state.players) if (!p.out && p.startProvince !== null && state.phase === 'turn' && !S.provincesOf(state, p.id).length) { eliminate(ctx, p.id); changed = true; }
  if (state.phase === 'turn' && mustPlayer(state, state.turn.activePlayerId).out && !state.pending.length) {
    emit(ctx, 'turnEnded', { actor: state.turn.activePlayerId, rule: '12.m', pub: { number: state.turn.number, player: state.turn.activePlayerId, eliminated: true } });
    nextTurn(ctx); changed = true;
  }
  return changed;
});
