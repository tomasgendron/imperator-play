// Handler registry (PLAN 5.5). M0: the DECLARED handler names (what data/*.json may reference) and the
// registration functions. The implementations arrive in M1-M3 (`effects/*.js`, `perks/*.js`, `decree.js`).
// A test fails when data names an undeclared handler or a declared handler is used by no data.

export const DECLARED = Object.freeze({
  effect: Object.freeze([
    'battleModifier', 'inspireRevolt', 'killTroops', 'blockRevolt', 'gainPrestige', 'bribeAlly', 'enableRomaAttack',
    'gainResources', 'freeBuild', 'recallGeneral', 'confiscateGold', 'removeFromProvince', 'stealTroopsToRoma', 'taxSavedCards',
    'redirectDispleased', 'callReinforcements',
  ]),
  perk: Object.freeze(['caesarFlee', 'scipioExtraDie', 'seaMaster', 'fightToTheDeath', 'disciplinedAdvance']),
  decree: Object.freeze(['carthageDecree']),
});

export const PERK_HOOKS = Object.freeze(['battleStart', 'diceCount', 'dieAdjust', 'battleEnd', 'roadRequirement', 'wallBonus']);

const impl = { effect: new Map(), perk: new Map(), decree: new Map(), frame: new Map() };

function reg(kind, name, handler) {
  if (kind !== 'frame' && !DECLARED[kind].includes(name)) throw new Error(`registry: ${kind} handler "${name}" is not declared in registry.js DECLARED`);
  if (impl[kind].has(name)) throw new Error(`registry: ${kind} handler "${name}" registered twice`);
  impl[kind].set(name, handler);
}
export const registerEffect = (name, handler) => reg('effect', name, handler);
export const registerPerk = (name, handler) => reg('perk', name, handler);
export const registerDecree = (name, handler) => reg('decree', name, handler);
export const registerFrameResolver = (kind, fn) => reg('frame', kind, fn);
export const getEffect = name => impl.effect.get(name);
export const getPerk = name => impl.perk.get(name);
export const getDecree = name => impl.decree.get(name);
export const getFrameResolver = kind => impl.frame.get(kind);
export const isDeclared = (kind, name) => DECLARED[kind]?.includes(name) ?? false;
/** Names declared but without an implementation yet (shrinks to [] by the end of M3). */
export const unimplemented = () => Object.entries(DECLARED).flatMap(([kind, names]) => names.filter(n => !impl[kind].has(n)).map(n => `${kind}:${n}`));
