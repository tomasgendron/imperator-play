// M3.2: the five Rome Is Displeased effects (18.n to 18.u) and the Busy Little Bee! window (18.x).
// turn.js drawCard calls turnHooks.displeased(ctx, pid, defId) when a Rome Is Displeased card is drawn. If the drawer may play a
// Busy Little Bee! (held a turn, card slot free, 1 Gold, a rival to aim at) the window displeasedResponse opens first (PLAY_CARD / PASS).
// Defaults (PLAN 11): Q42 recall = all perks off through the victim's next own turn; Q45 poverty tested before halving;
// Q40 removed = conquered or allied (never a start province, never Roma), owner picks it and where its troops go, no Prestige;
// Q41 stolen = this turn's bonus troops + Resource Card troops, each province keeps 1; Q44 taxed = hand + saved Resources + the
// Garrison card in play, 5 or more lose 2, the victim chooses. New defaults (Q89-Q92): the Bee is played by the drawer only, a
// redirected card cannot be redirected again, the Bee's Gold follows the Rome Roll tax route (holder of Roma, else the pile).
import { fail, check, emit, pushFrame, popFrame, topFrame, mustPlayer, playerOf, toDiscard, awardPrestige } from './core.js';
import { define } from './actions.js';
import { registerEffect } from './registry.js';
import { changeTroops, moveSurvivors, provinceChoiceHandlers, responseWindows, turnHooks, romaConvert } from './turn.js';
import { heldLongEnough, rivals } from './cards.js';
import * as S from './selectors.js';

const nm = (data, id) => data.provincesById[id]?.name ?? id;
const defOf = (state, uid) => state.cards[uid].def;

// ------------------------------------------------------------------ pure selectors (legalActions / AI)
/** The Busy Little Bee! the drawer could play now, or null (18.x, 18.h). */
export function beeFor(state, data, pid) {
  const pl = playerOf(state, pid);
  if (state.turn.activePlayerId !== pid || state.turn.nonBattleCardPlayed) return null;
  if (pl.gold < (data.cardDefsById.busy_little_bee.play?.costGold ?? 1) || !rivals(state, pid).length) return null;
  return pl.hand.find(c => defOf(state, c.uid) === 'busy_little_bee' && heldLongEnough(state, data, c)) ?? null;
}
/** Provinces Emperor removes you from a Province! may restore (18.q, Q40). */
export const removableProvinces = (state, pid, data = null) => S.provincesOf(state, pid).filter(id => id !== 'roma' && (data?.rules.removedAllowsAllied === false ? ['conquered'] : ['conquered', 'allied']).includes(state.provinces[id].status));
/** Cards Emperor taxes you! may take (18.u, Q44): Game Cards in hand, saved Resource cards, cards in play (the Garrison card). */
export const taxableCards = (state, pid) => { const p = playerOf(state, pid); return [...p.hand, ...p.savedResources, ...p.inPlay].map(c => c.uid); };
export const taxCount = (state, data, pid) => {
  const n = taxableCards(state, pid).length; const e = data.cardDefsById.taxes_you.effect.params;
  return Math.min(n, n >= e.loseMoreAtOrAbove ? e.loseMore : e.lose);
};
/** The turn number through which a recalled general has no perks: the victim's current turn and their next own turn (18.o, Q42). */
export function recallThrough(state, pid, data = null) {
  if (data?.rules.recallRedirectedThrough === 'currentTurn' && state.turn.activePlayerId !== pid) return state.turn.number;   // Q91 alternative
  const order = state.turnOrder.filter(id => !playerOf(state, id).out || id === pid);
  const n = order.length; const a = order.indexOf(state.turn.activePlayerId); const v = order.indexOf(pid);
  const ahead = (v - a + n) % n;
  return state.turn.number + (ahead === 0 ? n : ahead);
}

// ------------------------------------------------------------------ the draw
turnHooks.displeased = (ctx, pid, defId) => {
  const { state, data } = ctx;
  const bee = beeFor(state, data, pid);
  if (bee) { pushFrame(ctx, { kind: 'responseWindow', window: 'displeasedResponse', player: pid, def: defId, card: bee.uid, targets: rivals(state, pid), options: ['PLAY_CARD', 'PASS'] }); return; }
  applyDispleased(ctx, pid, defId);
};

responseWindows.displeasedResponse = {
  rule: '18.x',
  play(ctx, f, a) {
    const { state, data } = ctx; const pl = mustPlayer(state, f.player);
    const entry = pl.hand.find(c => c.uid === (a.cardUid ?? f.card)) ?? pl.hand.find(c => defOf(state, c.uid) === a.card);
    check(entry && defOf(state, entry.uid) === 'busy_little_bee', 'WRONG_CARD', 'Only Busy Little Bee! redirects a Rome Is Displeased card (18.x).', '18.x');
    check(heldLongEnough(state, data, entry), 'HOLD_A_TURN', 'Busy Little Bee! must be held until the turn after it was drawn (18.h).', '18.h');
    check(f.targets.includes(a.targetPlayer), 'ILLEGAL_TARGET', `Redirect it onto another player: ${f.targets.join(', ')} (18.x).`, '18.x');
    const cost = data.cardDefsById.busy_little_bee.play?.costGold ?? 1;
    check(pl.gold >= cost, 'NEED_GOLD', `Busy Little Bee! costs ${cost} Gold (18.x).`, '18.x');
    popFrame(ctx);
    pl.gold -= cost;
    const holder = data.rules.beeGoldTo === 'romaPile' ? null : S.romaHolder(state);   // Q90 flag
    if (holder && holder !== f.player) mustPlayer(state, holder).gold += cost; else { state.roma.goldPile += cost; if (!S.romaHolder(state)) romaConvert(ctx); }
    state.turn.nonBattleCardPlayed = true;
    pl.hand.splice(pl.hand.indexOf(entry), 1); toDiscard(state, entry.uid);
    emit(ctx, 'cardPlayed', { actor: f.player, rule: '18.x', pub: { player: f.player, def: 'busy_little_bee', uid: entry.uid, source: 'displeasedResponse' } });
    emit(ctx, 'displeasedRedirected', { actor: f.player, rule: '18.x', pub: { player: f.player, to: a.targetPlayer, def: f.def, gold: cost, goldTo: holder && holder !== f.player ? holder : 'roma' } });
    applyDispleased(ctx, a.targetPlayer, f.def, { redirectedBy: f.player });
  },
  pass(ctx, f) { applyDispleased(ctx, f.player, f.def); },
};

// ------------------------------------------------------------------ the five effects
const EFFECTS = {};
export function applyDispleased(ctx, pid, defId, extra = {}) {
  const fx = EFFECTS[defId];
  if (!fx) fail('NOT_IMPLEMENTED', `Rome Is Displeased card ${defId} has no effect.`);
  fx(ctx, pid, extra);
}
const none = (ctx, pid, def, reason, rule) => emit(ctx, 'displeasedNoEffect', { actor: pid, rule, pub: { player: pid, def, reason } });

// 18.o General is Recalled to Rome! (Q42)
EFFECTS.recalled_to_rome = (ctx, pid) => {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  const through = Math.max(pl.generalRecalledThroughTurn ?? 0, recallThrough(state, pid, ctx.data));
  pl.generalRecalledThroughTurn = through;
  emit(ctx, 'generalRecalled', { actor: pid, rule: '18.o', pub: { player: pid, throughTurn: through } });
};
// 18.p Emperor confiscates half your Gold! (Q45: poverty is tested before halving)
EFFECTS.confiscates_gold = (ctx, pid) => {
  const { state, data } = ctx; const pl = mustPlayer(state, pid); const e = data.cardDefsById.confiscates_gold.effect.params;
  const before = pl.gold; const lost = Math.floor(before * e.fraction); const poor = before < e.povertyBelow;
  pl.gold -= lost;
  emit(ctx, 'goldConfiscated', { actor: pid, rule: '18.p', pub: { player: pid, lost, left: pl.gold, poverty: poor } });
  if (poor) awardPrestige(ctx, pid, -e.povertyPrestigeLoss, 'poverty', '18.p');
};
// 18.q Emperor removes you from a Province! (Q40)
EFFECTS.removed_from_province = (ctx, pid) => {
  const { state, data } = ctx; const opts = removableProvinces(state, pid, data);
  if (!opts.length) return none(ctx, pid, 'removed_from_province', 'no conquered or allied province (a start province and a held Roma cannot be chosen)', '18.q');
  if (opts.length === 1) return removeProvince(ctx, pid, opts[0]);
  pushFrame(ctx, { kind: 'chooseProvince', purpose: 'removedProvince', player: pid, options: opts });
};
provinceChoiceHandlers.removedProvince = (ctx, f, a) => removeProvince(ctx, f.player, a.province);
provinceChoiceHandlers.removedTroops = (ctx, f, a) => moveSurvivors(ctx, f.player, f.from, f.survivors, f.general, a.province);
function removeProvince(ctx, pid, id) {
  const { state, data } = ctx; const pl = mustPlayer(state, pid); const p = state.provinces[id];
  const troops = p.troops; const general = pl.general?.at === id;
  Object.assign(p, { owner: null, status: 'native', startingOf: null, troops: 0, healAtTurn: null });   // roads and walls stay, as after a revolt
  if (p.native.count !== null) p.native.present = p.native.count;
  let regained = false;
  if (id === 'carthage' && state.carthage.defeated) {
    state.carthage.defeated = false; state.carthage.decreeLegionsLost = 0;
    const n = data.rules.carthageNative[0]; p.native = { rolled: n, count: n, present: n }; regained = true;
  }
  emit(ctx, 'provinceRemoved', { actor: pid, rule: '18.q', pub: { player: pid, province: id, troops, carthageRegainedSpirit: regained } });
  if (regained) emit(ctx, 'carthageRegainedSpirit', { rule: '16.n', pub: {} });
  if (!troops && !general) return;
  const dest = S.provincesOf(state, pid).filter(x => x !== 'roma' || S.romaRoom(state, data) > 0);
  if (!dest.length) { emit(ctx, 'survivorsLost', { actor: pid, rule: '18.q', pub: { player: pid, from: id, n: troops, reason: 'no other province to move to' } }); if (general) pl.general.at = null; return; }
  if (dest.length === 1) return moveSurvivors(ctx, pid, id, troops, general, dest[0]);
  pushFrame(ctx, { kind: 'chooseProvince', purpose: 'removedTroops', player: pid, options: dest, from: id, survivors: troops, general });
}
// 18.r Emperor steals your troops! (Q41)
EFFECTS.steals_troops = (ctx, pid) => {
  const { state, data } = ctx;
  if (S.romaHolder(state) === pid) return none(ctx, pid, 'steals_troops', 'you hold Roma: the troops would go to your own Roma', '18.r');
  const gains = state.turn.activePlayerId === pid ? state.turn.bonusTroopsGained : [];
  let total = 0; const taken = [];
  for (const g of gains) {
    const p = state.provinces[g.province];
    if (p.owner !== pid) continue;
    const n = Math.min(g.n, Math.max(0, p.troops - data.rules.provinceFloor));
    if (!n) continue;
    changeTroops(ctx, g.province, -n); total += n; taken.push({ province: g.province, n });
  }
  if (!total) return none(ctx, pid, 'steals_troops', 'no bonus troops this turn that can be taken', '18.r');
  const added = changeTroops(ctx, 'roma', total, 'stolen');
  emit(ctx, 'troopsStolen', { actor: pid, rule: '18.r', pub: { player: pid, taken, total, toRoma: added } });
};
// 18.u Emperor taxes you! (Q44: the victim chooses)
EFFECTS.taxes_you = (ctx, pid) => {
  const { state, data } = ctx; const all = taxableCards(state, pid); const n = taxCount(state, data, pid);
  if (!n) return none(ctx, pid, 'taxes_you', 'no saved cards', '18.u');
  if (n === all.length) return loseCards(ctx, pid, all);
  pushFrame(ctx, { kind: 'discardCards', purpose: 'taxes', player: pid, count: n, options: all });
};
function loseCards(ctx, pid, uids) {
  const { state } = ctx; const pl = mustPlayer(state, pid);
  for (const uid of uids) {
    for (const k of ['hand', 'savedResources', 'inPlay']) { const i = pl[k].findIndex(c => c.uid === uid); if (i >= 0) pl[k].splice(i, 1); }
    toDiscard(state, uid);
  }
  emit(ctx, 'cardsTaxed', { actor: pid, rule: '18.u', pub: { player: pid, defs: uids.map(u => defOf(state, u)), n: uids.length } });
}
define('DISCARD_CARDS', {
  frame: ['discardCards'],
  run(ctx, a) {
    const f = topFrame(ctx.state);
    check(Array.isArray(a.cardUids) && a.cardUids.length === f.count && new Set(a.cardUids).size === f.count, 'WRONG_COUNT', `Choose exactly ${f.count} different card(s) to lose (18.u).`, '18.u');
    for (const u of a.cardUids) check(f.options.includes(u), 'NOT_AN_OPTION', `${u} is not one of your saved cards.`, '18.u');
    popFrame(ctx);
    loseCards(ctx, f.player, a.cardUids);
  },
});

registerEffect('recallGeneral', EFFECTS.recalled_to_rome);
registerEffect('confiscateGold', EFFECTS.confiscates_gold);
registerEffect('removeFromProvince', EFFECTS.removed_from_province);
registerEffect('stealTroopsToRoma', EFFECTS.steals_troops);
registerEffect('taxSavedCards', EFFECTS.taxes_you);
registerEffect('redirectDispleased', responseWindows.displeasedResponse);
