// M8 (playtest batch 3, item 1): the AI's tunable numbers, kept apart from the rules (ruleset.json holds rules only, each with a rules.md label).
// One difficulty level (Q94). chooseAction(state, data, {config}) may override any of these (tests, future levels).
export const AI_CONFIG = Object.freeze({
  attack: Object.freeze({
    minWin: 0.6,            // start a battle only with at least this chance to conquer (fighting to the end, exact dice odds)
    minWinRoma: 0.7,        // a higher bar for Roma (Walls on all sides, Ingrained Loyalty, 12.i, 12.j) ... (Q108, Vidi 2026-10-22: 70%, was 80%)
    minWinCarthage: 0.7,    // ... and for Carthage (Walls on all sides, 16.n) (Q108: 70%, was 75%)
    minWinRival: 0.6,       // a rival's province: the same 60% as natives (Q108: "keep 60% for everything else"; was 62%)
    exposedOrigin: 0.08,    // + this when the attack leaves the origin under its minimum garrison (17.q) ...
    revoltRisk: 0.05,       // + this when it leaves a conquered origin open to a revolt (under 10 troops, 2+ conquered, 17.c, 19.h) ...
    counterAttack: 0.08,    // + this when a rival army next door (with a Road, 19.b) would then outnumber what stays behind
    maxBar: 0.92,           // the bar never goes above this
  }),
});
export const aiConfig = (opts = {}) => (opts.config ? { ...AI_CONFIG, ...opts.config, attack: { ...AI_CONFIG.attack, ...(opts.config.attack ?? {}) } } : AI_CONFIG);
