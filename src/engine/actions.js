// Action table (PLAN 4). Each entry: { frame: [kinds] | undefined, turn: true | undefined, setup: true | undefined, run(ctx, action) }.
// Milestone M1.1 declares every action type of PLAN 4 so unknown types and not-yet-built ones answer with a clear error code;
// M1.2 (setup), M1.3 (turn) and M2/M3 (battle, cards) replace the placeholders through `define`.
import { fail } from './core.js';

export const ACTION_TYPES = Object.freeze([
  'ROLL', 'DRAW_CARD', 'END_TURN', 'MOVE', 'ATTACK', 'ALLY', 'BUY_TROOP', 'BUY_GAME_CARD', 'BUILD_ROAD', 'BUILD_WALL',
  'PLAY_CARD', 'USE_SAVED_RESOURCE', 'PREVIEW_TARGET', 'PLACE_TROOPS', 'RESOURCE_BUILD', 'CHOOSE_PROVINCE', 'PASS', 'CHOOSE_PERK',
  'BATTLE_CARDS_DONE', 'APPLY_PLUS_ONE', 'CHOOSE_BORROW', 'BATTLE_CONTINUE', 'BATTLE_RETREAT', 'CHOOSE_BATTLE_CARDS',
  'CHOOSE_START_PROVINCE', 'CHOOSE_SIDE', 'CHOOSE_GENERAL', 'BUY_CATAPULT', 'CALL_REINFORCEMENTS', 'PLACE_SURVIVORS',
  'DISCARD_CARDS',   // M3: Emperor taxes you! (18.u, Q44)
  'MOVE_GENERAL', 'SELL_CARD',   // M7: free general move (15.j), selling cards (20.p)
]);

const MILESTONE = {
  ATTACK: 'M2', PLAY_CARD: 'M3', PASS: 'M3', CHOOSE_PERK: 'M2', BATTLE_CARDS_DONE: 'M2', APPLY_PLUS_ONE: 'M2', CHOOSE_BORROW: 'M2',
  BATTLE_CONTINUE: 'M2', BATTLE_RETREAT: 'M2', CHOOSE_BATTLE_CARDS: 'M2',
};

export const ACTIONS = {};
for (const t of ACTION_TYPES) ACTIONS[t] = { notImplemented: true, run: () => fail('NOT_IMPLEMENTED', `${t} is not built yet (milestone ${MILESTONE[t] ?? 'M1'}).`) };

/** Replaces a placeholder with the real implementation. */
export function define(type, spec) {
  if (!ACTION_TYPES.includes(type)) throw new Error('define: unknown action type ' + type);
  ACTIONS[type] = spec;
}

// ROLL is one action whose effect depends on the frame's `purpose` (PLAN 4.4): setup.js and turn.js register their purposes here.
export const rollHandlers = {};
export const defineRoll = (purpose, fn) => { if (rollHandlers[purpose]) throw new Error('defineRoll: duplicate purpose ' + purpose); rollHandlers[purpose] = fn; };
define('ROLL', {
  frame: ['roll'],
  run(ctx) {
    const f = ctx.state.pending[ctx.state.pending.length - 1];
    const h = rollHandlers[f.purpose];
    if (!h) fail('NOT_IMPLEMENTED', `Roll purpose "${f.purpose}" is not built yet.`);
    h(ctx, f);
  },
});
