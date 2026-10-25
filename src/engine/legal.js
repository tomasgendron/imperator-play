// legalActions (PLAN 4.5): the list of things the player who must act can do right now, as concrete actions with a label.
// It is built from candidate actions and every candidate is DRY-RUN through applyAction, so the list can never offer an illegal action
// (the engine is the one source of truth; an action that errors is simply dropped). ROLL is not dry-run (it needs dice) and is always legal when its frame is on top.
// Descriptor: { type, playerId, label, action, range? } where range = { field, min, max } marks a numeric parameter the console may vary
// (the `action` carries a sensible default, the maximum).
import { applyAction } from './apply.js';
import { topFrame } from './core.js';
import * as S from './selectors.js';
import { attackTargets } from './battle.js';
import { generalMoveTargets, sellableCards } from './turn.js';
import { TURN_PLAYS, heldLongEnough, revoltTargets, bribeTargets, assassinTargets, assassinKills, strikeTroops } from './cards.js';

const nm = (data, id) => data.provincesById[id]?.name ?? id;

/** Who has to act now: the top frame's player, else the active player (null when the game is over). */
export function whoActs(state) {
  if (state.phase === 'finished') return null;
  const f = topFrame(state);
  if (f) return f.resolvableBy?.[0] ?? f.player ?? state.players[0].id;
  return state.phase === 'turn' ? state.turn.activePlayerId : null;
}

const ROLL_LABEL = {
  gameRoll: () => 'Game Roll', revoltRoll: () => 'Revolt Roll', extraRevoltRoll: () => 'extra Revolt Roll, 19.d', loyalty: () => 'Ingrained Loyalty, 12.j',
  battleRound: f => `battle round ${f.round}: ${f.dice.attacker} vs ${f.dice.defender} dice`,
};

export function legalActions(state, data) {
  const who = whoActs(state);
  if (!who) return [];
  const out = [];
  const add = (action, label, range) => out.push({ type: action.type, playerId: who, label, action: { ...action, playerId: who }, ...(range ? { range } : {}) });
  const f = topFrame(state);

  if (f) {
    switch (f.kind) {
      case 'roll': add({ type: 'ROLL' }, `Roll the ${f.die}${ROLL_LABEL[f.purpose] ? ' (' + ROLL_LABEL[f.purpose](f) + ')' : ''}`); break;
      case 'setupGeneral': {
        const taken = new Set(state.players.filter(p => p.general).map(p => p.general.id));
        for (const g of data.generals) if (!taken.has(g.id)) add({ type: 'CHOOSE_GENERAL', general: g.id }, `Choose ${g.name}`);
        add({ type: 'CHOOSE_GENERAL', general: 'random' }, 'Choose a random general');
        break;
      }
      case 'setupStartProvince': for (const id of data.provinceIds) add({ type: 'CHOOSE_START_PROVINCE', province: id }, `Start in ${nm(data, id)}`); break;
      case 'draw': add({ type: 'DRAW_CARD' }, `Draw a ${f.deck === 'displeased' ? 'Rome Is Displeased' : f.deck === 'resource' ? 'Resource' : 'Game'} card`); break;
      case 'placeTroops': {
        for (const id of f.allowed) add({ type: 'PLACE_TROOPS', placements: [{ province: id, n: f.count }] }, `Place ${f.count} troop(s) in ${nm(data, id)}`);
        if (f.count === 2) for (let i = 0; i < f.allowed.length; i++) for (let j = i + 1; j < f.allowed.length; j++)
          add({ type: 'PLACE_TROOPS', placements: [{ province: f.allowed[i], n: 1 }, { province: f.allowed[j], n: 1 }] }, `Place 1 in ${nm(data, f.allowed[i])} and 1 in ${nm(data, f.allowed[j])}`);
        break;
      }
      case 'resourceBuild': {
        add({ type: 'RESOURCE_BUILD', mode: 'save' }, `Save the ${f.piece} card for later`);
        for (const id of S.provincesOf(state, who)) {
          if (f.piece === 'road') add({ type: 'RESOURCE_BUILD', mode: 'build', province: id }, `Build the Road in ${nm(data, id)}`);
          else for (const n of S.neighbours(data, id)) add({ type: 'RESOURCE_BUILD', mode: 'build', province: id, facing: n }, `Build the Wall in ${nm(data, id)} facing ${nm(data, n)}`);
        }
        break;
      }
      case 'chooseProvince': for (const id of f.options) add({ type: 'CHOOSE_PROVINCE', province: id }, `${{ taxTroop: 'Pay the tax troop from', decreeLegion: 'Send the Decree legion from', removedProvince: 'The Emperor restores', removedTroops: 'Move the troops to' }[f.purpose] ?? 'Send the survivors to'} ${nm(data, id)}`); break;
      // battles (M2)
      case 'chooseBorrow': add({ type: 'CHOOSE_BORROW', count: f.max }, `Borrow natives from ${nm(data, f.from)} (0-${f.max})`, { field: 'count', min: 0, max: f.max }); break;
      case 'chooseBattleCards': {
        const kinds = Object.keys(f.held); let combos = [{}];
        for (const k of kinds) combos = combos.flatMap(c => Array.from({ length: f.held[k] + 1 }, (_, n) => ({ ...c, ...(n ? { [k]: n } : {}) })));
        for (const c of combos) {
          const txt = Object.entries(c).map(([k, n]) => `${n} ${data.cardDefsById[k]?.name ?? k}`).join(' + ');
          add({ type: 'CHOOSE_BATTLE_CARDS', cards: c }, txt ? `Commit ${txt} (${f.role})` : `No battle cards (${f.role})`);
        }
        break;
      }
      case 'choosePerk': for (const o of f.options.filter(x => x === 'extraDie')) add({ type: 'CHOOSE_PERK', perk: o }, 'Scipio: an extra attack die'); break;   // only an old save can still hold this frame (15.c, 2026-10-24)
      case 'responseWindow':
        if (f.window === 'revoltResponse') {
          add({ type: 'PLAY_CARD', cardUid: f.card }, `Kill Revolt leader!: ${nm(data, f.province)} does not revolt`);
          add({ type: 'PASS' }, `Let ${nm(data, f.province)} revolt (keep the card)`);
          break;
        }
        if (f.window === 'displeasedResponse') {
          const who2 = id => state.players.find(p => p.id === id)?.name ?? id;
          for (const t of f.targets) add({ type: 'PLAY_CARD', cardUid: f.card, targetPlayer: t }, `Busy Little Bee!: send ${data.cardDefsById[f.def]?.name ?? f.def} to ${who2(t)} (1 Gold)`);
          add({ type: 'PASS' }, `Suffer ${data.cardDefsById[f.def]?.name ?? f.def} (keep the Bee)`);
          break;
        }
        add({ type: 'PASS' }, 'Pass (no Horn of Titus Pullus)');
        for (const src of f.sources ?? []) {
          add({ type: 'CALL_REINFORCEMENTS', from: src.province, troops: src.max }, `Horn: reinforce from ${nm(data, src.province)}`, { field: 'troops', min: 1, max: src.max });
          if (src.general) add({ type: 'CALL_REINFORCEMENTS', from: src.province, troops: src.max, withGeneral: true }, `Horn: reinforce from ${nm(data, src.province)} with the general`, { field: 'troops', min: 1, max: src.max });
        }
        break;
      case 'battleContinue':
        add({ type: 'BATTLE_CONTINUE' }, `Continue the battle (${f.attacker} vs ${f.defender})`);
        add({ type: 'BATTLE_RETREAT' }, 'Retreat (survivors go home)');
        break;
      case 'discardCards': {
        const o = f.options; const lbl = u => data.cardDefsById[state.cards[u].def]?.name ?? state.cards[u].def;
        if (f.count === 1) for (const u of o) add({ type: 'DISCARD_CARDS', cardUids: [u] }, `Emperor's tax: lose ${lbl(u)}`);
        else for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) add({ type: 'DISCARD_CARDS', cardUids: [o[i], o[j]] }, `Emperor's tax: lose ${lbl(o[i])} and ${lbl(o[j])}`);
        break;
      }
      case 'placeSurvivors': {
        const rng = f.maxBack >= 1 ? { field: 'back', min: 0, max: f.maxBack } : undefined;
        const sv = f.maxBack >= 1 ? `send 0-${f.maxBack} survivor(s) back to ${nm(data, f.origin)}` : `no survivor can go back`;
        if (!f.general) add({ type: 'PLACE_SURVIVORS', back: 0 }, `Survivors: ${sv}`, rng);
        else {   // 17.y: after a win the general stays in the conquered province or goes back to the origin
          add({ type: 'PLACE_SURVIVORS', back: 0, generalBack: false }, `General stays in ${nm(data, f.target)}; ${sv}`, rng);
          add({ type: 'PLACE_SURVIVORS', back: 0, generalBack: true }, `General goes back to ${nm(data, f.origin)}; ${sv}`, rng);
        }
        break;
      }
      default: break;
    }
  } else if (state.phase === 'turn' && state.turn.step === 'actions') {
    const mine = S.provincesOf(state, who);
    const unused = Math.max(0, data.rules.actionsPerTurn - state.turn.actionsUsed);
    add({ type: 'END_TURN' }, unused ? `End Turn (+${unused * data.rules.unusedActionGold} Gold for ${unused} unused action${unused > 1 ? 's' : ''})` : 'End Turn');
    // cheap pruning before the dry runs (M3, for the M4 AI): every action below costs one of the 2 actions (17.e) and the buys have
    // fixed Gold prices (data.rules.costs), so candidates that must fail are not generated at all. The dry run still has the last word.
    const me = state.players.find(p => p.id === who); const gold = me.gold; const c = data.rules.costs;
    const act = unused > 0;
    if (act && gold >= data.itemsById.catapult.cost.gold) add({ type: 'BUY_CATAPULT' }, `Buy a Catapult (${data.itemsById.catapult.cost.gold} Gold)`);
    if (act) for (const id of mine) {
      if (gold >= c.troop) add({ type: 'BUY_TROOP', province: id }, `Buy a troop in ${nm(data, id)} (${c.troop} Gold)`);
      if (gold >= c.gameCardGold && state.provinces[id].troops > c.gameCardTroops) add({ type: 'BUY_GAME_CARD', fromProvince: id }, `Buy a Game Card, paying a troop from ${nm(data, id)} (${c.gameCardGold} Gold)`);
      if (gold >= c.road && !state.provinces[id].road) add({ type: 'BUILD_ROAD', province: id }, `Build a Road in ${nm(data, id)} (${c.road} Gold)`);
      if (gold >= c.wall) for (const n of S.neighbours(data, id)) if (!state.provinces[id].walls.includes(n)) add({ type: 'BUILD_WALL', province: id, facing: n }, `Build a Wall in ${nm(data, id)} facing ${nm(data, n)} (${c.wall} Gold)`);
    }
    // cards played by hand in the Actions step (18.h): not an action, one per turn, held since an earlier turn
    if (!state.turn.nonBattleCardPlayed) {
      const seen = new Set();
      for (const e of me.hand) {
        const def = state.cards[e.uid].def;
        if (seen.has(def) || !TURN_PLAYS[def] || !heldLongEnough(state, data, e)) continue;
        seen.add(def);
        const owner = id => { const o = state.provinces[id].owner; return state.players.find(p => p.id === o)?.name ?? o; };
        if (def === 'revolt') for (const t of revoltTargets(state, data, who)) add({ type: 'PLAY_CARD', cardUid: e.uid, target: t }, `Play Revolt! on ${owner(t)}'s ${nm(data, t)}`);
        if (def === 'bribe_the_ally') for (const t of bribeTargets(state, data, who)) if (gold >= t.cost) add({ type: 'PLAY_CARD', cardUid: e.uid, target: t.province }, `Play Bribe the Ally! on ${owner(t.province)}'s ${nm(data, t.province)} (${t.cost} Gold)`);
        if (def === 'assassin') {
          const k = assassinKills(state, data, who); const ts = assassinTargets(state, who, data);
          const whose = t => (state.provinces[t].owner ? `${owner(t)}'s ${nm(data, t)}` : `${nm(data, t)} (natives)`);
          for (const t of ts) if (strikeTroops(state, t) - 1 >= k) add({ type: 'PLAY_CARD', cardUid: e.uid, kills: [{ province: t, n: k }] }, `Play Assassin! on ${whose(t)} (${k} troop${k > 1 ? 's' : ''})`);
          if (k === 2) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++)
            add({ type: 'PLAY_CARD', cardUid: e.uid, kills: [{ province: ts[i], n: 1 }, { province: ts[j], n: 1 }] }, `Play Assassin! on ${nm(data, ts[i])} and ${nm(data, ts[j])} (1 each)`);
        }
      }
    }
    const gen = state.players.find(p => p.id === who).general;
    if (act) for (const from of mine) for (const to of mine) {
      if (from === to) continue;
      const max = S.maxMove(state, data, from);
      if (max >= 1) add({ type: 'MOVE', from, to, troops: max }, `Move troops ${nm(data, from)} → ${nm(data, to)}`, { field: 'troops', min: 1, max });
      if (gen?.at === from) {
        if (max >= 1) add({ type: 'MOVE', from, to, troops: max, withGeneral: true }, `Move the general with troops ${nm(data, from)} → ${nm(data, to)}`, { field: 'troops', min: 1, max });
      }
    }
    // free, not actions: the general's own move (15.j) and selling cards for 2 Gold (20.p)
    for (const to of generalMoveTargets(state, data, who)) add({ type: 'MOVE_GENERAL', to }, `Move the general to ${nm(data, to)} (free, once per turn)`);
    for (const uid of sellableCards(state, data, who)) add({ type: 'SELL_CARD', cardUid: uid }, `Sell ${data.cardDefsById[state.cards[uid].def].name} for ${data.rules.sellCard.gold} Gold`);
    for (const c of state.players.find(p => p.id === who).savedResources) {
      const piece = data.cardDefsById[state.cards[c.uid].def].effect.params.piece;
      for (const id of mine) {
        if (piece === 'road') add({ type: 'USE_SAVED_RESOURCE', cardUid: c.uid, province: id }, `Use the saved Road card in ${nm(data, id)} (free)`);
        else for (const n of S.neighbours(data, id)) add({ type: 'USE_SAVED_RESOURCE', cardUid: c.uid, province: id, facing: n }, `Use the saved Wall card in ${nm(data, id)} facing ${nm(data, n)} (free)`);
      }
    }
    if (act) for (const from of mine) {
      const max = S.maxLeaving(state, data, from);
      if (max < 1) continue;
      for (const t of attackTargets(state, data, who, from)) {
        const what = `${nm(data, t.id)}${state.provinces[t.id].owner ? '' : ' (natives)'} from ${nm(data, from)}${t.via ? ' via ' + nm(data, t.via) : ''}`;
        add({ type: 'ATTACK', from, target: t.id, troops: max }, `ATTACK ${what}`, { field: 'troops', min: 1, max });
        if (gen?.at === from) add({ type: 'ATTACK', from, target: t.id, troops: max, withGeneral: true }, `ATTACK ${what} with the general`, { field: 'troops', min: 1, max });
      }
    }
    for (const target of data.provinceIds) {
      const t = state.provinces[target];
      if (t.owner !== null || target === 'roma') continue;
      if (t.native.rolled === null && target !== 'carthage') add({ type: 'PREVIEW_TARGET', target }, `Roll the natives of ${nm(data, target)} (look before you leap)`);
      if (target === 'carthage' || t.native.rolled === null) continue;
      if (act) for (const from of mine) {
        const room = state.provinces[from].troops - 1, need = t.native.present + 1;
        if (room >= need) add({ type: 'ALLY', from, target, troops: need }, `Ally with ${nm(data, target)} from ${nm(data, from)}`, { field: 'troops', min: need, max: room });
      }
    }
  }

  // dry-run everything except ROLL: the engine decides what is legal
  const probe = { ...state, log: [] };   // the log is not needed to judge legality, and cloning it for every candidate would be slow
  return out.filter(d => d.type === 'ROLL' || !applyAction(probe, d.action, { data }).error);
}
