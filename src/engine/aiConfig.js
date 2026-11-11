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
    burnBar: 0.1,           // v31.14: keep fighting (instead of retreating) while the defender has Elephants/Moral boosts an early retreat would refund (17.k) — v31.15: only when the AI's reserves cover the expected bleed, see ai.js battleContinue
    burnLossPerRound: 2,    // v31.15: expected attacker losses per round while fighting on to round 4 to burn the defender's cards — Tomas's own number: 8 troops over 4 rounds
  }),
  // v31.4: a rival this close to the win (public Prestige only) is a threat. Large Map 1 wins at 11, so ≥8; Small Map 1 wins at 8, so ≥5.
  threat: Object.freeze({
    within: 3,
    attackBias: 180,        // prefer that rival's Prestige-earning provinces; the win-chance bar above is not lowered
  }),
  // v31.4: surplus Gold with a free action should become troops instead of sitting in the pile
  spend: Object.freeze({
    surplusGold: 20,
    troopBias: 6,
  }),
  // v31.12: Easy (a gentler AI for a human opponent): the same bars and scores as Normal, but it holds back against HUMAN
  // players only — never Revolt!/Assassin! in the first 10 rounds, then a 50% coin flip each time it would play one, and at
  // most one attack on a human-owned province per turn. Against AI rivals it plays exactly like Normal.
  easy: Object.freeze({
    cardRestraintRounds: 10,   // no Revolt!/Assassin! vs a human before round 11 (a round = every player having had a turn)
    cardCoinFlip: 0.5,         // after that, half the time it holds the card instead
    maxHumanAttacksPerTurn: 1, // at most one attack on a human-owned province per turn (one battle = one attack)
  }),
});
export const aiConfig = (opts = {}) => (opts.config ? { ...AI_CONFIG, ...opts.config, attack: { ...AI_CONFIG.attack, ...(opts.config.attack ?? {}) } } : AI_CONFIG);
