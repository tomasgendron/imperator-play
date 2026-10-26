// Pure model of the throwaway engine console (M1.4): a session is an immutable history of states; nothing here touches the DOM,
// so the Node tests drive exactly what the page drives. Dev tool only: it shows private events too (hot-seat debugging), unlike viewFor.
import { createGame, applyAction, legalActions, whoActs, minGarrison, isUnderGarrisoned, topFrame, chooseAction, validateSetup } from '../engine/index.js';

const pn = (state, id) => state.players.find(p => p.id === id)?.name ?? id ?? 'nobody';
const prov = (data, id) => data.provincesById[id]?.name ?? id;

/**
 * A new console session. Either `names` (all Human) or `seats` = [{name, controller: 'human'|'ai', general?: id|'random', startProvince?}]
 * (M4 setup screen). mode = 'random' | 'selected' | 'pick' | 'classic'. Throws an EngineError-like Error when the setup is invalid.
 */
export function newSession(data, { seed = 'console', names = ['Vidi', 'Boardicca'], seats = null, mode = 'random' } = {}) {
  const players = seats ? seats.map(x => ({ name: x.name, controller: x.controller ?? 'human', ...(x.general && x.general !== 'random' ? { general: x.general } : {}), ...(x.startProvince ? { startProvince: x.startProvince } : {}) }))
    : names.map(name => ({ name }));
  const { state, events } = createGame(data, { seed, players, options: { startProvinceMode: mode } });
  return { data, seed, steps: [{ state, events, action: null, error: null }] };
}
/** 'Elephants!, Moral boost! x2' from a list of card defs. */
const cardList = (d, defs) => Object.entries(defs.reduce((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {})).map(([k, n]) => (d.cardDefsById?.[k]?.name ?? k) + (n > 1 ? ' x' + n : '')).join(', ');
/** Setup-screen helpers (M4): the choices and a validation that names the seat and field of each problem. */
export const setupChoices = data => ({
  generals: data.generals.map(g => ({ id: g.id, name: g.name })),
  starts: data.provinceIds.filter(id => data.provincesById[id].startingEligible).map(id => ({ id, name: data.provincesById[id].name })),
});
export const checkSetup = (data, seats, mode) => validateSetup(data, { players: seats.map(x => ({ name: x.name, controller: x.controller, general: x.general, startProvince: x.startProvince || undefined })), startProvinceMode: mode });
/** Is it an AI seat's turn to answer (or an automatic deal with nobody to ask)? */
export function aiToMove(s) {
  const state = stateOf(s);
  if (state.phase === 'finished') return false;
  const f = topFrame(state);
  if (f && f.kind === 'roll' && !f.player) return true;
  return state.players.find(p => p.id === whoActs(state))?.controller === 'ai';
}
/** The AI's move for the seat that must act (deterministic per session seed and seat). */
export function aiMove(s) {
  const state = stateOf(s); const who = whoActs(state);
  return chooseAction(state, s.data, { seed: `${s.seed}|${who}` });
}
export const current = s => s.steps[s.steps.length - 1];
export const stateOf = s => current(s).state;
export const legalOf = s => legalActions(stateOf(s), s.data);

/** Applies an action (optionally with rigged dice such as "3,5"); an illegal action leaves the session unchanged and reports the error. */
export function play(s, action, diceText = '') {
  const dice = String(diceText).split(/[ ,]+/).filter(Boolean).map(Number);
  if (dice.some(d => !Number.isInteger(d) || d < 1)) return { session: s, error: { code: 'BAD_DICE', message: 'Dice must be whole numbers, e.g. "3,5".' } };
  const r = applyAction(stateOf(s), action, { data: s.data, ...(dice.length ? { dice } : {}) });
  if (r.error) return { session: s, error: r.error };
  return { session: { ...s, steps: [...s.steps, { state: r.state, events: r.events, action, error: null }] }, error: null };
}
export const undo = s => (s.steps.length > 1 ? { ...s, steps: s.steps.slice(0, -1) } : s);

/** A random-bot move for the "auto-play" button; `rnd` returns [0,1). */
export function botMove(s, rnd) {
  const legal = legalOf(s); if (!legal.length) return null;
  const pool = legal.filter(d => d.type !== 'END_TURN');
  const from = pool.length && rnd() < 0.85 ? pool : legal;
  const d = from[Math.floor(rnd() * from.length)];
  return d.range ? { ...d.action, [d.range.field]: d.range.min + Math.floor(rnd() * (d.range.max - d.range.min + 1)) } : d.action;
}

export function describePrompt(state, data) {
  if (state.phase === 'finished') return `Game over: ${pn(state, state.winner)} wins with ${state.players.find(p => p.id === state.winner)?.prestige} Prestige.`;
  const f = topFrame(state);
  if (state.phase === 'setup') {
    if (f?.kind === 'roll') return `Setup: ${pn(state, f.player ?? state.players[0].id)} rolls ${f.die} (${f.purpose}).`;
    if (f?.kind === 'setupGeneral') return `Setup: ${pn(state, f.player)} chooses a general.`;
    if (f?.kind === 'setupStartProvince') return `Setup: ${pn(state, f.player)} picks a start province.`;
    return 'Setup.';
  }
  const t = state.turn; const who = pn(state, whoActs(state));
  const head = `Turn ${t.number} (round ${t.round}), ${pn(state, t.activePlayerId)}, step ${t.step}, actions ${t.actionsUsed}/2`;
  if (!f) return `${head}: ${who} chooses an action.`;
  const what = {
    roll: `rolls the ${f.die} (${f.purpose})`, draw: `draws a ${f.deck} card (${f.reason})`, placeTroops: `places ${f.count} troop(s)`,
    resourceBuild: `builds the ${f.piece} or saves the card`, chooseProvince: { taxTroop: 'chooses the province that pays the tax troop', decreeLegion: 'chooses the province that sends the Decree legion', removedProvince: 'chooses the province the Emperor restores (18.q)', removedTroops: 'chooses where the removed troops go' }[f.purpose] ?? 'chooses where the survivors go',
    chooseBorrow: `chooses how many natives to borrow (0-${f.max})`, chooseBattleCards: 'chooses battle cards', choosePerk: 'chooses a general perk',
    responseWindow: { revoltResponse: `may play Kill Revolt leader! to stop the revolt in ${f.province}`, displeasedResponse: `may play Busy Little Bee! to redirect ${f.def}` }[f.window] ?? 'may sound the Horn of Titus Pullus or pass',
    discardCards: `loses ${f.count} saved card(s) to the Emperor's tax`, battleContinue: 'continues the battle or retreats', placeSurvivors: `places the survivors (up to ${f.maxBack} back)`,
  }[f.kind] ?? f.kind;
  return `${head}: ${who} ${what}.`;
}

const G = (n, w = 'Gold') => `${n} ${w}`;
const T = {
  rollOffResult: (e, st) => `${pn(st, e.pub.player)} rolls ${e.pub.value} in the roll-off (round ${e.pub.round}).`,
  rollOffTie: (e, st) => `Tie in the roll-off between ${e.pub.players.map(id => pn(st, id)).join(' and ')}: they roll again (round ${e.pub.round}).`,
  turnOrderSet: (e, st) => `Turn order: ${e.pub.order.map(id => pn(st, id)).join(', ')}.`,
  generalChosen: (e, st, d) => `${pn(st, e.pub.player)} takes ${d.generalsById[e.pub.general]?.name ?? e.pub.general}.`,
  startProvincesDealt: (e, st, d) => `Start provinces dealt: ${e.pub.assignments.map(a => pn(st, a.player) + ' ' + prov(d, a.province)).join(', ')} (distance ${e.pub.usedDistance}).`,
  startProvinceChosen: (e, st, d) => `${pn(st, e.pub.player)} starts in ${prov(d, e.pub.province)} with ${e.pub.troops} troops.`,
  startNativesRolled: (e, st, d) => `${prov(d, e.pub.province)} natives: d6 ${e.pub.d6}, ${e.pub.count}.`,
  senateDecree: (e) => `Senate Decree ${e.pub.number}: every player sends a legion against Carthage.`,
  revoltRollSkipped: (e, st) => `${pn(st, e.pub.player)} has no Revolt Roll (${e.pub.reason}).`,
  displeasedSkipped: (e, st) => `${pn(st, e.pub.player)} does not draw a Rome Is Displeased card (${e.pub.reason}).`,
  displeasedDrawn: (e, st) => `${pn(st, e.pub.player)} draws Rome Is Displeased: ${e.pub.def}.`,
  cardDiscarded: (e, st) => `${pn(st, e.pub.player)} discards ${e.pub.def} (${e.pub.reason}).`,
  allyCrossingPaid: (e, st, d) => `${pn(st, e.pub.player)} pays ${G(e.pub.gold)} to cross ${e.pub.crossed.map(c => prov(d, c)).join(', ')}.`,
  garrisonStatusChanged: (e, st, d) => `${prov(d, e.pub.province)} now has ${e.pub.own} (minimum ${e.pub.min}): ${e.pub.underGarrisoned ? 'UNDER-GARRISONED' : 'garrisoned'}.`,
  carthageRegainedSpirit: () => 'Carthage regains its spirit (not defeated any more).',
  survivorsLost: (e, st, d) => `${e.pub.n} survivor(s) of ${prov(d, e.pub.from)} are lost (${e.pub.reason}).`,
  taxTroopSkipped: (e, st) => `${pn(st, e.pub.player)} pays nothing (${e.pub.reason}).`,
  deckEmpty: (e) => `The ${e.pub.deck} deck is empty: nothing is drawn.`,
  gameCreated: (e, st) => `Game created (seed ${e.pub.seed}): ${e.pub.players.map(p => p.name).join(', ')}.`,
  diceRolled: (e, st) => `${pn(st, e.actor)} rolled ${e.pub.value} on ${e.pub.die} (${e.pub.purpose}).`,
  turnStarted: (e, st) => `--- Turn ${e.pub.number}, round ${e.pub.round}: ${pn(st, e.pub.player)} ---`,
  stepStarted: (e, st) => `${pn(st, e.pub.player)}: ${e.pub.step} step.`,
  bonusTroopsGranted: (e, st, d) => `${pn(st, e.pub.player)} gets +1 troop in ${prov(d, e.pub.province)} (20.b).`,
  nativesHealed: (e, st, d) => `The natives of ${prov(d, e.pub.province)} are back to ${e.pub.present}.`,
  cardDrawn: (e, st) => `${pn(st, e.pub.player)} draws a ${e.pub.deck} card${e.priv ? ' (' + e.priv.def + ')' : e.pub.def ? ' (' + e.pub.def + ')' : ''}.`,
  resourceApplied: (e, st) => `${pn(st, e.pub.player)}'s Resource card ${e.pub.def}: ${G(e.pub.gold ?? 0)}, ${e.pub.troops ?? 0} troop(s) to place.`,
  troopsPlaced: (e, st, d) => `${pn(st, e.pub.player)} places ${e.pub.n} troop(s) in ${prov(d, e.pub.province)}.`,
  roadBuilt: (e, st, d) => `${pn(st, e.pub.player)} builds a Road in ${prov(d, e.pub.province)}${e.pub.free ? ' (free)' : ''}.`,
  wallBuilt: (e, st, d) => `${pn(st, e.pub.player)} builds a Wall in ${prov(d, e.pub.province)} facing ${prov(d, e.pub.facing)}${e.pub.free ? ' (free)' : ''}.`,
  resourceSaved: (e, st) => `${pn(st, e.pub.player)} saves the ${e.pub.piece} card.`,
  gameRollResolved: (e) => `Game Roll: ${e.pub.value} (${e.pub.kind}).`,
  rewardGranted: (e, st, d) => `${pn(st, e.pub.player)} earns ${e.pub.reward} from ${prov(d, e.pub.province)} (number ${e.pub.number}).`,
  rewardDenied: (e, st, d) => `${pn(st, e.pub.player)}'s ${prov(d, e.pub.province)} earns nothing: ${e.pub.reason}.`,
  romeRoll: (e, st) => `Rome Roll for ${pn(st, e.pub.roller)} (${e.pub.number}).`,
  romeTaxPaid: (e, st) => e.pub.nothing ? `${pn(st, e.pub.player)} pays nothing (${e.pub.reason}).` : e.pub.troop ? `${pn(st, e.pub.player)} pays a troop to Roma from ${e.pub.from}.` : `${pn(st, e.pub.player)} pays ${G(e.pub.gold)} to ${e.pub.to === 'roma' ? 'the Roma pile' : pn(st, e.pub.to)}.`,
  romaGoldConverted: (e) => `Roma pile: 2 Gold became a troop (Roma ${e.pub.romaTroops}, pile ${e.pub.goldPile}).`,
  revoltRoll: (e, st, d) => `Revolt Roll ${e.pub.value}: ${e.pub.provinces.length ? e.pub.provinces.map(p => prov(d, p)).join(', ') + ' revolt' : 'nothing revolts'}.`,
  provinceRevolted: (e, st, d) => `${prov(d, e.pub.province)} revolts: minimum ${e.pub.minimum}, ${e.pub.killed} killed, ${e.pub.survivors} survive.`,
  survivorsMoved: (e, st, d) => `${e.pub.n} survivor(s) go to ${prov(d, e.pub.to)}${e.pub.general ? ' with the general' : ''}.`,
  prestigeChanged: (e, st) => `${pn(st, e.pub.player)} Prestige ${e.pub.from} → ${e.pub.to} (${e.pub.reason}).`,
  cardPlayed: (e, st) => `${pn(st, e.pub.player)} plays ${e.pub.def}${e.pub.inPlay ? ' (in play)' : ''}.`,
  troopsMoved: (e, st, d) => `${pn(st, e.pub.player)} moves ${e.pub.troops} troop(s)${e.pub.general ? ' and the general' : ''}: ${e.pub.path.map(p => prov(d, p)).join(' → ')}.`,
  troopsBought: (e, st, d) => `${pn(st, e.pub.player)} buys a troop in ${prov(d, e.pub.province)}.`,
  gameCardBought: (e, st, d) => `${pn(st, e.pub.player)} buys a Game Card (troop from ${prov(d, e.pub.from)}).`,
  nativesRolled: (e, st, d) => `${prov(d, e.pub.province)}: d6 ${e.pub.d6}, ${e.pub.count} natives.`,
  provinceAllied: (e, st, d) => `${pn(st, e.pub.player)} allies with ${prov(d, e.pub.province)} using ${e.pub.troops} troops.`,
  actionSpent: (e) => `(action ${e.pub.used} of ${e.pub.of}: ${e.pub.action})`,
  unusedActionGold: (e, st) => `${pn(st, e.pub.player)} left ${e.pub.unused} action(s) unused: +${G(e.pub.gold)}.`,
  startProvinceGold: (e, st, d) => `${pn(st, e.pub.player)}'s unbeaten start province ${prov(d, e.pub.province)} pays +${G(e.pub.gold)}.`,
  gameRollRerolled: (e) => `Early-game protection: ${e.pub.value} is rolled again (Game Roll ${e.pub.rollNo} of this player).`,
  revoltImmune: (e, st, d) => `${prov(d, e.pub.province)} has ${e.pub.troops} troops and does not revolt.`,
  romaCapLost: (e) => `Roma is full (${e.pub.cap}): ${e.pub.lost} troop(s) lost${e.pub.reason ? ' (' + e.pub.reason + ')' : ''}.`,
  deckReshuffled: (e) => `The ${e.pub.deck} discard pile is shuffled into a new draw pile (${e.pub.cards} cards).`,
  cardReshuffled: (e, st) => `${pn(st, e.pub.player)} may hold only one ${e.pub.def}: it is shuffled back and ${pn(st, e.pub.player)} draws again.`,
  discardShuffledUnder: (e, st) => `Only cards ${pn(st, e.pub.player)} may not hold are left in the draw pile: the discard pile is shuffled, ${pn(st, e.pub.player)} draws a card from it and the other ${e.pub.underneath} go under the draw pile (Q78).`,
  catapultBought: (e, st) => `${pn(st, e.pub.player)} buys a Catapult (now ${e.pub.catapults}).`,
  classicStartsChecked: (e, st, d) => e.pub.ok ? `Classic starts: ${e.pub.assignments.map(a => pn(st, a.player) + ' in ' + prov(d, a.province)).join(', ')}.` : `Classic starts too close (${e.pub.tooClose.map(p => p.map(x => prov(d, x)).join('-')).join(', ')}): start provinces are dealt at random (15.i, 20.o).`,
  attackDeclared: (e, st, d) => `${pn(st, e.pub.player)} ATTACKS ${prov(d, e.pub.target)}${e.pub.defender ? ' (' + pn(st, e.pub.defender) + ')' : ''} from ${prov(d, e.pub.from)} with ${e.pub.troops} troop(s)${e.pub.general ? ' and the general' : ''}${e.pub.sea ? ' by sea' : ''}${e.pub.via ? ' through ' + prov(d, e.pub.via) : ''}.`,
  borrowDecided: (e, st, d) => `${pn(st, e.pub.player)} borrows ${e.pub.count} of up to ${e.pub.max} native(s) of ${prov(d, e.pub.from)}.`,
  battleCardsCommitted: (e, st) => `${pn(st, e.pub.player)} (${e.pub.role}) commits ${e.pub.n} battle card(s).`,
  battleCardsSkipped: (e) => `The ${e.pub.role} plays no battle cards (${e.pub.reason}).`,
  perkChosen: (e, st) => `${pn(st, e.pub.player)} uses ${e.pub.perk}.`,
  generalPerkTriggered: (e) => `General perk (${e.pub.general}): ${e.pub.effect}${e.pub.reason ? ' (' + e.pub.reason + ')' : ''}.`,
  enemyFled: (e, st, d) => `${e.pub.n} ${e.pub.side} troop(s) of ${pn(st, e.pub.owner) === 'nobody' ? 'the natives' : pn(st, e.pub.owner)} flee from ${prov(d, e.pub.province)} before the battle (Caesar).`,
  reinforcementsCalled: (e, st, d) => `${pn(st, e.pub.player)} sounds the Horn: ${e.pub.troops} troop(s)${e.pub.general ? ' and the general' : ''} from ${prov(d, e.pub.from)} reinforce ${prov(d, e.pub.to)}.`,
  hornSkipped: (e, st, d) => !e.priv ? `${pn(st, e.pub.player)}: no reinforcements (18.y).` : `${pn(st, e.pub.player)} holds Horn of Titus Pullus but ${e.priv.reason === 'romaFull' ? `Roma already has 20 troops, so no reinforcements can come (12.k)` : e.priv.reason === 'notUnderGarrisoned' ? `${prov(d, e.pub.target)} is not under-garrisoned (Q85)` : `no bordering province of theirs can send troops to ${prov(d, e.pub.target)} (each must keep 1 troop; a held Roma keeps 10)`}: the Horn is not offered.`,
  responsePassed: (e, st) => `${pn(st, e.pub.player)} passes (${e.pub.window}).`,
  loyaltyDefected: (e) => `Ingrained Loyalty d6 ${e.pub.d6}: ${e.pub.defected} troop(s) defect (${e.pub.own} own, ${e.pub.borrowed} borrowed)${e.pub.wholeArmy ? ': the whole army is gone' : ''}.`,
  battleStarted: (e, st, d) => `Battle for ${prov(d, e.pub.target)}: ${e.pub.attacker} attacker(s)${e.pub.borrowed ? ' incl. ' + e.pub.borrowed + ' borrowed' : ''} vs ${e.pub.defender} defender(s).`,
  battleRoundRolled: (e) => `Round ${e.pub.round}: attacker rolls ${e.pub.attacker.dice.join(',') || '-'}, defender rolls ${e.pub.defender.dice.join(',') || '-'}.`,
  battleDiceAdjusted: (e) => `Dice modified (${e.pub.adjustments.map(a => `${a.why ?? a.source ?? a.reason ?? JSON.stringify(a)} ${a.delta > 0 ? '+' : ''}${a.delta}`).join(', ')}): attacker ${e.pub.attackerFinal.join(',')}, defender ${e.pub.defenderFinal.join(',')}.`,
  casualtiesApplied: (e) => `Attacker losses: ${e.pub.borrowed} borrowed, ${e.pub.own} own.`,
  battleRoundResolved: (e) => `Round ${e.pub.round}: attacker loses ${e.pub.attackerLoss}, defender loses ${e.pub.defenderLoss} (now ${e.pub.attackerTroopsAfter} vs ${e.pub.defenderTroopsAfter}).`,
  bothSidesZero: () => 'Both sides are wiped out: the defender keeps 1 troop (Q20).',
  nativesReduced: (e, st, d) => `${prov(d, e.pub.province)} natives ${e.pub.from} → ${e.pub.to} (${e.pub.reason}).`,
  fledTroopJoined: (e, st) => `The fled troop joins ${pn(st, e.pub.to)}.`,
  fledTroopReturned: (e, st, d) => `The fled troop returns to ${prov(d, e.pub.province)}.`,
  battleEnded: (e, st) => `Battle over after ${e.pub.rounds} round(s): ${e.pub.outcome}${e.pub.winner && e.pub.winner !== 'defender' ? ', ' + pn(st, e.pub.winner) + ' wins' : ''}.`,
  retreated: (e, st, d) => `${pn(st, e.pub.player)} retreats${e.pub.beforeRound1 ? ' before round 1 is rolled' : ''} to ${prov(d, e.pub.to)} with ${e.pub.own} troop(s).`,
  battleCardsReturned: (e, st, d) => `${pn(st, e.pub.player)} keeps the unused battle cards because the attacker retreated ${e.pub.round ? 'in round ' + e.pub.round : 'before round 1'}: ${cardList(d, e.pub.cards)} (17.k, 18.i).`,
  battleCardsSpent: (e, st, d) => `${pn(st, e.pub.player)}'s queued ${cardList(d, e.pub.cards)} ${e.pub.cards.length > 1 ? 'are' : 'is'} spent with the battle (18.i).`,
  survivorsPlaced: (e, st, d) => `${pn(st, e.pub.player)} keeps ${e.pub.stay} in ${prov(d, e.pub.target)} and sends ${e.pub.back} back to ${prov(d, e.pub.origin)}${e.pub.general ? (e.pub.generalBack ? '; the general goes back too' : '; the general stays') : ''}.`,
  provinceConquered: (e, st, d) => `${pn(st, e.pub.player)} conquers ${prov(d, e.pub.province)}${e.pub.from ? ' from ' + pn(st, e.pub.from) : ''} (${e.pub.troops} troops${e.pub.underGarrisoned ? ', UNDER-GARRISONED' : ''}).`,
  provinceLost: (e, st, d) => `${pn(st, e.pub.player)} loses ${prov(d, e.pub.province)}.`,
  generalEscaped: (e, st, d) => `${pn(st, e.pub.player)}'s general escapes from ${prov(d, e.pub.from)} to ${prov(d, e.pub.to)}.`,
  startIncomeLost: (e, st, d) => `${pn(st, e.pub.player)}'s start province ${prov(d, e.pub.province)} is lost: no more start income.`,
  romaHeld: (e, st) => `${pn(st, e.pub.player)} HOLDS ROMA: ${e.pub.troops} troops (${e.pub.survivorsInRoma} survivors stay, ${e.pub.sentBack} sent back).`,
  carthageDefeated: (e, st) => `${pn(st, e.pub.player)} defeats Carthage: Decree numbers now count as Rome Rolls.`,
  carthageBack: (e) => `Roma has fallen: Carthage is back as a normal native province with ${e.pub.troops} troops, open to attack (16.n).`,
  extraRevoltRollTriggered: (e, st) => `Borrowed natives died: ${pn(st, e.pub.player)} makes an extra Revolt Roll.`,
  decreeLegionSent: (e, st, d) => `${pn(st, e.pub.player)} sends a legion from ${prov(d, e.pub.from)}.`,
  decreeLegionSkipped: (e, st) => `${pn(st, e.pub.player)} sends no legion (${e.pub.reason}).`,
  decreeBattle: (e) => `The Senate's ${e.pub.legions} legion(s) attack Carthage (${e.pub.carthage} defenders).`,
  decreeResolved: (e) => `Senate Decree resolved: ${e.pub.result}.`,
  carthageNeutral: (e) => `Carthage is destroyed and becomes neutral with ${e.pub.troops} troops; ${e.pub.survivorsToRoma} survivor(s) go to Roma.`,
  carthageHealed: (e) => `Carthage heals ${e.pub.healed} (now ${e.pub.troops}).`,
  playerEliminated: (e, st) => `${pn(st, e.pub.player)} holds no province and is OUT of the game.`,
  revoltInspired: (e, st, d) => `${pn(st, e.pub.player)} plays Revolt! on ${pn(st, e.pub.owner)}'s ${prov(d, e.pub.province)}: it rolls a revolt now.`,
  revoltBlocked: (e, st, d) => `${pn(st, e.pub.player)} kills the revolt leader: ${prov(d, e.pub.province)} does not revolt.`,
  troopsAssassinated: (e, st, d) => `${pn(st, e.pub.player)}'s assassins kill ${e.pub.n} of ${e.pub.owner ? pn(st, e.pub.owner) + "'s troops" : 'the natives'} in ${prov(d, e.pub.province)} (${e.pub.left} left).`,
  cardSold: (e, st, d) => `${pn(st, e.pub.player)} sells ${d.cardDefsById[e.pub.card]?.name ?? e.pub.card} for ${e.pub.gold} Gold (from the bank, not an action).`,
  generalMoved: (e, st, d) => `${pn(st, e.pub.player)}'s general moves from ${prov(d, e.pub.from)} to ${prov(d, e.pub.to)} (free, once per turn).`,
  allyBribed: (e, st, d) => `${pn(st, e.pub.player)} bribes ${prov(d, e.pub.province)} away from ${pn(st, e.pub.from)} for ${G(e.pub.gold)}: ${e.pub.switched} troop switches sides, ${e.pub.lost} lost, ${e.pub.fled} flee.`,
  displeasedRedirected: (e, st) => `${pn(st, e.pub.player)} plays Busy Little Bee! (${G(e.pub.gold)} to ${e.pub.goldTo === 'roma' ? 'Roma' : pn(st, e.pub.goldTo)}): ${pn(st, e.pub.to)} suffers ${e.pub.def} instead.`,
  displeasedNoEffect: (e, st) => `${e.pub.def}: no effect on ${pn(st, e.pub.player)} (${e.pub.reason}).`,
  generalRecalled: (e, st) => `${pn(st, e.pub.player)}'s general is recalled to Rome: no general perks through turn ${e.pub.throughTurn}.`,
  goldConfiscated: (e, st) => `The Emperor confiscates ${G(e.pub.lost)} from ${pn(st, e.pub.player)} (${e.pub.left} left)${e.pub.poverty ? '; poverty costs 1 Prestige' : ''}.`,
  provinceRemoved: (e, st, d) => `The Emperor removes ${pn(st, e.pub.player)} from ${prov(d, e.pub.province)}: it is unconquered again (no Prestige lost)${e.pub.carthageRegainedSpirit ? '; Carthage regains its spirit' : ''}.`,
  troopsStolen: (e, st) => `The Emperor steals ${e.pub.total} bonus troop(s) from ${pn(st, e.pub.player)}: ${e.pub.toRoma} go to Roma.`,
  cardsTaxed: (e, st) => `The Emperor taxes ${pn(st, e.pub.player)}: ${e.pub.n} card(s) lost (${e.pub.defs.join(', ')}).`,
  turnEnded: (e, st) => `${pn(st, e.pub.player)} ends turn ${e.pub.number}.`,
  gameWon: (e, st) => e.pub.lastStanding ? `*** ${pn(st, e.pub.player)} WINS as the last player standing ***` : `*** ${pn(st, e.pub.player)} WINS with ${e.pub.prestige} Prestige ***`,
};
export const FORMATTED_EVENT_TYPES = Object.keys(T);
export function formatEvent(e, state, data) {
  const f = T[e.type];
  let text; try { text = f ? f(e, state, data) : `${e.type} ${JSON.stringify(e.pub)}`; } catch { text = `${e.type} ${JSON.stringify(e.pub)}`; }
  return { seq: e.seq, text, rule: e.rule, type: e.type };
}
export const logLines = s => s.steps.flatMap(step => step.events.map(e => formatEvent(e, step.state, s.data)));

/** The running battle or Senate Decree for the console panel (M2), or null. Dice hint: the order the rigged dice are used in. */
export function battlePanel(state, data) {
  const b = state.battle; const d = state.decree;
  if (!b && !d) return null;
  if (!b) return { title: 'Senate Decree: legions gathering', lines: [`Legions so far: ${d.legions} (${d.senders.map(id => pn(state, id)).join(', ') || 'none'}); still to send: ${d.queue.map(id => pn(state, id)).join(', ') || 'none'}.`], diceHint: null };
  const tp = state.provinces[b.target];
  const def = b.def.kind === 'natives' ? tp.native.present ?? 0 : tp.troops;
  const lines = [
    `${b.mode === 'decree' ? 'Decree legions (' + pn(state, b.att.player) + ' rolls)' : pn(state, b.att.player) + ' from ' + prov(data, b.att.from)} vs ${b.def.player ? pn(state, b.def.player) : b.def.kind === 'roma' ? 'Roma' : 'natives'} in ${prov(data, b.target)}${b.sea ? ' (by sea)' : ''}${b.via ? ' via ' + prov(data, b.via) : ''}.`,
    `Round ${b.round || '-'} · stage ${b.stage} · attackers ${b.att.own}${b.att.borrowed ? ' + ' + b.att.borrowed + ' borrowed' : ''}${b.att.general ? ' + general' : ''} vs defenders ${def}${b.def.general ? ' + general' : ''}.`,
  ];
  const extras = [];
  if (b.att.perk && b.att.perk !== 'none') extras.push('Scipio perk: ' + b.att.perk);
  if (b.att.elephants || b.def.elephants) extras.push(`Elephants: attacker ${b.att.elephants}, defender ${b.def.elephants}`);
  if (b.att.queue.length || b.def.queue.length) extras.push(`Moral boosts waiting: attacker ${b.att.queue.length}, defender ${b.def.queue.length}`);
  if (b.wallRollsIgnored) extras.push(`Walls ignored for rolls 1-${b.wallRollsIgnored}`);
  if (b.fled) extras.push(`a ${b.fled.side === 'def' ? 'defender' : 'attacker'} has fled (Caesar)`);
  if (extras.length) lines.push(extras.join(' · ') + '.');
  for (const r of b.rounds.slice(-3)) lines.push(`Round ${r.round}: ${r.attackerFinal.join(',')} vs ${r.defenderFinal.join(',')} → attacker -${r.attackerLoss}, defender -${r.defenderLoss}.`);
  const f = topFrame(state);
  let diceHint = null;
  if (f?.kind === 'roll' && f.purpose === 'battleRound') diceHint = `Rig ${f.dice.attacker + f.dice.defender} dice: the ${f.dice.attacker} attacker dice first, then the ${f.dice.defender} defender dice (e.g. ${[...Array(f.dice.attacker).fill(6), ...Array(f.dice.defender).fill(1)].join(',')}). ${f.dice.defenderReasons.join('; ')}.`;
  else if (f?.kind === 'roll' && f.purpose === 'loyalty') diceHint = 'Rig 1 die (d6): that many troops defect to Roma (max ' + data.rules.romaLoyaltyMaxDefect + ').';
  return { title: b.mode === 'decree' ? 'Senate Decree battle against Carthage' : `Battle for ${prov(data, b.target)}`, lines, diceHint };
}

export function provinceRows(state, data) {
  return data.provinces.map(def => {
    const p = state.provinces[def.id];
    const min = p.owner && p.status === 'conquered' ? minGarrison(state, data, def.id).min : null;
    return {
      id: def.id, name: def.name, number: p.number, reward: p.reward, owner: p.owner ? pn(state, p.owner) : '', ownerId: p.owner, status: p.status,
      troops: p.owner || def.id === 'roma' ? p.troops : null, natives: p.native.count === null ? '?' : `${p.native.present}/${p.native.count}`,
      min, under: p.owner ? isUnderGarrisoned(state, data, def.id) : false, road: !!p.road, walls: p.walls.map(w => prov(data, w)).join(', '),
    };
  });
}
export function playerRows(state, data) {
  return state.players.map(p => ({
    id: p.id, name: p.name, color: p.color, gold: p.gold, prestige: p.prestige, general: p.general ? `${data.generalsById[p.general.id].name} @ ${p.general.at ? prov(data, p.general.at) : '-'}${p.generalRecalledThroughTurn !== null && state.turn.number <= p.generalRecalledThroughTurn ? ` (recalled to Rome: no perks through turn ${p.generalRecalledThroughTurn})` : ''}` : '-',
    hand: p.hand.map(c => state.cards[c.uid].def), inPlay: p.inPlay.map(c => state.cards[c.uid].def), saved: p.savedResources.map(c => state.cards[c.uid].def),
    active: state.phase === 'turn' && state.turn.activePlayerId === p.id,
    generalId: p.general?.id ?? null, catapults: p.items?.catapult ?? 0, out: !!p.out,
  }));
}
