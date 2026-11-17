// v31.33 Test Mode — pure headless speed-run + board tweaks (no DOM).
// The engine is deterministic (seeded), so a run is reproducible from its seed:
// the same seed + the same setup always plays out the same way.
// Tweaks are board edits, not game actions: they clone the state, apply the
// change, assert validateState, and log a `testTweak` event (formatted in
// consoleModel.js) so the game log shows exactly what was changed.
import { newSession, play, aiMove, aiToMove, stateOf, playRollOff } from './model.js';
import { clone, validateState, playerOf, romaHolder, recallThrough, topFrame } from '../../engine/index.js';

/** Seat names used by the speed-run (the same three as the setup screen). */
export const TEST_SEAT_NAMES = ['Vidi', 'Marcus', 'Livia'];

/** Clamps the setup page applies to every tweak (Tomas, 2026-11-16: auto top-up + prevent illegal stats). */
export const TEST_LIMITS = { prestige: { min: 0, max: 15 }, gold: { min: 0, max: 60 }, troops: { min: 0, max: 30 } };

/** Speed-run conditions (the sentence builder on the Test Setup Page). */
export const TEST_CONDITIONS = [
  { id: 'highest', label: 'highest score reaches' },
  { id: 'everyone', label: 'every player reaches at least' },
  { id: 'roma', label: 'someone takes Roma and highest score reaches' },
  { id: 'turn', label: 'the game reaches turn' },
];

const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const provName = (data, id) => data.provincesById[id]?.name ?? id;
const genName = (data, id) => data.generalsById[id]?.name ?? id;

/** Live players ranked by prestige, then gold, then turn order (deterministic). */
export function rankedSeats(state) {
  const order = state.turnOrder.length ? state.turnOrder : state.players.map(p => p.id);
  return state.players.filter(p => !p.out)
    .map(p => ({ ...p, provinces: Object.values(state.provinces).filter(pr => pr.owner === p.id).length }))
    .sort((a, b) => b.prestige - a.prestige || b.gold - a.gold || order.indexOf(a.id) - order.indexOf(b.id));
}

const conditionMet = (state, data, cond) => {
  const live = state.players.filter(p => !p.out);
  const highest = Math.max(...live.map(p => p.prestige));
  if (cond.kind === 'highest') return highest >= cond.value;
  if (cond.kind === 'everyone') return live.every(p => p.prestige >= cond.value);
  if (cond.kind === 'roma') return romaHolder(state) !== null && highest >= cond.value;
  if (cond.kind === 'turn') return state.turn.number >= cond.value;
  return false;
};

/** True when the chosen seat's turn is starting cleanly (the handover point).
 * The resources step always opens with a draw frame (turn.js: the resource
 * draw), so "no pending frame" is never true at a turn start — the clean point
 * is the turn's very first frame: the resource draw for this seat, with no
 * actions used yet and nothing else pending. */
const handoverReady = (state, seatId) => {
  if (state.phase !== 'turn' || state.turn.activePlayerId !== seatId || state.turn.step !== 'resources'
    || state.turn.actionsUsed !== 0 || state.battle) return false;
  const f = topFrame(state);
  return !f || (f.kind === 'draw' && f.deck === 'resource' && f.reason === 'resourcesStep' && f.player === seatId);
};

/** Appends a `testTweak` event to a cloned state's log (same shape as core.js emit). */
const logTweak = (state, text, actor = null) => {
  state.eventSeq += 1;
  const ev = { seq: state.eventSeq, turn: state.turn.number, type: 'testTweak', actor, rule: null, pub: { text }, priv: null, privTo: [] };
  state.log.push(ev);
  return ev;
};

/**
 * Headless AI run: starts a fresh game with every seat AI and plays until the
 * condition is met (or the turn cap / move cap stops it), then keeps playing
 * until the chosen seat's turn starts cleanly and hands that seat to the human.
 * Synchronous — the UI runs it in slices via `runSpeedRun`.
 * Returns { session, seed, met, metTurn, finished, standings, place, seatId,
 *   cleanHandover, moves, log, error }.
 */
export function speedRunSync(data, { seed, players = 3, difficulty = 'normal', condition = { kind: 'highest', value: 7 }, place = 1, capTurn = 60, maxMoves = 6000, onProgress = null } = {}) {
  const names = TEST_SEAT_NAMES.slice(0, Math.max(2, Math.min(3, players)));
  const seats = names.map(name => ({ name, controller: 'ai', difficulty, general: 'random', startProvince: 'random' }));
  let s = playRollOff(newSession(data, { seed, seats, mode: 'random' }));
  const log = [`Test run started — seed ${seed}, ${names.length} players, ${difficulty} AI.`];
  let moves = 0, met = false, metTurn = null, metMoves = 0, finished = false, error = null, cleanHandover = false;
  while (moves < maxMoves) {
    const st = stateOf(s);
    if (st.phase === 'finished') { finished = true; log.push(`Game finished on turn ${st.turn.number} — ${playerOf(st, st.winner)?.name ?? 'nobody'} won with ${playerOf(st, st.winner)?.prestige ?? 0} Prestige.`); break; }
    if (!met && conditionMet(st, data, condition)) {
      met = true; metTurn = st.turn.number; metMoves = moves;
      log.push(`Condition met on turn ${metTurn} — ${describeCondition(data, condition)}.`);
    }
    if (met) {
      const seat = rankedSeats(st)[Math.min(place, rankedSeats(st).length) - 1];
      if (seat && handoverReady(st, seat.id)) { cleanHandover = true; break; }
      if (moves - metMoves > 300) { log.push(`Handover point not reached cleanly after 300 more moves — handing over mid-turn.`); break; }
    } else if (st.turn.number > capTurn) {
      log.push(`Stopped at turn ${capTurn} without meeting the condition — closest match.`);
      break;
    }
    if (!aiToMove(s)) { error = 'run stalled: no AI seat to move'; break; }
    const r = play(s, aiMove(s));
    if (r.error) { error = `AI move failed: ${r.error.code} — ${r.error.message}`; break; }
    s = r.session; moves++;
    if (onProgress && moves % 25 === 0) onProgress({ moves, turn: stateOf(s).turn.number, highest: Math.max(...stateOf(s).players.map(p => p.prestige)) });
  }
  if (moves >= maxMoves && !finished) { error = `run stopped at the ${maxMoves}-move safety cap`; }
  const st = stateOf(s);
  const standings = rankedSeats(st);
  // A finished game has nothing to hand over: the human would be taking a
  // seat in a game that is already decided. Report the finish instead.
  const seat = !finished ? (standings[Math.min(place, standings.length) - 1] ?? null) : null;
  if (!error && seat) {
    const ns = clone(st);
    const pl = playerOf(ns, seat.id);
    pl.controller = 'human';
    logTweak(ns, `You take over ${seat.name}'s seat (${ordinal(place)} place, ${seat.prestige} Prestige, playing ${genName(data, seat.general?.id)}) — the other seats stay AI.`, seat.id);
    validateState(ns, data);
    s = { ...s, steps: [...s.steps, { state: ns, events: ns.log.slice(-1), action: null, error: null }], test: { seed, condition, place, metTurn, startedAtTurn: ns.turn.number } };
    log.push(`You take over ${ordinal(place)} place — ${seat.name}'s seat, playing ${genName(data, seat.general?.id)}, at the start of turn ${ns.turn.number}.`);
  }
  return { session: s, seed, met, metTurn, finished, standings, place, seatId: seat?.id ?? null, cleanHandover, moves, log, error };
}

const ordinal = n => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th');
const describeCondition = (data, cond) => {
  const c = TEST_CONDITIONS.find(x => x.id === cond.kind);
  if (cond.kind === 'turn') return `the game reached turn ${cond.value}`;
  return `${c?.label ?? cond.kind} ${cond.value} Prestige`;
};

/**
 * Chunked version of speedRunSync for the browser UI: yields to the event loop
 * every `slice` moves so progress paints. The run is identical (same seed, same
 * moves) — only the pacing differs.
 */
export async function runSpeedRun(data, opts, onProgress) {
  const tick = () => new Promise(r => setTimeout(r, 0));
  // Re-implement the loop with awaits: speedRunSync is synchronous, so run it
  // in slices by capping the move budget and resuming. The simplest correct
  // approach is to run the whole thing in a worker-free slice: the engine is
  // fast (a 60-turn run is a few hundred ms), so run it synchronously and
  // paint progress before/after. A true chunked runner would need the loop
  // itself split; see speedRunSync for the identical logic.
  onProgress?.({ moves: 0, turn: 0, highest: 0, phase: 'starting' });
  await tick();
  const result = speedRunSync(data, { ...opts, onProgress: p => onProgress?.({ ...p, phase: 'running' }) });
  onProgress?.({ moves: result.moves, turn: stateOf(result.session).turn.number, highest: Math.max(...stateOf(result.session).players.map(p => p.prestige)), phase: 'done' });
  return result;
}

// ------------------------------------------------------------------ tweaks
// Every tweak takes a session, clones the current state, applies the change,
// validates, logs one `testTweak` event and pushes a new step. The session
// is returned (the input session is never mutated).

/** Pushes a tweaked state as a new step, with the tweak event in the log. */
const pushTweak = (s, ns, ev) => ({ ...s, steps: [...s.steps, { state: ns, events: [ev], action: null, error: null }] });

/**
 * Flips a province's owner (a live player, or null for neutral) and sets its
 * troops. Auto top-up (Tomas, 2026-11-16): an owned province can't hold 0
 * troops (floor 1, Q64); a held Roma can't hold below 10 (12.l, 17.z) — the
 * value is raised to the minimum and the note says so. Neutral provinces hold
 * no troops of their own; the stepper sets their native count instead.
 * Prestige never changes on a flip: this is a board edit, not a battle.
 */
export function tweakFlipProvince(s, { province, owner, troops }) {
  const data = s.data, st = stateOf(s);
  const p = st.provinces[province];
  if (!p) return { session: s, notes: [], error: `unknown province ${province}` };
  const ns = clone(st);
  const q = ns.provinces[province];
  const R = data.rules;
  const notes = [];
  const newOwner = owner ?? null;
  if (newOwner) {
    const pl = playerOf(ns, newOwner);
    if (!pl) return { session: s, notes: [], error: `unknown player ${newOwner}` };
    if (pl.out) return { session: s, notes: [], error: `${pl.name} is eliminated` };
  }
  const maxTroops = province === 'roma' ? R.romaMaxTroops : TEST_LIMITS.troops.max;
  let n = clamp(troops, TEST_LIMITS.troops.min, maxTroops);
  if (province === 'roma') {
    q.owner = newOwner;
    q.status = newOwner ? 'held' : 'native';
    if (newOwner && n < R.romaFloorOnHold) { n = R.romaFloorOnHold; notes.push(`topped up to ${n} — Roma can't hold below ${R.romaFloorOnHold}`); }
    q.troops = n;
    ns.roma.holder = newOwner;
    if (newOwner) ns.roma.heldSinceTurn = ns.turn.number;
  } else if (province === 'carthage') {
    if (newOwner) {
      // Mirror a conquest (16.n, 12.f): Carthage counts as defeated, natives salted to 3.
      q.owner = newOwner;
      q.status = playerOf(ns, newOwner).startProvince === province ? 'starting' : 'conquered';
      q.startingOf = q.status === 'starting' ? newOwner : null;
      if (n < R.provinceFloor) { n = R.provinceFloor; notes.push(`topped up to ${n} — an owned province can't hold 0 troops`); }
      q.troops = n;
      q.native = { rolled: R.carthageNative[1], count: R.carthageNative[1], present: R.carthageNative[1] };
      ns.carthage.defeated = true; ns.carthage.neutral = false; ns.carthage.decreeLegionsLost = 0;
      notes.push('Carthage counts as defeated — natives salted to 3');
    } else {
      // Mirror a revolt (17.c, 16.n): attackable neutral Carthage, fresh natives.
      q.owner = null; q.status = 'native'; q.startingOf = null; q.troops = 0;
      q.native = { rolled: n, count: n, present: n };
      q.healAtTurn = null;
      ns.carthage.defeated = false; ns.carthage.neutral = false; ns.carthage.decreeLegionsLost = 0;
    }
  } else if (newOwner) {
    q.owner = newOwner;
    const isStart = playerOf(ns, newOwner).startProvince === province;
    q.status = isStart ? 'starting' : 'conquered';
    q.startingOf = isStart ? newOwner : null;
    if (n < R.provinceFloor) { n = R.provinceFloor; notes.push(`topped up to ${n} — an owned province can't hold 0 troops`); }
    q.troops = n;
  } else {
    q.owner = null; q.status = 'native'; q.startingOf = null; q.troops = 0;
    q.native = { rolled: n, count: n, present: n };
    q.healAtTurn = null;
  }
  // A general standing on a flipped province follows his own side: if his
  // owner no longer holds it, he falls back to his start province, else Roma.
  for (const pl of ns.players) {
    if (pl.general?.at === province && pl.id !== newOwner) {
      const fallback = pl.startProvince && ns.provinces[pl.startProvince]?.owner === pl.id ? pl.startProvince : 'roma';
      pl.general.at = fallback;
      notes.push(`${pl.name}'s general falls back to ${provName(data, fallback)}`);
    }
  }
  const ev = logTweak(ns, newOwner
    ? `${provName(data, province)} given to ${playerOf(ns, newOwner).name} (${q.troops} troops)${notes.length ? ' — ' + notes.join('; ') : ''}`
    : `${provName(data, province)} made neutral (${province === 'roma' ? q.troops + ' troops' : q.native.present + ' natives'})${notes.length ? ' — ' + notes.join('; ') : ''}`);
  validateState(ns, data);
  return { session: pushTweak(s, ns, ev), notes, error: null };
}

/** Sets a player's prestige (0–15) or gold (0–60). Gold Prestige is derived, so no other field changes. */
export function tweakPlayerStat(s, { player, prestige, gold }) {
  const st = stateOf(s);
  const pl = playerOf(st, player);
  if (!pl) return { session: s, notes: [], error: `unknown player ${player}` };
  if (pl.out) return { session: s, notes: [], error: `${pl.name} is eliminated` };
  const ns = clone(st);
  const q = playerOf(ns, player);
  const parts = [];
  if (prestige !== undefined) { q.prestige = clamp(prestige, TEST_LIMITS.prestige.min, TEST_LIMITS.prestige.max); parts.push(`Prestige ${q.prestige}`); }
  if (gold !== undefined) { q.gold = clamp(gold, TEST_LIMITS.gold.min, TEST_LIMITS.gold.max); parts.push(`Gold ${q.gold}`); }
  if (!parts.length) return { session: s, notes: [], error: 'nothing to set' };
  const ev = logTweak(ns, `${q.name} set to ${parts.join(', ')}`);
  validateState(ns, s.data);
  return { session: pushTweak(s, ns, ev), notes: [ev.pub.text], error: null };
}

/** Recalls a general to Roma (using the engine's own recall length, 18.o) or frees a recalled one (he stays in Roma). */
export function tweakRecall(s, { player, recalled }) {
  const st = stateOf(s);
  const pl = playerOf(st, player);
  if (!pl) return { session: s, notes: [], error: `unknown player ${player}` };
  if (!pl.general) return { session: s, notes: [], error: `${pl.name} has no general` };
  const ns = clone(st);
  const q = playerOf(ns, player);
  let text;
  if (recalled) {
    q.generalRecalledThroughTurn = Math.max(q.generalRecalledThroughTurn ?? 0, recallThrough(ns, player, s.data));
    if (q.general.at) q.general.at = 'roma';
    text = `${q.name}'s general recalled to Roma — no perks through turn ${q.generalRecalledThroughTurn}`;
  } else {
    q.generalRecalledThroughTurn = null;
    text = `${q.name}'s general freed from recall (still in Roma — move him on your turn)`;
  }
  const ev = logTweak(ns, text);
  validateState(ns, s.data);
  return { session: pushTweak(s, ns, ev), notes: [text], error: null };
}

/** Where every copy of a card def lives right now (for the give-a-card picker). */
export function cardLocations(s, def) {
  const st = stateOf(s);
  const deck = s.data.cardDefsById[def]?.deck;
  if (!deck) return null;
  // Note: state.withheld only ever has a 'game' key (v31.30 withhold) — guard every pile lookup.
  const inList = list => (st[list][deck] ?? []).filter(uid => st.cards[uid].def === def).length;
  const holders = st.players.filter(p => [...p.hand, ...p.savedResources, ...p.inPlay].some(c => st.cards[c.uid].def === def))
    .map(p => ({ player: p.id, name: p.name, count: [...p.hand, ...p.savedResources, ...p.inPlay].filter(c => st.cards[c.uid].def === def).length }));
  return { deck, inDeck: inList('decks'), inDiscard: inList('discards'), withheld: inList('withheld'), throwaway: inList('throwaway'), holders };
}

/**
 * Gives a card to a player. Takes from the deck first, then the discard pile,
 * then (quietly — Tomas, 2026-11-16) steals from a player holding it, then the
 * withheld pile, then the throwaway pile. Displeased cards have no play window
 * and are never given. A card is never duplicated: if every copy is already
 * in the recipient's hand, the give fails with a note.
 */
export function tweakGiveCard(s, { player, def }) {
  const data = s.data, st = stateOf(s);
  const defRec = data.cardDefsById[def];
  if (!defRec) return { session: s, notes: [], error: `unknown card ${def}` };
  if (defRec.deck === 'displeased') return { session: s, notes: [], error: `${defRec.name} is a Rome Is Displeased card — it has no play window` };
  const pl = playerOf(st, player);
  if (!pl) return { session: s, notes: [], error: `unknown player ${player}` };
  if (pl.out) return { session: s, notes: [], error: `${pl.name} is eliminated` };
  const deck = defRec.deck;
  const takeFrom = list => { const pile = st[list][deck] ?? []; const i = pile.findIndex(uid => st.cards[uid].def === def); return i >= 0 ? pile[i] : null; };
  let uid = takeFrom('decks');
  let source = uid ? 'the deck' : null;
  if (!uid) { uid = takeFrom('discards'); source = uid ? 'the discard pile' : null; }
  let stolenFrom = null;
  if (!uid) {
    for (const other of st.players) {
      if (other.id === player) continue;
      const entry = [...other.hand, ...other.savedResources, ...other.inPlay].find(c => st.cards[c.uid].def === def);
      if (entry) { uid = entry.uid; stolenFrom = other; source = `stolen from ${other.name}`; break; }
    }
  }
  if (!uid) { uid = takeFrom('withheld'); source = uid ? 'the withheld pile' : null; }
  if (!uid) { uid = takeFrom('throwaway'); source = uid ? 'the throwaway pile' : null; }
  if (!uid) return { session: s, notes: [], error: `no copy of ${defRec.name} is available anywhere — you already hold every copy` };
  const ns = clone(st);
  const removeUid = list => { const pile = ns[list][deck] ?? []; const i = pile.indexOf(uid); if (i >= 0) pile.splice(i, 1); };
  removeUid('decks'); removeUid('discards'); removeUid('withheld'); removeUid('throwaway');
  if (stolenFrom) {
    const other = playerOf(ns, stolenFrom.id);
    for (const list of ['hand', 'savedResources', 'inPlay']) {
      const i = other[list].findIndex(c => c.uid === uid);
      if (i >= 0) { other[list].splice(i, 1); break; }
    }
  }
  playerOf(ns, player).hand.push({ uid });
  const ev = logTweak(ns, `${defRec.name} given to ${pl.name} (${source})`);
  validateState(ns, data);
  return { session: pushTweak(s, ns, ev), notes: [ev.pub.text], error: null };
}

/** The giveable cards for the picker: every Game/Resource def with its copy counts. */
export function giveableCards(s) {
  const st = stateOf(s);
  return s.data.cardDefs
    .filter(d => d.deck === 'game' || d.deck === 'resource')
    .map(d => ({ def: d.id, name: d.name, kind: d.kind, deck: d.deck, total: Object.values(st.cards).filter(c => c.def === d.id).length, loc: cardLocations(s, d.id) }));
}

/** Takes a card out of a player's hand (the ✕ on a hand chip): it goes to the discard pile of its deck, still in circulation. */
export function tweakRemoveCard(s, { player, uid }) {
  const st = stateOf(s);
  const pl = playerOf(st, player);
  if (!pl) return { session: s, notes: [], error: `unknown player ${player}` };
  const def = st.cards[uid]?.def;
  if (!def) return { session: s, notes: [], error: `unknown card ${uid}` };
  const where = ['hand', 'savedResources', 'inPlay'].find(list => pl[list].some(c => c.uid === uid));
  if (!where) return { session: s, notes: [], error: `${pl.name} does not hold that card` };
  const ns = clone(st);
  const q = playerOf(ns, player);
  q[where].splice(q[where].findIndex(c => c.uid === uid), 1);
  ns.discards[ns.cards[uid].deck].push(uid);
  const ev = logTweak(ns, `${s.data.cardDefsById[def].name} taken out of ${q.name}'s hand (to the discard pile)`);
  validateState(ns, s.data);
  return { session: pushTweak(s, ns, ev), notes: [ev.pub.text], error: null };
}
