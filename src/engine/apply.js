// applyAction: the one entry point that changes a game (PLAN 4.0). Pure: the caller's state is never mutated (a structured clone is changed
// and returned). Illegal actions never throw: they return {state (the SAME object), events: [], error:{code, message, rule}}.
import { EngineError, makeCtx, mustPlayer, topFrame, settle } from './core.js';
import { ACTIONS } from './actions.js';

function gate(ctx, spec, action) {
  const s = ctx.state;
  const err = (code, message, rule = null) => { throw new EngineError(code, message, rule); };
  if (spec.setup && s.phase !== 'setup') err('NOT_SETUP', 'This action is only legal during setup.');
  if (spec.frame) {
    const f = topFrame(s);
    if (!f) err('NO_FRAME', `${action.type} has nothing to resolve: the game is not waiting for it.`);
    if (!spec.frame.includes(f.kind)) err('WRONG_FRAME', `${action.type} does not answer the current prompt (${f.kind}).`);
    if (!f.resolvableBy.includes(action.playerId)) err('NOT_YOUR_PROMPT', `The current prompt (${f.kind}) is for ${f.resolvableBy.join(', ')}, not ${action.playerId}.`);
  }
  if (spec.turn) {
    if (s.phase !== 'turn') err('NOT_IN_TURN', 'The game is not in a turn.');
    if (s.pending.length) err('PENDING_FRAME', `Finish the current prompt (${topFrame(s).kind}) first.`);
    if (s.turn.activePlayerId !== action.playerId) err('NOT_YOUR_TURN', `It is ${s.turn.activePlayerId}'s turn.`);
    if (s.turn.step !== 'actions') err('WRONG_STEP', `This is only legal in the Actions step (now: ${s.turn.step}).`, '17.a');
  }
}

/**
 * @param {object} state  game state (may be deep-frozen)
 * @param {{type:string, playerId:string}} action
 * @param {{data:object, dice?:number[]}} opts  `data` is the validated data bundle; `dice` is the rigged-dice test queue (consumed in place)
 * @returns {{state:object, events:object[], error?:{code:string, message:string, rule:string|null}}}
 */
export function applyAction(state, action, opts = {}) {
  const { data, dice = null } = opts;
  if (!data) throw new Error('applyAction: opts.data (the validated data bundle) is required');
  try {
    if (!action || typeof action.type !== 'string') throw new EngineError('BAD_ACTION', 'An action needs a string `type`.');
    if (state.phase === 'finished') throw new EngineError('GAME_FINISHED', 'The game is over.', '12.e');
    const spec = ACTIONS[action.type];
    if (!spec) throw new EngineError('UNKNOWN_ACTION', `Unknown action type "${action.type}".`);
    if (typeof action.playerId !== 'string') throw new EngineError('BAD_ACTION', 'An action needs the acting `playerId`.');
    // the log is append-only and its events are never changed after they are emitted, so the draft shares them and only copies the
    // array (M3 speedup: cloning a 5,000-event log on every action made long games quadratic)
    const { log, ...rest } = state;
    const draft = structuredClone(rest); draft.log = Array.isArray(log) ? log.slice() : log;
    const ctx = makeCtx(draft, data, { dice, actor: action.playerId });
    mustPlayer(draft, action.playerId);
    gate(ctx, spec, action);
    spec.run(ctx, action);
    settle(ctx);
    return { state: draft, events: ctx.events };
  } catch (e) {
    if (e instanceof EngineError) return { state, events: [], error: { code: e.code, message: e.message, rule: e.rule } };
    throw e;
  }
}

/** Convenience for UIs: an engine bound to one data bundle. */
export function createEngine(data, extra = {}) {
  return { data, applyAction: (state, action, opts = {}) => applyAction(state, action, { data, ...opts }), ...extra };
}
