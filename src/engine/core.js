// Engine plumbing shared by setup, turn and actions (PLAN 4.0, 6.1, 7): errors, events, dice, frames, Prestige and the win check.
// Everything here works on a DRAFT state (a structured clone made by applyAction), never on the caller's state.
import { die, shuffle, int } from './rng.js';

/** An illegal action. Never escapes applyAction: it is turned into {state (unchanged), events: [], error}. */
export class EngineError extends Error {
  constructor(code, message, rule = null) { super(message); this.code = code; this.rule = rule; }
}
export const fail = (code, message, rule = null) => { throw new EngineError(code, message, rule); };
export const check = (cond, code, message, rule = null) => { if (!cond) fail(code, message, rule); };

/** ctx = {state (draft), data, events[], dice (rigged queue or null), actor}. */
export function makeCtx(state, data, { dice = null, actor = null } = {}) {
  return { state, data, events: [], dice, actor };
}

/** Appends an event to the result and to state.log (PLAN 6.1). `pub` is visible to everyone, `priv` only to `privTo`. */
export function emit(ctx, type, { actor = ctx.actor, rule = null, pub = {}, priv = null, privTo = [] } = {}) {
  const s = ctx.state;
  s.eventSeq += 1;
  const ev = { seq: s.eventSeq, turn: s.turn.number, type, actor: actor ?? null, rule, pub, priv, privTo };
  s.log.push(ev);
  ctx.events.push(ev);
  return ev;
}

/** Rolls one die from the game's RNG (or the test queue) and records it. The only place that rolls. */
export function roll(ctx, sides, purpose, player = null) {
  const value = die(ctx.state.rng, sides, ctx.dice);
  emit(ctx, 'diceRolled', { actor: player, pub: { die: 'd' + sides, value, purpose, drawIndex: ctx.state.rng.draws } });
  return value;
}

export function pushFrame(ctx, frame) {
  const s = ctx.state;
  s.frameSeq += 1;
  const f = { id: 'f' + s.frameSeq, resolvableBy: frame.player ? [frame.player] : s.players.map(p => p.id), ...frame };
  s.pending.push(f);
  return f;
}
export const topFrame = state => state.pending[state.pending.length - 1] ?? null;
export function popFrame(ctx) { return ctx.state.pending.pop(); }

export const playerOf = (state, id) => state.players.find(p => p.id === id);
export function mustPlayer(state, id) { const p = playerOf(state, id); if (!p) fail('UNKNOWN_PLAYER', `No player "${id}".`); return p; }

/** Player ids in turn order, starting with `first`. */
export function orderFrom(state, first) {
  const o = state.turnOrder; const i = o.indexOf(first);
  return i < 0 ? [...o] : [...o.slice(i), ...o.slice(0, i)];
}

/**
 * Prestige change (floor 0, Q47). The game ends the instant a player reaches the winning Prestige (12.e, Q47); the first player
 * who reaches it wins (the acting player when one event would give it to two).
 */
export function awardPrestige(ctx, pid, delta, reason, rule = '12.f') {
  const { state, data } = ctx;
  const p = mustPlayer(state, pid);
  const before = p.prestige;
  p.prestige = Math.max(0, p.prestige + delta);
  if (p.prestige === before) return;
  emit(ctx, 'prestigeChanged', { actor: pid, rule, pub: { player: pid, from: before, to: p.prestige, delta: p.prestige - before, reason } });
  if (p.prestige >= data.rules.winPrestige && state.winner === null) {
    state.winner = pid; state.phase = 'finished'; state.pending = [];
    emit(ctx, 'gameWon', { actor: pid, rule: '12.e', pub: { player: pid, prestige: p.prestige } });
  }
}

export const sortedIds = o => Object.keys(o).sort();

/** A used or spent card goes face up onto its own deck's discard pile (18.l, Vidi 2026-10-21; replaces "to the bottom"). */
export function toDiscard(state, uid) { state.discards[state.cards[uid].deck].push(uid); }

/**
 * Takes the top card of a draw pile. An empty draw pile is first rebuilt by shuffling its discard pile (18.l); returns null only when
 * both are empty (every card is held: drawing does nothing, Q46).
 */
export function drawTop(ctx, deck) {
  const { state } = ctx;
  if (!state.decks[deck].length && state.discards[deck].length) {
    state.decks[deck] = shuffle(state.rng, state.discards[deck]); state.discards[deck] = [];
    emit(ctx, 'deckReshuffled', { rule: '18.l', pub: { deck, cards: state.decks[deck].length } });
  }
  return state.decks[deck].shift() ?? null;
}

/** Puts a card back into its draw pile at a random position ("shuffled back", 18.t, 18.w). */
export function shuffleIn(state, uid) {
  const list = state.decks[state.cards[uid].deck];
  list.splice(int(state.rng, list.length + 1) - 1, 0, uid);
}

// ---- settle hooks: setup.js and turn.js register a function that moves the game on after an action (runs automatic steps until input is needed)
export const settleHooks = [];
export const onSettle = fn => { settleHooks.push(fn); };
/** Runs the hooks until none reports progress (a hook returns true when it changed something, e.g. pushed a frame or moved a step). */
export function settle(ctx) {
  for (let guard = 0; guard < 500; guard++) {
    let progressed = false;
    for (const fn of settleHooks) if (fn(ctx)) progressed = true;
    if (!progressed) return;
  }
  throw new Error('settle: no fixed point after 500 passes (engine bug)');
}
