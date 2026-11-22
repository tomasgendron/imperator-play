// Pure model of the M5 game page: no DOM, so `node --test` drives exactly what the page shows and clicks.
// The page keeps a console session (src/ui/consoleModel.js) and asks this module who looks at the screen, what a human may do
// now (grouped for the phase bar, the map and the builder), what a card looks like, which sounds an event plays, and how a save file reads.
import { legalActions, whoActs, topFrame, validateState, SCHEMA_VERSION, redactEvents, minGarrison, cardBlock, attackBlock, attackOriginBlock, roadNetwork, shipSegments, goldPrestige, alliedRewardNeed, roadCost, shuffleIn, attForce, defForce, generalPerksActive, generalRecalled, generalMoveTargets, recallMoveTargets, fleeOptions, effectiveActionsPerTurn } from '../../engine/index.js';
import { newSession, play, aiToMove, aiMove, stateOf, current, formatEvent, describePrompt } from '../consoleModel.js';

export { newSession, play, aiToMove, aiMove, stateOf, describePrompt };
export { roadNetwork, shipSegments, goldPrestige, recallMoveTargets };
export const HOW_TO_WIN = {
  title: 'How to Win',
  paragraphs: [
    'Welcome to IMPERATOR! Lead your General to expand Rome’s reach through conquest and alliances, earning Prestige as you bring new provinces into the Empire. Build roads and establish trade routes to Roma to grow your wealth—and turn that wealth into Prestige.',
    'But power brings danger. Grow too strong and Roma may punish you, costing you valuable assets. Leave your provinces poorly garrisoned and they may revolt, stripping away your gains and Prestige. Fortune can change your standing, for better or worse, so build carefully and protect what you’ve earned.',
    'Whether through force of arms, shrewd alliances, or clever trade, reach the Prestige target first to become Imperator!',
  ],
  prestige: 'How to earn Prestige: 1 per conquered province except Carthage/Roma; Carthage 2 TOTAL; Roma 3 TOTAL; 1 per Prestige Game Card; 1 per 20 Gold held counted at end of turn.',
};
export function fullLogText(state, data) {
  const events = state?.log ?? [];
  const lines = events.map(e => {
    const f = formatEvent(e, state, data);
    return `T${e.turn ?? 0}\t#${e.seq}\t${e.type}\t${f.text}${e.rule ? ' (' + e.rule + ')' : ''}`;
  });
  return { count: events.length, text: lines.join('\n') + (lines.length ? '\n' : ''), truncated: false };
}
export const SAVE_SCHEMA = 'imperator.save.v1';
/** Rolls every seat's roll-off die (Q2, ties again) in a new session; the game then goes on to the generals and the starts. */
export function playRollOff(s) {
  for (let k = 0; k < 50 && !stateOf(s).turnOrder?.length; k++) {
    const f = topFrame(stateOf(s)); if (!f || f.kind !== 'roll' || f.purpose !== 'rollOff') break;
    const r = play(s, { type: 'ROLL', playerId: f.player }); if (r.error) throw new Error(r.error.message); s = r.session;
  }
  return s;
}
/**
 * Q110 (Vidi 2026-10-22): Selected starts roll off FIRST. The engine's own roll-off (Q2, ties re-rolled) for `n` seats with this seed,
 * run on a throwaway game: the real game rolls the same dice (same seed, the roll-off is its first use of the dice), so the order shown on
 * the setup screen is the game's turn order. Returns {order: seat indexes in turn order, rolls: each seat's d10s (one per round)}.
 */
export function rollOffPreview(data, { seed, n }) {
  const s = playRollOff(newSession(data, { seed, names: Array.from({ length: n }, (_, i) => 'Seat ' + (i + 1)) }));
  const st = stateOf(s); const idx = id => st.players.findIndex(p => p.id === id);
  if (!st.turnOrder?.length) throw new Error('roll-off did not finish');
  return { seed, n, order: st.turnOrder.map(idx), rolls: st.players.map(p => [...st.setup.rollOff.keys[p.id]]) };
}
export const STEP_CHIPS = [['resources', 'Resources'], ['gameRoll', 'Game Roll'], ['revoltRoll', 'Revolt Roll'], ['actions', 'Actions']];

export const playerById = (state, id) => state.players.find(p => p.id === id) ?? null;
export const nameOf = (state, id) => playerById(state, id)?.name ?? (id ? id : 'nobody');
/** CSS colour class of a player: p1..p4 by seat index (the mockup palette). */
export const colorClass = (state, id) => { const i = state.players.findIndex(p => p.id === id); return i < 0 ? 'none' : 'p' + (i + 1); };
export const humans = state => state.players.filter(p => p.controller !== 'ai' && !p.out);
export const isHuman = (state, id) => !!id && playerById(state, id)?.controller !== 'ai';

/**
 * Who looks at the shared screen (Q95, Vidi 2026-10-21: no pass-the-screen curtain): the human who must decide now; else the active
 * human; else the previous viewer. null = nobody (an all-AI game): every hand stays hidden. AI hands are never shown.
 */
export function viewerFor(state, prev = null) {
  if (state.phase === 'finished') return prev;
  const w = whoActs(state);
  if (isHuman(state, w)) return w;
  const a = state.phase === 'turn' ? state.turn.activePlayerId : null;
  if (isHuman(state, a)) return a;
  if (prev && isHuman(state, prev)) return prev;
  const humans = state.players.filter(p => !p.out && isHuman(state, p.id));   // M6.1: a loaded human-vs-AI game during an AI turn
  return humans.length === 1 ? humans[0].id : null;
}

/** The legal moves of the human `pid` right now (empty when someone else decides). */
export function humanLegal(state, data, pid) {
  if (!pid || state.phase === 'finished' || whoActs(state) !== pid) return [];
  const f = topFrame(state);
  if (f && f.kind === 'roll' && !f.player) return [];   // an automatic deal/roll with nobody to ask: the page runs it itself
  return legalActions(state, data).filter(d => d.playerId === pid || d.action.playerId === pid);
}
/** v31.22: an off-turn Game Card draw that the controller resolves by itself (no Draw click). True only for a human who is NOT the
 *  active turn player: the defender's battle-won card (battle.js, reason 'battleWon') and a Game Roll reward card (turn.js,
 *  reason 'reward'). On-turn draws — the roller's own reward card, the Resources step, a purchase — return null and keep the
 *  Draw click, as do Rome Is Displeased draws and any draw for an AI seat (the AI already resolves its own). Returns the
 *  DRAW_CARD descriptor, so the automatic draw is exactly the action a manual click would send (same seeded-RNG draw). */
export function offTurnDraw(state, data) {
  const f = topFrame(state);
  if (!f || f.kind !== 'draw' || f.deck !== 'game') return null;
  if (f.reason !== 'battleWon' && f.reason !== 'reward') return null;
  if (state.phase !== 'turn' || !state.turn) return null;
  if (f.player === state.turn.activePlayerId) return null;
  if (!isHuman(state, f.player)) return null;
  return humanLegal(state, data, f.player).find(d => d.type === 'DRAW_CARD') ?? null;
}
/** v31.27 (Update 4): resolve every pending off-turn Game Card draw in `session` right now, with no popup involved.
 *  The controller calls this inside apply(), before the events animate, so an off-turn draw no longer waits behind the
 *  Game Roll popup: that popup is sticky whenever a human rolls (gameRollPopup: `sticky: rollerHuman`), and apply()
 *  cannot finish — so schedule() and its 400 ms humanAuto timer cannot run — until somebody clicks OK. Online that
 *  left the non-rolling human's reward card undrawn (the guest can never fix it herself: the host resolves every
 *  human seat's off-turn draw). Each draw here is the exact DRAW_CARD action a click would send (offTurnDraw), so the
 *  seeded-RNG card is identical; the returned `events` are the draws' own events, in order, for the caller to animate
 *  with the rest of the batch (the card-reveal flip still shows, after the popup is dismissed). The roller's own reward
 *  card, on-turn draws and AI seats are untouched (offTurnDraw returns null for them), and a session with no off-turn
 *  draw comes back unchanged. At most 10 draws: a chain cannot run away. */
export function resolveOffTurnDraws(session, data) {
  let s = session; const events = []; const drew = [];
  for (let k = 0; k < 10; k++) {
    const d = offTurnDraw(stateOf(s), data);
    if (!d) break;
    const reason = topFrame(stateOf(s))?.reason ?? null;
    const r = play(s, d.action);
    if (r.error) break;   // a legal descriptor cannot fail; never spin on it
    s = r.session; events.push(...(current(s).events ?? [])); drew.push({ player: d.action.playerId, reason });
  }
  return { session: s, events, drew };
}

/** v26.1 (the stuck Revolt Roll): null while the game can go on; otherwise why it cannot: a pending prompt with no legal move for
 *  anyone (whoever must act has none). The page flags it at once (with a save to send) instead of leaving a silent dead end. */
export function deadEnd(state, data) {
  if (!state || state.phase === 'finished' || state.phase === 'setup' && !state.pending?.length) return null;
  const f = topFrame(state); const w = whoActs(state);
  if (!f && state.phase !== 'turn') return null;
  if (legalActions(state, data).length) return null;
  const what = f ? `${f.kind}${f.purpose ? ' (' + f.purpose + ')' : f.window ? ' (' + f.window + ')' : ''}` : 'the free part of the turn';
  return { frame: f?.kind ?? 'free', who: w ?? null, text: `Nobody can act on ${what}${w ? ` (it waits for ${nameOf(state, w)})` : ''}.` };
}
/** Applies a range value to a descriptor's action. */
export const withValue = (d, v) => (d.range ? { ...d.action, [d.range.field]: Math.max(d.range.min, Math.min(d.range.max, Number(v))) } : d.action);

const CATS = {
  ATTACK: 'move', ALLY: 'move', MOVE: 'move', BUY_TROOP: 'buy', BUY_GAME_CARD: 'buy', BUY_PRESTIGE: 'buy', BUY_CATAPULT: 'build',   // M6: the Catapult is built on the Build screen (item 9)
 
  BUILD_ROAD: 'build', BUILD_WALL: 'build', BUY_MERCHANT_SHIP: 'build', MOVE_MERCHANT_SHIP: 'build', USE_SAVED_RESOURCE: 'build', PLAY_CARD: 'card', PREVIEW_TARGET: 'scout', END_TURN: 'end',
  SELL_CARD: 'sell', MOVE_GENERAL: 'general', RECALL_MOVE_GENERAL: 'general',   // M7: free moves with their own buttons (20.p, 15.j); v31.38: the recall placement (18.o)
};
/** Free-step legal moves grouped for the phase-bar buttons: {move, buy, build, card, scout, end, other}. */
export function categorize(legal) {
  const out = { move: [], buy: [], build: [], card: [], scout: [], end: [], sell: [], general: [], other: [] };
  for (const d of legal) out[CATS[d.type] ?? 'other'].push(d);
  return out;
}
/** The provinces a descriptor is about (for map highlights and map clicks). */
export function provincesOf(d) {
  const a = d.action; const out = [];
  for (const k of ['province', 'from', 'fromProvince', 'target', 'to', 'facing']) if (typeof a[k] === 'string') out.push(a[k]);
  if (Array.isArray(a.placements)) for (const p of a.placements) out.push(p.province);
  if (Array.isArray(a.kills)) for (const p of a.kills) out.push(p.province);
  return [...new Set(out)];
}
/** The main province of a descriptor (where a map click selects it). */
export const mainProvince = d => d.action.province ?? d.action.fromProvince ?? d.action.target ?? d.action.to ?? d.action.from ?? (d.action.placements?.[0]?.province) ?? null;
export const forProvince = (legal, id) => legal.filter(d => provincesOf(d).includes(id));
/** v31.31 (Updates 4–5): the rows a province tap/click may offer. ATTACK entries are gone — the "Attack here from …"
 *  flow is the only attack path — and so are the Assassin! shortcut rows: play the card from your hand instead.
 *  Everything else the province offers (Ally, Move, Revolt!, Bribe the Ally!, builds, previews) stays. An Assassin!
 *  play is a PLAY_CARD whose action carries `kills` — no other descriptor does. */
export function isAssassinPlay(d) {
  return d?.type === 'PLAY_CARD' && Array.isArray(d?.action?.kills);
}
export const provinceSheetActs = (legal, id) => forProvince(legal, id).filter(d => d.type !== 'END_TURN' && d.type !== 'ATTACK' && !isAssassinPlay(d));

/**
 * The attack / ally / move builder (PLAN 10.8) from the legal list: origins -> destinations -> variants (with or without the general).
 * Every variant is a real legal descriptor, so the builder can never send an illegal action.
 */
export function builderTree(legal, type) {
  const tree = {};
  for (const d of legal.filter(x => x.type === type)) {
    const from = d.action.from, to = d.action.target ?? d.action.to;
    ((tree[from] ??= {})[to] ??= []).push(d);
  }
  return tree;
}
export const builderVariant = (variants, withGeneral) => variants.find(d => !!d.action.withGeneral === !!withGeneral) ?? variants[0];

/** A card as the page shows it (style-3 art carries the printed name and text; only battle cards get the Battle Card label). */
export function cardView(data, def, uid = null) {
  const c = data.cardDefsById[def];
  return { uid, def, name: c?.name ?? def, text: c?.text ?? '', deck: c?.deck ?? 'game', battle: c?.type === 'battle', art: 'card.' + def };
}
export const BATTLE_LABEL = 'Battle Card';

/**
 * Batch 6 item 2 (Vidi 2026-10-25): what each deck holds, for the start and lobby screens. Built from the card DATA only (never a game
 * state), so it shows nothing about the order of a deck or anyone's hand: one entry per card type, with its number of copies.
 */
export const DECK_TITLES = { game: ['Game deck', 'Game'], resource: ['Resource deck', 'Resource'], displeased: ['Rome Is Displeased deck', 'Displeased'] };
export function deckCatalog(data) {
  return Object.entries(DECK_TITLES).map(([key, [title, short]]) => {
    const cards = (data.decks[key] ?? []).map(c => ({ ...cardView(data, c.id), copies: c.copies ?? 1 }));
    return { key, title, short, cards, total: cards.reduce((n, c) => n + c.copies, 0) };
  });
}

/** Batch 5 item 4: the battle-card step as a checklist, one checkbox per card held ({def: n} from the chooseBattleCards frame). */
export function battleCardChecklist(data, held) {
  return Object.entries(held ?? {}).flatMap(([def, n]) => Array.from({ length: n }, (_, i) => ({ def, i, id: `${def}#${i}`, ...cardView(data, def) })));
}
/** The CHOOSE_BATTLE_CARDS descriptor for the ticked boxes (`ticked` = list of defs, one entry per ticked copy), or null. */
export function battleCardsChoice(legal, ticked) {
  const want = {}; for (const d of ticked) want[d] = (want[d] ?? 0) + 1;
  const same = c => { const a = c ?? {}; const ks = new Set([...Object.keys(a), ...Object.keys(want)]); return [...ks].every(k => (a[k] ?? 0) === (want[k] ?? 0)); };
  return legal.find(d => d.type === 'CHOOSE_BATTLE_CARDS' && same(d.action.cards)) ?? null;
}

/**
 * v31.29 (Update 3): the summon row on the defender's battle-cards screen. The checklist commit and the summon are separate
 * moves, so the summon is its own button, built from the SUMMON_GENERAL descriptor in the legal list (its data-key is what
 * the desktop's wireOptions matches, and the mobile sheet wires it by id). '' when no summon is offered, so the checklist
 * renders exactly as before. Both UIs use this one helper, so the button cannot drift between them.
 */
export function summonButtonHtml(legal, { cls = 'btn gold', id = '', disabled = false } = {}) {
  const d = legal.find(x => x.type === 'SUMMON_GENERAL');
  if (!d) return '';
  return `<button class="${escHtml(cls)}"${id ? ` id="${escHtml(id)}"` : ''}${disabled ? ' disabled' : ''} data-key="${escHtml(descKey(d))}">${escHtml(d.label)}</button>`;
}

/** M12: a hand as an array (a viewFor view gives another player's hand as {hidden, count}: no cards), its size, a deck's size. */
export const handCards = p => (Array.isArray(p?.hand) ? p.hand : []);
export const handCount = p => (Array.isArray(p?.hand) ? p.hand.length : (p?.hand?.count ?? 0));
export const deckCount = (state, k) => { const d = state.decks?.[k]; return Array.isArray(d) ? d.length : (d?.count ?? 0); };
/** Hand panel content for a viewer (never another player's cards; AI hands are always hidden, Q95). */
export function handFor(state, data, viewer) {
  const p = playerById(state, viewer);
  if (!p) return { owner: null, cards: [], inPlay: [], saved: [] };
  const v = uid => cardView(data, state.cards[uid].def, uid);
  return { owner: p.id, cards: handCards(p).map(c => v(c.uid)), inPlay: p.inPlay.map(c => v(c.uid)), saved: p.savedResources.map(c => v(c.uid)) };
}

/** Shared-screen log lines (8.3 log hygiene: the public view, so a private draw never prints its card). Newest first. */
export function logFor(state, data, limit = 250, viewer = null) {
  // the log is public, except a 'Horn not offered' line, which only its holder sees (it tells what is in the hand, Q95)
  const raw = state.log.slice(-limit * 2);
  const ev = redactEvents(raw, null).map((e, i) => (e.type === 'hornSkipped' && viewer && raw[i].privTo?.includes(viewer) ? { ...e, priv: raw[i].priv } : e))
    .filter(e => e.type !== 'actionSpent' && !(e.type === 'hornSkipped' && !e.priv));
  return ev.map(e => ({ ...formatEvent(e, state, data), cls: e.actor ? colorClass(state, e.actor) : 'sys' })).reverse().slice(0, limit);
}

/** Sounds for one event (PLAN 14 audio names; the page picks a random variant for names like card_draw). */
/**
 * v31.34 (Update 7): the toast when another player's Rome Roll pays Gold to the holder of Roma (16.j). Pure, so the
 * desktop and mobile pages share it. Returns the toast string, or null when there is nothing to ding about: no Gold
 * in the event (the holder's own roll, nothing: true; the troop variant), the tax went to Roma's Gold pile
 * (to: 'roma'), or the viewer is not the holder / is the payer themself.
 */
export function romaTaxNotice(state, viewerId, ev) {
  const p = ev?.pub;
  if (!p || p.gold == null || p.to !== viewerId || p.player === viewerId) return null;
  return `You earned ${p.gold} Gold from ${nameOf(state, p.player)} because you control Roma!`;
}

export function soundsFor(e, state = null) {
  switch (e.type) {
    case 'diceRolled': return [e.pub.die === 'd10' ? 'dice_roll_d10' : 'dice_roll_d6'];
    case 'cardDrawn': return ['card_draw'];
    case 'cardPlayed': case 'resourceCardUsed': return ['card_play'];
    case 'troopsMoved': case 'troopsPlaced': case 'survivorsMoved': return ['troops_move'];
    case 'attackDeclared': return ['attack_confirm'];
    case 'defenderFled': return ['troops_move'];
    case 'battleRoundRolled': return ['battle_round_start'];
    case 'provinceConquered': return ['conquest'];
    case 'provinceAllied': return ['ally_made'];
    case 'provinceRevolted': return ['revolt'];
    case 'romeRoll': return ['rome_roll'];
    case 'senateDecree': return ['senate_decree'];
    case 'deckReshuffled': case 'withheldCardsReleased': return ['deck_shuffle'];
    case 'prestigeChanged': return e.pub.to > e.pub.from ? ['prestige_gain'] : [];
    case 'rewardGranted': return /gold/i.test(e.pub.reward) ? ['gold_gain'] : [];
    case 'turnEnded': return ['end_turn'];
    case 'gameWon': return [!state || isHuman(state, e.pub.player) || humans(state).length === 0 ? 'victory' : 'defeat'];
    default: return [];
  }
}

/** Which step chip is current. */
export const stepIndex = state => (state.phase === 'turn' ? STEP_CHIPS.findIndex(([k]) => k === state.turn.step) : -1);

/** The frame a human answers, in words for the decision prompt. */
export function frameTitle(state, data) {
  const f = topFrame(state);
  if (!f) return null;
  const T = {
    roll: 'Roll the dice', draw: 'Draw a card', setupGeneral: 'Choose your general', setupSide: 'Choose your side (west or east)', setupStartProvince: 'Choose your start province',
    placeTroops: 'Place troops', resourceBuild: 'Build now or save the card', chooseProvince: { bribeReinforce: 'Reinforce your new ally', fleeDestination: 'Flee to…' }[f.purpose] ?? 'Choose a province', chooseBorrow: 'Borrow natives?',
    chooseBattleCards: 'Battle cards', choosePerk: 'General perk', battleContinue: 'Continue the battle?', placeSurvivors: 'Place the survivors',
    returnReinforcements: 'Send the Horn troops home?',
    discardCards: "The Emperor's tax (random)", responseWindow: { revoltResponse: 'A province revolts!', displeasedResponse: 'Rome is displeased with you', defenceAnnounced: 'You are attacked!', elephantPanic: 'Elephants! in the fight — panic one?' }[f.window] ?? 'Your answer',
  };
  return T[f.kind] ?? f.kind;
}

/** A save file (PLAN 8.6): the full state incl. RNG and hidden hands; a host file, not for sharing mid-game. */
export function makeSave(session, meta = {}) {
  const state = stateOf(session);
  return { schema: SAVE_SCHEMA, schemaVersion: state.schemaVersion, ruleset: session.data.ruleset?.id ?? null, seed: session.seed, snapshot: state, meta: { savedAt: new Date().toISOString(), ...meta } };
}
/** v31 (21.a): the map id of a save (object or JSON text); saves from before v31 carry none and are Small Map 1. */
export function saveMapId(input) {
  let o = input; if (typeof input === 'string') { try { o = JSON.parse(input); } catch { return 'small1'; } }
  return o?.snapshot?.config?.map ?? 'small1';
}
/** v31.39: the win target a save was made with (`state.config.winPrestige`), or null when the save has none or it is not
 * a usable integer 8–20 — the caller then uses the map default, so old saves load unchanged. */
export function saveWinPrestige(input) {
  let o = input; if (typeof input === 'string') { try { o = JSON.parse(input); } catch { return null; } }
  const w = o?.snapshot?.config?.winPrestige;
  return Number.isInteger(w) && w >= 8 && w <= 20 ? w : null;
}
/** Reads a save (object or JSON text); throws an Error that says what is wrong. Returns a fresh session at the saved state. */
/** Cards added to a deck after a save was made (18.z, v31.9): mint the missing copies with fresh uids (per-deck prefix + next number,
 * the same scheme as createBlankState) and shuffle them into that deck's draw pile (v31.11: they used to land at the bottom, where
 * draws off the top could not reach them until the deck nearly emptied), so the old save keeps loading with its own cards untouched.
 * The seeded RNG is used (shuffleIn), never Math.random — a save must reload the same way every time. A save that LOST cards
 * (a def removed or fewer copies) still fails validation below, as before. */
export function backfillNewCards(state, data) {
  if (!state || typeof state !== 'object' || !state.cards || !state.decks) return;
  const have = {};
  for (const c of Object.values(state.cards)) have[c.def] = (have[c.def] ?? 0) + 1;
  const nextNum = {};
  const noteUid = uid => { const m = /^([a-z])(\d+)$/.exec(uid); if (m) nextNum[m[1]] = Math.max(nextNum[m[1]] ?? 0, +m[2]); };
  for (const uid of Object.keys(state.cards)) noteUid(uid);
  // v31.30: also count uids still referenced in any pile (decks, discards, throwaway, withheld, hands, inPlay, savedResources).
  // A save that lost a card from the registry but still lists its uid somewhere must never get that number re-minted for a
  // different card — that is the g32/g33 double-count: the two Sneak Attacks were deleted from the registry yet still listed
  // in withheld.game, so backfill re-minted g32/g33 into the deck and validation saw each uid twice.
  for (const list of Object.values(state.decks)) for (const uid of list) noteUid(uid);
  for (const list of Object.values(state.discards ?? {})) for (const uid of list) noteUid(uid);
  for (const list of Object.values(state.throwaway ?? {})) for (const uid of list) noteUid(uid);
  for (const list of Object.values(state.withheld ?? {})) for (const uid of list) noteUid(uid);
  for (const p of state.players ?? []) for (const c of [...(p.hand ?? []), ...(p.inPlay ?? []), ...(p.savedResources ?? [])]) noteUid(c.uid);
  for (const deck of ['game', 'resource', 'displeased']) {
    const prefix = deck[0];
    for (const def of data.decks[deck]) {
      const missing = def.copies - (have[def.id] ?? 0);
      for (let i = 0; i < missing; i++) {
        const uid = prefix + String((nextNum[prefix] = (nextNum[prefix] ?? 0) + 1)).padStart(2, '0');
        state.cards[uid] = { def: def.id, deck };
        (state.decks[deck] ??= []); shuffleIn(state, uid);
        have[def.id] = (have[def.id] ?? 0) + 1;
      }
    }
  }
}
/** v31.30 (19.k): old saves hold one-sided Walls — a list with a single facing. The facing concept is gone, so a
 * province with any Wall at all now has a Wall on every border: fill `walls` with all its neighbours (sorted).
 * A province already listing every neighbour, or with no Wall, is untouched. Runs in readSave before validation;
 * the engine itself already treats any non-empty `walls` as a Wall (S.hasWall), so this only normalises the data. */
export function normaliseWalls(state, data) {
  if (!state?.provinces) return;
  for (const [id, p] of Object.entries(state.provinces)) {
    if (!p?.walls?.length) continue;
    const all = [...new Set([...(data.provincesById[id]?.land ?? []), ...(data.provincesById[id]?.sea ?? [])])].sort();
    if (p.walls.length !== all.length || p.walls.some(w => !all.includes(w))) p.walls = all;
  }
}
export function readSave(input, data) {
  let o = input;
  if (typeof input === 'string') { try { o = JSON.parse(input); } catch { throw new Error('This is not a JSON file.'); } }
  if (!o || o.schema !== SAVE_SCHEMA) throw new Error(`This is not an Imperator save (schema "${o?.schema ?? 'missing'}", expected "${SAVE_SCHEMA}").`);
  const state = o.snapshot; const made = o.meta?.appVersion ? ` It was made by ${o.meta.appVersion}.` : '';
  if (!state || typeof state !== 'object' || !Array.isArray(state.players)) throw new Error('This save has no game in it (the snapshot is missing).' + made);
  if (state.schemaVersion !== SCHEMA_VERSION) {
    if (state.schemaVersion < SCHEMA_VERSION) throw new Error(`This save was made by an older build (game format ${state.schemaVersion}; this build reads format ${SCHEMA_VERSION}), so it cannot be loaded.${made} The file itself is not changed. Start a new game, or run the build that made it.`);
    throw new Error(`This save was made by a newer build (game format ${state.schemaVersion}; this build reads format ${SCHEMA_VERSION}), so it cannot be loaded.${made} The file itself is not changed. Run the build that made it.`);
  }
  if (!Array.isArray(state.ships)) state.ships = [];   // v31.5: saves from before Merchant ships
  if (!state.throwaway) state.throwaway = { game: [], resource: [], displeased: [] };   // v31.11: saves from before the throwaway pile
  if (!state.withheld) state.withheld = { game: [] };   // v31.30: saves from before the withheld pile load as already released — the 5 cards are in the deck/discards/hands already, so nothing is held back mid-game
  for (const p of state.players) if (!['normal', 'easy'].includes(p.difficulty)) p.difficulty = 'normal';   // v31.12: saves from before AI difficulty
  for (const p of state.players) if (p.pendingStealToRoma === undefined) p.pendingStealToRoma = null;
  if (state.carthage && state.carthage.destroyedForGood === undefined) state.carthage.destroyedForGood = false;   // v31.36 (16.o): saves from before the flag load as not destroyed for good   // v31.24 (18.r, 18.x): saves from before the deferred steal
  if (!state.turn.aiHumanAttacks) state.turn.aiHumanAttacks = {};   // v31.12: saves from before the Easy attack budget
  backfillNewCards(state, data);   // v31.9 (18.z): saves from before a card was added to a deck gain the new cards, shuffled into that deck (v31.11)
  normaliseWalls(state, data);   // v31.30 (19.k): one-sided Walls in old saves become Walls on all sides
  let errs;
  try { errs = validateState(state, data); } catch (e) { errs = [e.message]; }
  if (errs.length) throw new Error(`This save does not fit this build's rules data, so it cannot be loaded safely.${made} The file itself is not changed. Details:\n` + errs.slice(0, 5).join('\n'));
  return { data, seed: o.seed ?? 'loaded', steps: [{ state, events: [], action: null, error: null }], ...(o.meta?.test ? { test: { ...o.meta.test } } : {}) };   // v31.33: a test save reloads as a test game (TEST badge, Test Setup button)
}
export const saveFileName = state => `imperator-${state.gameId ?? 'game'}-turn${state.turn?.number ?? 0}.json`;

/** A stable key for a legal descriptor (its action without the range field), so a click target and a test can name the same move. */
export function descKey(d) {
  const a = { ...d.action }; if (d.range) delete a[d.range.field];
  const sort = v => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(a));
}
/** The descriptor an action belongs to (range value inside the range), or null. */
export function findDesc(legal, action) {
  for (const d of legal) {
    const a = { ...action }; const v = d.range ? a[d.range.field] : null;
    if (descKey(d) !== descKey({ action: a, range: d.range })) continue;
    if (d.range && !(v >= d.range.min && v <= d.range.max)) continue;
    return d;
  }
  return null;
}

// ------------------------------------------------------------------ M6 (playtest batch 1): roll and revolt popups, sounds, build steps, attack preview
const provName = (data, id) => data.provincesById[id]?.name ?? id;
const after = (events, i, stop) => { const out = []; for (let k = i + 1; k < events.length && !stop(events[k]); k++) out.push(events[k]); return out; };

/**
 * The popup for a Game Roll (item 1): `events[i]` is a gameRollResolved event; the rest of the batch says what it caused.
 * Returns {kind:'gameRoll', value, title, lines[], art, players[] (who it touched)}. `state` is the state after the batch.
 */
export function gameRollPopup(events, i, state, data) {
  const e = events[i]; const v = e.pub.value; const roller = e.actor; const nm = id => nameOf(state, id);
  const rest = after(events, i, x => x.type === 'gameRollResolved' || x.type === 'turnStarted');
  const before = []; for (let k = i - 1; k >= 0 && events[k].type !== 'gameRollResolved'; k--) if (events[k].type === 'gameRollRerolled') before.unshift(events[k]);
  const lines = before.map(r => `Early-game protection: the ${r.pub.value} was rolled again (16.d).`);
  let title, art = 'dice.d10'; const players = new Set([roller]);
  if (e.pub.kind === 'rome') {
    title = `Game Roll ${v}: Rome Roll!`; art = 'card.confiscates_gold';
    lines.push(`${nm(roller)} rolled ${v}: no province rewards and no Game Cards for anyone this turn (16.d).`);
    for (const x of rest) {
      if (x.type === 'romeTaxPaid') lines.push(x.pub.nothing ? `${nm(x.pub.player)} holds Roma and pays nothing (12.l).` : x.pub.troop ? `${nm(x.pub.player)} sends 1 troop from ${provName(data, x.pub.from)} to Roma as tax (16.j).` : `${nm(x.pub.player)} pays ${x.pub.gold} Gold tax to ${x.pub.to === 'roma' ? "Roma's Gold pile" : nm(x.pub.to)} (16.j).`);
      if (x.type === 'taxTroopSkipped') lines.push(`${nm(x.pub.player)} has no Gold and no troop to spare: Rome is merciful, nothing is paid (16.j).`);
      if (x.type === 'displeasedSkipped') lines.push(`${nm(x.pub.player)} has under 4 Prestige and under 20 troops: no Rome Is Displeased card (16.m).`);
    }
    const f = topFrame(state);
    if (f?.kind === 'chooseProvince' && f.purpose === 'taxTroop') lines.push(`${nm(f.player)} has no Gold: choose the province that sends 1 troop to Roma (16.j).`);
    if (f?.kind === 'draw' && f.deck === 'displeased') lines.push(`${nm(f.player)} has 4+ Prestige or 20+ troops: must draw a Rome Is Displeased card (16.m).`);
  } else if (e.pub.kind === 'satisfied') {
    title = `Game Roll ${v}`;
    lines.push('The Senate is satisfied with Carthage’s destruction! No decrees for now.');
  } else if (e.pub.kind === 'decree') {
    title = `Game Roll ${v}: Senate Decree!`; art = 'card.carthage_must_be_destroyed';
    lines.push(`${nm(roller)} rolled ${v}: Carthage must be destroyed! No province rewards this turn (16.n).`);
    lines.push('Every player sends 1 legion; the legions fight Carthage together.');
  } else {
    title = `Game Roll ${v}`;
    const got = rest.filter(x => x.type === 'rewardGranted'), denied = rest.filter(x => x.type === 'rewardDenied');
    const owned = e.pub.owners ?? [];
    if (!owned.length) lines.push(`Nobody holds a province with number ${v}: nothing happens.`);
    for (const x of got) { players.add(x.pub.player); lines.push(`${nm(x.pub.player)}: ${provName(data, x.pub.province)} gives +1 ${x.pub.reward === 'gold' ? 'Gold' : 'troop (placed there)'} and a Game Card (16.k).`); }
    for (const x of denied) { players.add(x.pub.player); lines.push(`${nm(x.pub.player)}: ${provName(data, x.pub.province)} is below its minimum garrison: no reward, no card (17.q).`); }
    const cards = new Set(got.map(x => x.pub.player)); const multi = [...cards].filter(p => got.filter(x => x.pub.player === p).length > 1);
    for (const p of multi) lines.push(`${nm(p)} holds 2 provinces with ${v}: both rewards, but only 1 Game Card (16.l).`);
  }
  // batch 5 item 2 (Vidi 2026-10-24): the popup names the province(s) whose number matches the roll, whoever holds them
  const matched = gameRollMatches(state, data, v);
  lines.unshift(matched.length ? `Number ${v}: ${matched.map(m => `${m.name} (${m.holder})`).join(', ')}.` : `Number ${v}: no province carries this number.`);
  const rollerHuman = state.players?.find(p => p.id === roller)?.controller !== 'ai';
  return { kind: 'gameRoll', value: v, title, lines, art, players: [...players], matched, sticky: rollerHuman };
}

/** Batch 5 item 6: how a card being looked at can be played right now. mode: 'targets' (PLAY_CARD with a target to pick),
 *  'now' (one PLAY_CARD with nothing to pick), 'build' (a saved Road / Wall card: the Build screen opens on "where"), or 'none'. */
export function cardPlayView(state, data, legal, uid) {
  const plays = legal.filter(d => d.type === 'PLAY_CARD' && d.action.cardUid === uid);
  if (plays.length === 1 && !mainProvince(plays[0])) return { mode: 'now', list: plays };
  if (plays.length) return { mode: 'targets', list: plays };
  const def = state.cards[uid]?.def; const piece = data.cardDefsById[def]?.effect?.params?.piece;
  const saved = legal.filter(d => d.type === 'USE_SAVED_RESOURCE' && d.action.cardUid === uid);
  const isSaved = state.players.some(p => p.savedResources.some(c => c.uid === uid));
  if ((saved.length || isSaved) && piece) {
    const ok = saved.length && buildSteps(state, data, legal).pieces.find(x => x.piece === piece)?.provinces.some(p => p.free);
    if (ok) return { mode: 'build', piece, list: saved };
    return { mode: 'none', list: [], reason: `No province of yours can take a ${piece === 'road' ? 'Road' : 'Wall'} right now.` };
  }
  return { mode: 'none', list: [], reason: null };
}
/** Batch 5 item 8: why a player must draw a Rome Is Displeased card (16.m). */
export function displeasedReason(state, data, pid) {
  const p = playerById(state, pid); const t = data.rules.displeasedThreshold;
  const troops = Object.values(state.provinces).filter(x => x.owner === pid).reduce((n, x) => n + x.troops, 0);
  const why = [p && p.prestige >= t.prestige ? `${p.prestige} Prestige (${t.prestige} or more)` : null, troops >= t.troops ? `${troops} troops (${t.troops} or more)` : null].filter(Boolean);
  return `The Game Roll was a Rome Roll and you have ${why.length ? why.join(' and ') : `${t.prestige}+ Prestige or ${t.troops}+ troops`}: Rome is displeased with you (16.m).`;
}

/** Provinces whose Game Roll number is `v` (16.h), with who holds them: [{id, name, owner, holder}]. */
export function gameRollMatches(state, data, v) {
  return Object.values(state.provinces).filter(p => p.number === v).map(p => ({ id: p.id, name: provName(data, p.id), owner: p.owner,
    holder: p.owner ? `${nameOf(state, p.owner)}${p.status === 'allied' ? ', allied' : ''}` : 'natives, nobody holds it' }));
}

/** The popup for a Revolt Roll or extra Revolt Roll (item 1): `events[i]` is a revoltRoll event. */
export function revoltRollPopup(events, i, state, data) {
  const e = events[i]; const pid = e.pub.player; const nm = id => nameOf(state, id); const v = e.pub.value;
  const rest = after(events, i, x => x.type === 'revoltRoll' || x.type === 'turnStarted' || x.type === 'gameRollResolved');
  const what = e.pub.extra ? 'Extra Revolt Roll' : 'Revolt Roll';
  const lines = [];
  if (e.pub.extra) lines.push(`Borrowed troops died, so ${nm(pid)} makes an extra Revolt Roll (19.d)${e.pub.exempt ? `; ${provName(data, e.pub.exempt)}, just conquered, cannot revolt` : ''}.`);
  const immune = rest.filter(x => x.type === 'revoltImmune');
  for (const x of immune) lines.push(x.pub.general ? `${provName(data, x.pub.province)} has number ${v} but the general is stationed there, so it cannot revolt.` : `${provName(data, x.pub.province)} has number ${v} but ${x.pub.troops} troops: 10 or more never revolt (17.c).`);
  const revolted = rest.filter(x => x.type === 'provinceRevolted');
  const blocked = rest.filter(x => x.type === 'revoltBlocked');
  if (!e.pub.provinces.length && !immune.length) lines.push(`None of ${nm(pid)}'s conquered provinces has number ${v}: nothing happens.`);
  const pick = rest.find(x => x.type === 'revoltPicked');
  if (pick) lines.push(`${pick.pub.provinces.map(id => provName(data, id)).join(' and ')} all have number ${v}, but at most 1 province revolts per roll: a ${pick.pub.die} roll of ${pick.pub.value} picks ${provName(data, pick.pub.province)} (${pick.rule}).`);
  for (const id of e.pub.provinces) {
    const r = revolted.find(x => x.pub.province === id);
    if (r) lines.push(revoltLine(r, rest, state, data));
    else if (blocked.some(x => x.pub.province === id)) lines.push(`${provName(data, id)} would revolt, but Kill Revolt leader! stops it (18.f).`);
    else lines.push(`${provName(data, id)} (number ${v}) is about to revolt!`);
  }
  const f = topFrame(state);
  if (f?.kind === 'responseWindow' && f.window === 'revoltResponse') lines.push(`${nm(f.player)} holds Kill Revolt leader!: choose whether to block the revolt in ${provName(data, f.province)}.`);
  return { kind: 'revoltRoll', value: v, title: `${what} ${v}${revolted.length ? ': REVOLT!' : e.pub.provinces.length ? ': revolt!' : ''}`, lines, art: 'card.revolt', players: [pid], revolt: revolted.length > 0, sticky: revolted.length > 0 && isHuman(state, pid) };
}
function revoltLine(r, rest, state, data) {
  const p = r.pub; const moved = rest.find(x => x.type === 'survivorsMoved' && x.pub.from === p.province); const lost = rest.find(x => x.type === 'survivorsLost' && x.pub.from === p.province);
  let s = `${provName(data, p.province)} revolts: ${p.killed} troop(s) killed (half the minimum ${p.minimum}, rounded down, + 1), the province goes back to its natives and ${nameOf(state, p.player)} loses 1 Prestige.`;
  if (moved) s += ` ${moved.pub.n} survivor(s)${moved.pub.general ? ' and the general' : ''} move to ${provName(data, moved.pub.to)}.`;
  else if (lost) s += ` ${lost.pub.n} survivor(s) have nowhere to go and are lost.`;
  else if (p.survivors > 0 || p.general) s += ` ${p.survivors} survivor(s)${p.general ? ' and the general' : ''} must go to a nearest province: choose it.`;
  if (p.carthageRegainedSpirit) s += ' Carthage regains its spirit: 10 legions, Walls on all sides, Senate Decrees are back (16.n).';
  return s;
}
const SOURCE = { revoltRoll: 'the Revolt Roll', extraRevoltRoll: 'the extra Revolt Roll (19.d)', revoltCard: 'a Revolt! card' };
/** The popup for ONE revolt (item 7), addressed to the owner who lost the province. */
export function revoltPopup(events, i, state, data) {
  const r = events[i]; const p = r.pub; const rest = after(events, i, x => x.type === 'provinceRevolted');
  const cause = p.source === 'revoltCard' ? `${nameOf(state, p.by)} played Revolt! on it` : `${SOURCE[p.source] ?? 'a revolt'} hit its number`;
  return { kind: 'revolt', player: p.player, province: p.province, title: `${provName(data, p.province)} revolts!`, lines: [`${nameOf(state, p.player)}, your province ${provName(data, p.province)} has revolted: ${cause}.`, revoltLine(r, rest, state, data)], art: 'card.revolt', sticky: isHuman(state, p.player), players: [p.player] };
}


/**
 * Q100 (Vidi 2026-10-22): a battle against a human waits for OK. `events[i]` is a battleEnded event; returns null unless the defender
 * is a human player other than the attacker (natives, Roma and Senate Decree battles get no popup; the attacker watched it live).
 */
export function battleResultPopup(events, i, state, data) {
  const e = events[i]; const p = e.pub; const A = e.actor; const D = p.defender;
  if (!D || D === A || !p.target || !isHuman(state, D)) return null;
  const nm = id => nameOf(state, id); const t = provName(data, p.target);
  const rest = after(events, i, x => x.type === 'battleEnded' || x.type === 'turnStarted');
  const lines = [`${nm(D)}, ${nm(A)} attacked your province ${t} from ${provName(data, p.from)}${p.sea ? ' by sea' : ''}.`];
  let title;
  if (p.outcome === 'fled') {
    // v31.30 (17.aa): the defender chose to flee at the announcement — no battle was fought.
    title = `${t} has fallen — you fled!`;
    const fl = rest.find(x => x.type === 'defenderFled' && x.pub.province === p.target);
    lines.push(fl ? `You fled ${t} rather than fight: ${fl.pub.lost} of your ${fl.pub.troops} troop(s) are lost, ${fl.pub.survivors} retreat to ${provName(data, fl.pub.to)}${fl.pub.general ? ' with your general' : ''}. ${nm(A)} takes ${t} without a battle.` : `You fled ${t}; ${nm(A)} takes it without a battle.`);
    lines.push('Prestige is as if you had lost the battle (12.f, 17.aa).');
  } else if (p.outcome === 'conquered') {
    title = `${t} has fallen!`;
    const c = rest.find(x => x.type === 'provinceConquered' && x.pub.province === p.target);
    lines.push(`After ${p.rounds} round(s) your troops in ${t} are gone: ${nm(A)} conquers it${c ? ` and holds it with ${c.pub.troops} troop(s)` : ''}.`);
    const moved = rest.find(x => x.type === 'survivorsMoved' && x.pub.from === p.target);
    if (moved) lines.push(`Your general escapes to ${provName(data, moved.pub.to)}.`);
  } else if (p.outcome === 'retreat') {
    title = `${t} holds: ${nm(A)} retreats`;
    lines.push(`After ${p.rounds} round(s) ${nm(A)} pulls back ${p.attackerLeft} troop(s); you keep ${t} with ${p.defenderLeft} troop(s).`);
    const back = cardsBack(events, i, data); if (back) lines.push(`You keep your unused battle cards: ${back} (17.k, 18.i).`);
  } else {
    title = `${t} held!`;
    lines.push(`After ${p.rounds} round(s) the attack is beaten off; you keep ${t} with ${p.defenderLeft} troop(s).`);
    if (rest.some(x => x.type === 'cardDrawn' && x.pub.player === D) || topFrame(state)?.kind === 'draw' && topFrame(state)?.player === D) lines.push('You win the defence: draw a Game Card.');
  }
  return { kind: 'battle', player: D, province: p.target, title, lines, art: 'dice.d6', sticky: true, players: [D, A] };
}

/** Batch 6 (Q141-Q144): the battle cards the defender took back in this battle (the battleCardsReturned event just before battleEnded), e.g. "Elephants!, Moral boost!". */
export function cardsBack(events, i, data) {
  const id = events[i].pub.battleId;
  for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
    const e = events[j];
    if (e.type === 'battleCardsReturned' && e.pub.battleId === id) {
      const n = {}; for (const d of e.pub.cards) n[d] = (n[d] ?? 0) + 1;
      return Object.entries(n).map(([d, k]) => (data.cardDefsById[d]?.name ?? d) + (k > 1 ? ` x${k}` : '')).join(', ');
    }
  }
  return '';
}
/**
 * What the defender should see the moment they are attacked (v31.4 item 10): how many troops are coming, and which
 * battle cards are committed against them. Card names are the public `revealed` list (committed defs, not hidden uids).
 * `viewerId` the defender (or null on a shared screen) is addressed as "you".
 * Returns null when nobody is being attacked. cardsPending is true until the attacker has committed.
 */
export function incomingAttack(state, data, viewerId = null) {
  const b = state.battle;
  if (!b || b.mode !== 'attack' || !b.def?.player) return null;
  const own = b.att.own ?? 0; const borrowed = b.att.borrowed ?? 0; const troops = own + borrowed;
  let pending = false; let defs = [];
  if (Array.isArray(b.att.revealed)) defs = b.att.revealed.filter(Boolean);
  else if (b.att.cards == null) pending = true;
  else {
    for (const uid of b.att.cards) { const def = state.cards?.[uid]?.def; if (def) defs.push(def); }
    for (const p of b.att.played ?? []) if (p.def && !b.att.cards.includes(p.uid)) defs.push(p.def);
  }
  const counts = new Map();
  for (const def of defs) counts.set(def, (counts.get(def) ?? 0) + 1);
  const cards = [...counts].map(([def, n]) => ({ def, name: data.cardDefsById[def]?.name ?? def, n }));
  const you = viewerId == null || viewerId === b.def.player;
  const who = you ? 'you' : nameOf(state, b.def.player);
  const troopText = borrowed ? `${troops} troops (${own} own + ${borrowed} borrowed)` : `${troops} troop${troops === 1 ? '' : 's'}`;
  const cardText = pending ? 'not chosen yet' : cards.length ? cards.map(c => c.n > 1 ? `${c.name} ×${c.n}` : c.name).join(', ') : 'no battle cards';
  // v31.24 (Update 7): the full brief for the defender — the "You are attacked!" screen used to name the origin and the
  // troops but never the province under attack, the troops on it, or where the general is. All of it comes from the battle.
  const tp = state.provinces[b.target];
  const defenderTroops = b.def.player ? tp.troops : b.target === 'roma' ? tp.troops : (tp.native.present ?? 0);
  const dg = b.def.player ? playerById(state, b.def.player)?.general : null;
  const defenderGeneral = dg ? { name: data.generalsById[dg.id]?.name ?? dg.id, at: dg.at ?? null, here: dg.at === b.target } : null;
  // v31.30 (19.k): a built Wall defends from ANY direction — the same rule as the engine's wallsActive (battle.js):
  // Roma and neutral Carthage have walls on all sides; otherwise any Wall on the target counts, whatever it once faced.
  const wall = b.target === 'roma' || (b.target === 'carthage' && !tp.owner) || (tp.walls ?? []).length > 0;
  const minGarrison = shownMin(state, data, b.target)?.min ?? null;
  const R = data.rules.battle ?? {};
  const defenderDice = wall ? (R.defenderDiceWithWall ?? 3) : (R.defenderDice ?? 2);
  return {
    defender: b.def.player, attacker: b.att.player, from: b.att.from, target: b.target,
    troops, own, borrowed, cards, pending, you,
    troopText, cardText,
    line: `${troopText} attacking ${who}. Cards against ${who}: ${cardText}.`,
    targetName: provName(data, b.target), attackerName: nameOf(state, b.att.player), fromName: provName(data, b.att.from),
    defenderTroops, defenderGeneral, wall, wallSide: null, minGarrison, defenderDice,
  };
}
/** v31.30 (17.aa): the flee brief for the "You are attacked!" screen — what fleeing costs and where the survivors go,
 * shown BEFORE the defender commits. Null when no flee is offered (no battle, no player defender, a Decree battle,
 * or no connecting owned province). The destinations come from the engine's fleeOptions, so the note and the legal
 * list cannot disagree. */
export function fleeBrief(state, data) {
  const b = state.battle;
  if (!b || b.mode !== 'attack' || !b.def?.player) return null;
  const fl = fleeOptions(state, data);
  if (!fl) return null;
  const dg = playerById(state, b.def.player)?.general ?? null;
  return {
    ...fl,
    destNames: fl.destinations.map(id => provName(data, id)),
    targetName: provName(data, b.target),
    attackerName: nameOf(state, b.att.player),
    generalName: fl.general && dg ? (data.generalsById[dg.id]?.name ?? dg.id) : null,
  };
}
/** v31.30 (17.aa): the flee note for the announcement screen, from fleeBrief(). '' when no flee is offered. */
export function fleeNoteHtml(state, data) {
  const fl = fleeBrief(state, data);
  if (!fl) return '';
  const dest = fl.destinations.length === 1 ? ` to ${escHtml(fl.destNames[0])}` : ' to a bordering province of yours (choose below)';
  return `🏃 Flee the battle (17.aa): lose ${fl.losses} of ${fl.troops} troops — ${fl.survivors} retreat${dest}${fl.generalName ? ` with ${escHtml(fl.generalName)}` : ''}. ${escHtml(fl.attackerName)} takes ${escHtml(fl.targetName)} without a battle and keeps their battle cards; Prestige is as if you had lost the battle (12.f). Or stay and fight: pass, sound the Horn, or summon.`;
}
/** v31.30 (17.aa): the note on the retreat-destination picker — the same cost, with the choice spelled out. */
export function fleeDestinationNoteHtml(state, data) {
  const fl = fleeBrief(state, data);
  if (!fl) return '';
  return `You are fleeing ${escHtml(fl.targetName)} (17.aa): ${fl.losses} of ${fl.troops} troops are lost, ${fl.survivors} retreat${fl.generalName ? ` with ${escHtml(fl.generalName)}` : ''}. Choose where they go — ${escHtml(fl.attackerName)} takes ${escHtml(fl.targetName)} without a battle.`;
}
/** v31.24 (Update 4): the provinces that can legally attack `target` right now — the target-first "Attack here from ..."
 *  picker. Built from the ATTACK builder tree, so every engine legality rule (Road, troops, Roma, Carthage, links) applies. */
export function attackOriginsForTarget(legal, target) {
  const tree = builderTree(legal, 'ATTACK');
  return Object.keys(tree).filter(from => (tree[from][target] ?? []).length > 0);
}
/** Batch 6: the rule hint under the battle-card checklist for the defender (from the ruleset, so it follows the flags). */
export function battleCardsHint(data, role) {
  const R = data.rules.earlyRetreatCardsBack;
  if (role !== 'defender' || !R?.enabled) return role === 'attacker' ? 'Your committed cards are spent with the battle, even if you retreat.' : '';
  return `If the attacker retreats${R.retreatBeforeRound1 !== false ? ' before round 1 or' : ''} within ${R.maxRounds} rolled rounds, you keep every card not used yet`
    + `${data.rules.returnCommittedElephantsOnEarlyRetreat ? ' (Elephants included)' : ''}; a Moral boost applied in a rolled round is used (17.k, 18.i).`;
}

/** M7 item 1: the result shown at the foot of the battle popup, for anyone watching. `events[i]` is battleEnded. Returns {title, lines[]}. */
export function battleSummary(events, i, state, data) {
  const e = events[i]; const p = e.pub; const A = e.actor; const D = p.defender;
  const nm = id => nameOf(state, id); const t = provName(data, p.target); const dn = D ? nm(D) : p.target === 'roma' ? 'Roma' : `the ${t} natives`;
  const rest = after(events, i, x => x.type === 'battleEnded' || x.type === 'turnStarted');
  const lines = [];
  let title;
  if (p.outcome === 'fled') {
    // v31.30 (17.aa): no rounds were fought — the defender fled and the attacker takes the province outright.
    const fl = rest.find(x => x.type === 'defenderFled' && x.pub.province === p.target);
    title = `FLEE: ${nm(D)} flees ${t}`;
    lines.push(fl ? `${nm(D)} flees ${t} rather than fight: loses ${fl.pub.lost} of ${fl.pub.troops} troop(s), ${fl.pub.survivors} retreat to ${provName(data, fl.pub.to)}${fl.pub.general ? ' with the general' : ''}; ${nm(A)} takes ${t} without a battle.` : `${nm(D)} flees ${t}; ${nm(A)} takes it without a battle.`);
    if (topFrame(state)?.kind === 'placeSurvivors') lines.push(`${nm(A)} now decides the general and the survivors (17.y).`);
  } else if (p.outcome === 'conquered') {
    const c = rest.find(x => x.type === 'provinceConquered' && x.pub.province === p.target);
    title = `VICTORY: ${nm(A)} conquers ${t}`;
    lines.push(`After ${p.rounds} round(s) ${dn} ${D ? 'loses' : 'lose'} ${t}; ${nm(A)} holds it with ${c?.pub.troops ?? p.attackerLeft} troop(s).`);
    if (topFrame(state)?.kind === 'placeSurvivors') lines.push(`${nm(A)} now decides the general and the survivors (17.y).`);
  } else if (p.outcome === 'retreat') {
    title = `RETREAT: ${t} holds`;
    lines.push(`After ${p.rounds} round(s) ${nm(A)} pulls back ${p.attackerLeft} troop(s) to ${provName(data, p.from)}; ${dn} ${D ? 'keeps' : 'keep'} ${t} with ${p.defenderLeft}.`);
    const back = cardsBack(events, i, data); if (back) lines.push(`${dn} keeps the unused battle cards: ${back} (17.k, 18.i).`);
  } else {
    title = `DEFEAT: ${t} holds`;
    lines.push(`After ${p.rounds} round(s) the attack is beaten off; ${dn} ${D ? 'keeps' : 'keep'} ${t} with ${p.defenderLeft} troop(s).`);
  }
  if (p.borrowedDead) lines.push(`${p.borrowedDead} borrowed native(s) died first.`);
  return { title, lines };
}

const DISPLEASED_RESULT = { generalRecalled: 'recalled_to_rome', goldConfiscated: 'confiscates_gold', provinceRemoved: 'removed_from_province', troopsStolen: 'steals_troops', cardsTaxed: 'taxes_you', displeasedDeferred: 'steals_troops' };
export const isDispleasedResult = e => e.type === 'displeasedNoEffect' || !!DISPLEASED_RESULT[e.type];
/**
 * Q100 (Vidi 2026-10-22): a Rome Is Displeased card that hits a human waits for OK. `events[i]` is the effect's result event
 * (generalRecalled, goldConfiscated, provinceRemoved, troopsStolen, cardsTaxed or displeasedNoEffect); it names the victim, who may
 * not be the drawer (Busy Little Bee!, 18.x). Returns null for an AI victim.
 */
/** One dice adjustment as the Battle panel lists it, e.g. "Elephants! (18.b): +1" (v22: never "undefined: +2"). */
export function adjustmentLabel(x, data) {
  const what = x.why ?? data.cardDefsById[x.source]?.name ?? data.generalsById[x.source]?.name ?? (x.source ? String(x.source) : 'Dice bonus');
  return `${what}: ${x.delta > 0 ? '+' : ''}${x.delta}${x.appliesTo === 'all' ? ' on every die' : ''}`;
}

/**
 * v31.13: Germanicus, Fight to the Death (15.h), as the battle screen lists it up front. The engine only fires the perk through
 * battleDiceAdjusted, after a roll; this reads the same state (the same fight() gate: attacker started with 3+ and was reduced,
 * defender qualifies even starting at 1 or 2) so the panel can list it from the start of the battle, with its live state.
 * Returns null when it cannot fire on `side` ('a' attacker, 'd' defender): no Germanicus general with the army and perks on, or
 * (attacker) the battle started with fewer than 3 troops. Otherwise { troops, delta }: delta 0 = not yet (3+ troops),
 * 1 = live at 2 troops (+1 to each die), 2 = live at 1 troop (+2).
 */
export function fightToDeath(state, data, side) {
  const b = state.battle; if (!b || b.mode !== 'attack') return null;
  const isAtt = side === 'a';
  const pid = isAtt ? b.att.player : b.def.player;
  if (!pid) return null;
  const pl = state.players.find(p => p.id === pid);
  if (!pl?.general || pl.general.id !== 'germanicus') return null;
  if (isAtt ? !b.att.general : !b.def.general) return null;
  if (!generalPerksActive(state, pid)) return null;
  const started = isAtt ? (b.att.started ?? attForce(b)) : (b.def.started ?? defForce(state, b));
  const now = isAtt ? attForce(b) : defForce(state, b);
  if (isAtt && started < 3) return null;
  if (now > 2) return { troops: now, delta: 0 };
  if (now === 2) return { troops: 2, delta: 1 };
  if (now === 1) return { troops: 1, delta: 2 };
  return null;
}
/** v31.13: the Fight to the Death line for the battle panel, from fightToDeath(). */
export function fightToDeathLine(f) {
  if (!f) return null;
  if (f.delta === 1) return 'Germanicus, Fight to the Death: +1 to each die at 2 troops — live now: +1 (15.h)';
  if (f.delta === 2) return 'Germanicus, Fight to the Death: +2 to the die at 1 troop — live now: +2 (15.h)';
  return `Germanicus, Fight to the Death: +1 to each die at 2 troops, +2 at 1 troop — not yet (${f.troops} troops) (15.h)`;
}
/**
 * v31.25: Germanicus's die floor (15.h), as the battle screen lists it up front — a standing perk, live whenever
 * Germanicus is with the army and his perks are on (any troop count, attack or defence, never in a Senate Decree
 * battle). Returns { troops } or null when it cannot apply on `side` ('a' attacker, 'd' defender).
 */
export function germanicusFloor(state, data, side) {
  const b = state.battle; if (!b || b.mode !== 'attack') return null;
  const isAtt = side === 'a';
  const pid = isAtt ? b.att.player : b.def.player;
  if (!pid) return null;
  const pl = state.players.find(p => p.id === pid);
  if (!pl?.general || pl.general.id !== 'germanicus') return null;
  if (isAtt ? !b.att.general : !b.def.general) return null;
  if (!generalPerksActive(state, pid)) return null;
  return { troops: isAtt ? attForce(b) : defForce(state, b) };
}
/** v31.25: the die-floor line for the battle panel, from germanicusFloor(). */
export function germanicusFloorLine(f) {
  if (!f) return null;
  return 'Germanicus: every die counts at least 2 — a 1 counts as 2 (15.h)';
}

/**
 * v31.13: per-die adjustment badges for the battle table. `raw` = the dice as rolled, `final` = the final dice, sorted
 * highest-first (as the engine emits them). Returns an array parallel to `final` with the +N added to each die (0 = unchanged),
 * so the table can mark the die a perk adjusted — ALL adjustments, not just Fight to the Death: Elephants! (18.b) and Moral
 * Boost! (18.c) add +1 to every die, so every die showing +1 is exactly what happened, not noise.
 */
export function dieBadges(raw, final) {
  if (!Array.isArray(raw) || !Array.isArray(final)) return [];
  const r = [...raw].sort((x, y) => y - x);
  return final.map((v, i) => Math.max(0, v - (r[i] ?? 0)));
}

/**
 * v31.13: why the general cannot move now (15.j), or null when the move is available. Used for the greyed-out ⚑ General button
 * (desktop + mobile) and the general-token tap, so the button stays visible until End Turn instead of vanishing when the move
 * is spent. generalMoveTargets covers "not on the map / no reachable province"; the step is checked here because
 * the engine only offers MOVE_GENERAL in the Actions step. v31.17: the move is no longer once per turn (as many times as you
 * want), so there is no "already moved" reason any more; a recalled general is stuck in Rome instead (18.o).
 * v31.38 (18.o): on the turn a recall ends, the general may be placed in any owned province before the Game Roll is rolled —
 * that placement is a move too, so there is no reason to give while the offer stands.
 */
export function generalMoveWhy(state, data, pid) {
  const pl = state.players.find(p => p.id === pid);
  if (!pl?.general?.at) return 'Your general is not on the map.';
  if (state.phase === 'turn' && recallMoveTargets(state, data, pid).length) return null;
  if (state.phase !== 'turn' || state.turn.step !== 'actions') return 'Move your general during the Actions step, after the Revolt Roll (15.j).';
  if (generalRecalled(state, pid)) return `Your general is recalled to Rome until the end of turn ${pl.generalRecalledThroughTurn}: he cannot leave Rome (18.o).`;
  if (!generalMoveTargets(state, data, pid).length) return 'Your general has no reachable province along your chain (15.j).';
  return null;
}
/**
 * v22 (Vidi 2026-10-24): the Assassin popup for a HUMAN victim (never for an AI or the natives). The strikes of one Assassin play
 * (1 or 2 provinces, 18.e) that hit the same human are one popup; returns one popup per human victim, starting at event i.
 */
export function assassinPopups(events, i, state, data) {
  const first = events[i]; if (first?.type !== 'troopsAssassinated') return [];
  const run = []; for (let k = i; k < events.length && events[k].type === 'troopsAssassinated' && events[k].pub.player === first.pub.player; k++) run.push(events[k]);
  const byVictim = new Map();
  for (const e of run) if (e.pub.owner && isHuman(state, e.pub.owner)) (byVictim.get(e.pub.owner) ?? byVictim.set(e.pub.owner, []).get(e.pub.owner)).push(e);
  const att = first.pub.player; const attName = nameOf(state, att) + (isHuman(state, att) || /\(AI\)/.test(nameOf(state, att)) ? '' : ' (AI)');
  return [...byVictim].map(([victim, evs]) => {
    const strikes = evs.map(e => ({ province: e.pub.province, name: provName(data, e.pub.province), killed: e.pub.n, left: e.pub.left }));
    const killed = strikes.reduce((t, x) => t + x.killed, 0);
    return { kind: 'assassin', victim, victimName: nameOf(state, victim), attacker: att, attackerName: attName, strikes, killed,
      title: 'ASSASSINS STRIKE!',
      lines: strikes.map(x => `${attName}'s assassins kill ${x.killed} of ${nameOf(state, victim)}'s troops in ${x.name} (${x.left} left).`) };
  });
}
export function displeasedPopup(events, i, state, data) {
  const e = events[i]; const pid = e.pub.player; if (!isHuman(state, pid)) return null;
  const def = e.type === 'displeasedNoEffect' ? e.pub.def : DISPLEASED_RESULT[e.type];
  const card = data.cardDefsById[def]; const nm = id => nameOf(state, id);
  const lines = [];
  for (let k = i - 1; k >= 0; k--) { const x = events[k]; if (x.type === 'displeasedRedirected' && x.pub.to === pid) { lines.push(`${nm(x.pub.player)} played Busy Little Bee! and sent this card to you (18.x).`); break; } if (x.type === 'displeasedDrawn') break; }
  if (card?.text) lines.push(card.text);
  const p = e.pub;
  if (e.type === 'generalRecalled') lines.push(`${nm(pid)}, your general is recalled to Rome: no general perks until the end of turn ${p.throughTurn} (18.o).`);
  if (e.type === 'goldConfiscated') lines.push(`${nm(pid)}, you lose ${p.lost} Gold; ${p.left} left (18.p).${p.poverty ? ' You were already poor: you also lose Prestige.' : ''}`);
  if (e.type === 'provinceRemoved') {
    lines.push(`${nm(pid)}, the Emperor removes you from ${provName(data, p.province)}: it goes back to its natives (18.q).`);
    const rest = after(events, i, x => isDispleasedResult(x) || x.type === 'turnStarted');
    const moved = rest.find(x => x.type === 'survivorsMoved' && x.pub.from === p.province); const lost = rest.find(x => x.type === 'survivorsLost' && x.pub.from === p.province);
    if (moved) lines.push(`${moved.pub.n} troop(s)${moved.pub.general ? ' and your general' : ''} move to ${provName(data, moved.pub.to)}.`);
    else if (lost) lines.push(`${lost.pub.n} troop(s) have nowhere to go and are lost.`);
    else if (p.troops) lines.push(`Choose where your ${p.troops} troop(s) go.`);
  }
  if (e.type === 'troopsStolen') lines.push(`${nm(pid)}, the Emperor takes ${p.total} bonus troop(s) to Roma: ${p.taken.map(x => `${x.n} from ${provName(data, x.province)}`).join(', ')} (18.r).`);
  if (e.type === 'displeasedDeferred') lines.push(`${nm(pid)}, the Emperor will take ALL your bonus troops to Roma at the start of your next turn (18.r).`);
  if (e.type === 'cardsTaxed') lines.push(`${nm(pid)}, the Emperor takes ${p.n} saved card(s) at random: ${p.defs.map(d => data.cardDefsById[d]?.name ?? d).join(', ')}. Cards cannot be protected (18.u).`);
  if (e.type === 'displeasedNoEffect') lines.push(`No effect for ${nm(pid)}: ${p.reason}.`);
  return { kind: 'displeased', player: pid, title: `Rome Is Displeased: ${card?.name ?? def}`, lines, art: 'card.' + def, sticky: true, players: [pid] };
}

/**
 * Sounds per event for one batch (item 4: ONE dice-rolling sound per roll). Battle rounds get their single rattle from the round
 * animation, so their per-die `diceRolled` events are silent; any other roll plays one sound per roll purpose in the batch, and a
 * round's drum only plays on round 1. Returns an array parallel to `events`.
 */
export function soundPlan(events, state = null) {
  const seen = new Set();
  return events.map(e => {
    if (e.type === 'gameWon') return [];
    if (e.type === 'diceRolled') {
      if (['battleRound', 'battleAttack', 'battleDefence'].includes(e.pub.purpose)) return []; // the round sound covers them
      const k = e.pub.purpose + ':' + (e.actor ?? ''); if (seen.has(k)) return []; seen.add(k);
    }
    if (e.type === 'battleRoundRolled' && e.pub.round > 1) return [];
    return soundsFor(e, state);
  });
}

/**
 * The step-by-step Build screen (item 9) from the legal list. Pieces Road, Wall, Catapult with cost, whether each is possible now and
 * why not; per piece the provinces, each with its paid descriptor and its free saved-card descriptor.
 * v31.30 (19.k): a Wall has no facing — one descriptor per province, like a Road; `facings` stays as an empty list for shape stability.
 * For the resourceBuild frame (a Bonus Road/Wall card just drawn), `frame` is set and the piece is fixed (build free or save).
 */
export function buildSteps(state, data, legal) {
  const f = topFrame(state);
  const pid = whoActs(state); const pl = playerById(state, pid); const c = data.rules.costs;
  if (f?.kind === 'resourceBuild') {
    const piece = f.piece; const provs = {};
    for (const d of legal.filter(x => x.type === 'RESOURCE_BUILD' && x.action.mode === 'build')) {
      const p = (provs[d.action.province] ??= { id: d.action.province, name: provName(data, d.action.province), paid: null, free: d, facings: [] });
    }
    return { frame: true, pieces: [{ piece, name: piece === 'road' ? 'Road' : 'Wall', cost: 0, enabled: true, reason: '', free: true, provinces: Object.values(provs) }], save: legal.find(x => x.type === 'RESOURCE_BUILD' && x.action.mode === 'save') ?? null };
  }
  const cap = state.phase === 'turn' ? effectiveActionsPerTurn(state, data) : 0;   // v31.40 (18.ad): 3 with a played Forced March!
  const left = state.phase === 'turn' ? cap - state.turn.actionsUsed : 0;
  const mine = Object.keys(state.provinces).sort().filter(id => state.provinces[id].owner === pid);
  const saved = piece => (pl?.savedResources ?? []).filter(x => data.cardDefsById[state.cards[x.uid].def]?.effect?.params?.piece === piece).length;
  const mk = (piece, name, cost) => {
    const provs = {};
    const paidT = piece === 'road' ? 'BUILD_ROAD' : 'BUILD_WALL';
    for (const d of legal.filter(x => x.type === paidT || (x.type === 'USE_SAVED_RESOURCE' && data.cardDefsById[state.cards[x.action.cardUid].def]?.effect?.params?.piece === piece))) {
      const id = d.action.province; const kind = d.type === paidT ? 'paid' : 'free';
      const p = (provs[id] ??= { id, name: provName(data, id), paid: null, free: null, facings: [] });
      if (!p[kind]) p[kind] = d;   // v31.30 (19.k): a Wall has no facing — one descriptor per province, like a Road
    }
    const list = Object.values(provs);
    const nSaved = saved(piece); const anyPaid = list.some(p => p.paid);
    let reason = '';
    if (!list.length) {
      const room = piece === 'road' ? mine.some(id => !state.provinces[id].road) : mine.some(id => !(state.provinces[id].walls?.length));
      reason = !room ? (piece === 'road' ? 'every one of your provinces already has a Road' : 'every one of your provinces already has a Wall')
        : left <= 0 ? `no actions left this turn (${cap}/${cap} used)` : (pl?.gold ?? 0) < cost ? `needs ${cost} Gold, you have ${pl?.gold ?? 0}` : 'not possible right now';
    } else if (!anyPaid) reason = left <= 0 ? `paying needs an action: none left (${cap}/${cap} used)` : (pl?.gold ?? 0) < cost ? `paying needs ${cost} Gold, you have ${pl?.gold ?? 0}` : '';
    return { piece, name, cost, enabled: list.length > 0, reason, saved: nSaved, provinces: list };
  };
  const cat = legal.find(x => x.type === 'BUY_CATAPULT') ?? null; const catCost = data.itemsById.catapult.cost.gold;
  const catalog = { piece: 'catapult', name: 'Catapult', cost: catCost, enabled: !!cat, reason: cat ? '' : left <= 0 ? `no actions left this turn (${cap}/${cap} used)` : (pl?.gold ?? 0) < catCost ? `needs ${catCost} Gold, you have ${pl?.gold ?? 0}` : 'not possible right now', saved: 0, provinces: [], paid: cat, owned: pl?.items?.catapult ?? 0 };
  return { frame: false, gold: pl?.gold ?? 0, actionsLeft: left, pieces: [mk('road', 'Road', roadCost(state, data, pid)), mk('wall', 'Wall', c.wall), catalog] };
}

/**
 * M7 item 4: the step-by-step Buy screen, like Build: what (a troop or a Game Card, with costs; greyed with a reason) -> where -> pay.
 * Returns {gold, actionsLeft, sellable, items:[{item, name, cost, costText, enabled, reason, provinces:[{id, name, troops, enabled, reason, paid}]}]}.
 * No card makes a troop or a Game Card free (the troop Resource cards are taken at once, 20.b), so paying is Gold only (Q107).
 */
export function buySteps(state, data, legal) {
  const pid = whoActs(state); const pl = playerById(state, pid); const c = data.rules.costs; const gold = pl?.gold ?? 0;
  const cap = state.phase === 'turn' ? effectiveActionsPerTurn(state, data) : 0;   // v31.40 (18.ad): 3 with a played Forced March!
  const left = state.phase === 'turn' ? cap - state.turn.actionsUsed : 0;
  const mine = Object.keys(state.provinces).sort().filter(id => state.provinces[id].owner === pid);
  const noAct = `no actions left this turn (${cap}/${cap} used)`;
  const sellable = legal.filter(d => d.type === 'SELL_CARD').length;
  const short = cost => `needs ${cost} Gold, you have ${gold}${sellable ? ` (selling a card gives ${data.rules.sellCard?.gold ?? 2} Gold)` : ''}`;
  const why = (list, cost, extra) => (list.some(x => x.enabled) ? '' : left <= 0 ? noAct : gold < cost ? short(cost) : extra() || 'not possible right now');
  const pack = (n, cost) => {
    const provs = mine.map(id => {
      const d = legal.find(x => x.type === 'BUY_TROOP' && (x.action.n ?? 1) === n && x.action.province === id) ?? null;
      const p = state.provinces[id];
      const full = id === 'roma' && (data.rules.romaMaxTroops - p.troops) < n;
      return { id, name: provName(data, id), troops: p.troops, enabled: !!d, paid: d, reason: d ? '' : full ? `Roma is full (${data.rules.romaMaxTroops} troops at most, 12.k)` : 'not possible right now' };
    });
    const item = { item: n === 1 ? 'troop' : 'troops' + n, name: n === 1 ? '1 troop' : `${n} troops`, n, cost, costText: `${cost} Gold · 1 action`, provinces: provs };
    item.reason = why(provs, cost, () => (!mine.length ? 'you control no province' : ''));
    item.enabled = !item.reason;
    return item;
  };
  const troop = pack(1, c.troop);
  const troops2 = pack(2, c.troops2);
  const troops3 = pack(3, c.troops3);
  const cardProvs = mine.map(id => {
    const d = legal.find(x => x.type === 'BUY_GAME_CARD' && x.action.fromProvince === id) ?? null; const p = state.provinces[id];
    return { id, name: provName(data, id), troops: p.troops, enabled: !!d, paid: d, reason: d ? '' : p.troops <= c.gameCardTroops ? `only ${p.troops} troop: at least 1 must stay (17.f)` : p.status === 'held' ? `Roma must keep ${data.rules.romaFloorOnHold} while held` : 'not possible right now' };
  });
  const card = { item: 'gameCard', name: 'Game Card', cost: c.gameCardGold, costText: `${c.gameCardGold} Gold + ${c.gameCardTroops} troop · 1 action · max 1 per turn`, provinces: cardProvs };
  card.reason = state.turn?.gameCardBought ? 'you already bought a Game Card this turn (max 1, 17.s)' : why(cardProvs, c.gameCardGold, () => (mine.every(id => state.provinces[id].troops <= c.gameCardTroops) ? 'no province can pay a troop and keep 1 (17.f)' : ''));
  card.enabled = !card.reason;
  // v31.14: Buy Prestige (22.g) has no province — it goes straight to the pay step (buyHtml skips "Where" for items with no provinces).
  const presD = legal.find(x => x.type === 'BUY_PRESTIGE') ?? null;
  const prestige = { item: 'prestige', name: '1 Prestige', cost: c.prestige, costText: `${c.prestige} Gold · 1 action · banked, permanent`, provinces: [], paid: presD };
  prestige.reason = left <= 0 ? noAct : gold < c.prestige ? short(c.prestige) : presD ? '' : 'not possible right now';
  prestige.enabled = !prestige.reason;
  return { gold, actionsLeft: left, sellable, items: [troop, troops2, troops3, card, prestige] };
}

/** Actions used this turn, as "0/2" (or "0/3" with a played Forced March!, 18.ad). Null before the first turn. */
export function actionsUsedLabel(state, data) {
  if (state.phase !== 'turn' || !state.turn) return null;
  return `${state.turn.actionsUsed}/${effectiveActionsPerTurn(state, data)}`;
}
/**
 * The minimum the MAP shows for `id` (shownMin), falling back to the engine minGarrison when the map shows none
 * (a held Roma: shownMin is null, the engine floor of 1 still applies; unowned: 0). This is the single source of
 * truth for any displayed minimum: the popup must never show a different number from the map label for the same
 * province in the same state.
 * v31.29: minGarrison alone is NOT that number for an ALLIED province — it short-circuits allied to the global
 * floor of 1, while shownMin uses the allied reward threshold (natives + 1, 19.r/19.g, with Pompey / Garrison
 * Requirement applied). An allied origin with 5 natives and the Garrison card showed "min 5" on the map and
 * "min 1" in the survivors popup (image-25, v31.28); the popup's 1 was the leave-1-troop floor, not a garrison
 * minimum, and must never be displayed as one on this screen. The engine "at least 1 stays" rule (maxBack,
 * 17.y) is untouched — it limits the slider, it is not a minimum.
 */
export function displayMin(state, data, id) {
  return shownMin(state, data, id)?.min ?? minGarrison(state, data, id).min;
}

/**
 * How many troops must stay so `id` remains at its minimum garrison (and the global floor).
 * `mayLeave` is how many can go and still leave that minimum. Empty string when the province has no owner.
 * The minimum is displayMin (v31.29) — the same number the map shows — so this text agrees with the map label
 * wherever it appears, including the note under the survivors popup.
 */
export function garrisonStayText(state, data, id) {
  const p = state.provinces[id];
  if (!p?.owner) return '';
  const min = displayMin(state, data, id);
  const floor = p.status === 'held' ? data.rules.romaFloorOnHold : data.rules.provinceFloor;
  const must = Math.max(min, floor);
  const may = Math.max(0, p.troops - must);
  const name = provName(data, id);
  if (p.troops < min) return `${name}: minimum ${min}, already under it (${p.troops} here; at least ${floor} must stay).`;
  return `${name}: minimum ${min} — keep ${must} to stay at minimum (${may} may leave).`;
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp01 = v => Math.max(0, Math.min(1, v));
/**
 * v31.22: the survivors slider (approved mockup, Tomas 2026-11-11). ONE slider splits the survivors between the two provinces:
 * the origin province is ALWAYS on the left, the conquered (target) province ALWAYS on the right — cards, slider ends, threshold
 * marks, min strip and confirm text. The slider value is `stay` (troops staying in the target, stayMin..own); back = own - stay.
 * stayMin is own - maxBack: at least 1 survivor stays, except Roma where all may return (17.y, engine rule — the frame's maxBack).
 * Minimums come from displayMin (v31.29) — the same number the map shows (shownMin) — NOT from minGarrison directly:
 * for an allied origin minGarrison returns the floor of 1 while the map shows the allied threshold (natives + 1),
 * and the popup showed that 1 as the origin's minimum (image-25). The target is safe while stay >= minTarget, the origin while
 * originTroops + back >= minOrigin. Default split sends back only what the origin needs to reach its minimum (and no more than
 * leaves the target at its minimum) — the conservative default, not the mockup's 9/9 example split.
 */
export function survivorsSplit(state, data, f) {
  const origin = f.origin, target = f.target, own = f.own, maxBack = f.maxBack;
  const originTroops = state.provinces[origin]?.troops ?? 0;
  const minTarget = displayMin(state, data, target);
  const minOrigin = displayMin(state, data, origin);
  const stayMin = Math.max(0, own - maxBack);
  const stayMax = own;
  const span = Math.max(1, stayMax - stayMin);
  // Thresholds on the stay slider: the target reaches its minimum at stay = minTarget; the origin drops to its minimum at
  // stay = own + originTroops - minOrigin (above that, too few return). The safe band is where both hold.
  const safeLo = Math.max(stayMin, minTarget), safeHi = Math.min(stayMax, own + originTroops - minOrigin);
  let back = Math.max(0, minOrigin - originTroops);
  if (own - back < minTarget) back = Math.max(0, own - minTarget);
  back = Math.max(0, Math.min(maxBack, back));
  const general = state.players.find(p => p.id === f.player)?.general;
  return {
    origin, target, own, maxBack, originTroops, minTarget, minOrigin, stayMin, stayMax,
    destTick: clamp01((minTarget - stayMin) / span), origTick: clamp01((own + originTroops - minOrigin - stayMin) / span),
    safeLo, safeHi, safe: safeLo <= safeHi,
    safeLoFrac: clamp01((safeLo - stayMin) / span), safeHiFrac: clamp01((safeHi - stayMin) / span),
    defaultStay: own - back, defaultBack: back,
    generalName: general ? (data.generalsById[general.id]?.name ?? 'General') : null,
    originName: provName(data, origin), targetName: provName(data, target),
  };
}
/** The split for one slider position: counts, whether each province meets its minimum, and the shortfalls. Pure, so tests drive it. */
export function survivorsSplitAt(split, stay) {
  const back = split.own - stay;
  const originTotal = split.originTroops + back;
  const targetOk = stay >= split.minTarget, originOk = originTotal >= split.minOrigin;
  return {
    stay, back, originTotal, targetTotal: stay, targetOk, originOk, bothOk: targetOk && originOk,
    shortTarget: Math.max(0, split.minTarget - stay), shortOrigin: Math.max(0, split.minOrigin - originTotal),
  };
}
/**
 * v31.34 (Update 4): the flee behind a survivors split, if the province fell because the defender fled (17.aa).
 * The frame carries no history, so this reads the log: the latest battleEnded for the target, and the defenderFled
 * event of that same battle. Null when the province fell in battle, or the log holds no battle for it.
 */
export function survivorsFlee(state, data, f) {
  const log = state?.log ?? [];
  let ended = null;
  for (let i = log.length - 1; i >= 0; i--) { const e = log[i]; if (e.type === 'battleEnded' && e.pub?.target === f.target) { ended = e; break; } }
  if (!ended || ended.pub.outcome !== 'fled') return null;
  const fl = [...log].reverse().find(e => e.type === 'defenderFled' && e.pub?.battleId === ended.pub.battleId && e.pub?.province === f.target);
  if (!fl) return null;
  return { defender: fl.pub.player, defenderName: nameOf(state, fl.pub.player), targetName: provName(data, f.target), to: fl.pub.to, toName: provName(data, fl.pub.to), troops: fl.pub.troops, lost: fl.pub.lost, survivors: fl.pub.survivors, general: fl.pub.general };
}
/** The survivors popup HTML (desktop ask box and mobile sheet share it; each page wires its own controls). The Confirm button
 *  repeats the split in words; the general is a single checkbox when he took part in the attack. */
export function placeSurvivorsHtml(state, data, f) {
  const sp = survivorsSplit(state, data, f);
  const at = survivorsSplitAt(sp, sp.defaultStay);
  const fl = survivorsFlee(state, data, f);
  const fleeLine = fl ? ` ${escHtml(fl.defenderName)} fled ${escHtml(fl.targetName)} rather than fight — you take it without a battle.` : '';
  const pct = v => (v * 100).toFixed(1) + '%';
  const card = (role, name, count, min, status, under) => `<div class="sv-card sv-${role}${under ? ' is-under' : ''}" data-sv-card="${role}">
      <span class="sv-role">${role === 'origin' ? 'You attacked from here' : 'Newly conquered'}</span>
      <h3>${escHtml(name)}</h3>
      <div class="sv-total"><span class="sv-big${under ? ' under' : ' ok'}" data-sv-count="${role}">${count}</span><span class="sv-unit">troops</span>
      <span class="sv-minpill">min ${min}</span></div>
      <div class="sv-delta" data-sv-delta="${role}"></div>
      <div class="sv-status${under ? ' under' : ' ok'}" data-sv-status="${role}">${status}</div>
      ${f.general ? `<span class="sv-genhere" data-sv-genhere="${role}">⚑ General here</span>` : ''}</div>`;
  const statusFor = (ok, total, min, name, short) => ok ? `Garrison met — needs min ${min}`
    : `UNDER-GARRISONED<span class="sv-short">${escHtml(name)} has ${total} of min ${min} — short by ${short} troop${short === 1 ? '' : 's'}</span>`;
  const genRow = f.general ? `<label class="sv-genrow" data-sv-genrow><input type="checkbox" data-sv="general">
      <span class="sv-gtext"><span class="sv-gtitle">${escHtml(sp.generalName)} goes back to ${escHtml(sp.originName)}</span>
      <span class="sv-gsub" data-sv-gensub></span></span></label>` : '';
  return `<div class="sv" data-sv-root data-own="${sp.own}" data-maxback="${sp.maxBack}" data-origintroops="${sp.originTroops}"
      data-mintarget="${sp.minTarget}" data-minorigin="${sp.minOrigin}" data-staymin="${sp.stayMin}" data-staymax="${sp.stayMax}"
      data-general="${f.general ? escHtml(sp.generalName) : ''}">
    <p class="sv-sub">You conquered <b>${escHtml(sp.targetName)}</b> from <b>${escHtml(sp.originName)}</b>.${fleeLine} <b>${sp.own} survivor${sp.own === 1 ? '' : 's'}</b> — decide where they stand.</p>
    <div class="sv-cards">
      ${card('origin', sp.originName, at.originTotal, sp.minOrigin, statusFor(at.originOk, at.originTotal, sp.minOrigin, sp.originName, at.shortOrigin), !at.originOk)}
      ${card('target', sp.targetName, at.targetTotal, sp.minTarget, statusFor(at.targetOk, at.targetTotal, sp.minTarget, sp.targetName, at.shortTarget), !at.targetOk)}
    </div>
    <div class="sv-slider">
      <p class="sv-readout" data-sv-readout></p>
      <div class="sv-row">
        <button type="button" class="sv-step" data-sv="down" aria-label="Send one more troop back to ${escHtml(sp.originName)}">−</button>
        <div class="sv-wrap">
          <input type="range" data-sv="slider" min="${sp.stayMin}" max="${sp.stayMax}" step="1" value="${sp.defaultStay}"${sp.stayMin === sp.stayMax ? ' disabled' : ''}
            aria-label="Troops staying in ${escHtml(sp.targetName)}. Move left to send more back to ${escHtml(sp.originName)}, right to keep more in ${escHtml(sp.targetName)}. ${escHtml(sp.targetName)} needs at least ${sp.minTarget}, ${escHtml(sp.originName)} at least ${sp.minOrigin}.">
          <span class="sv-tick sv-tick-target" style="left:${pct(sp.destTick)}" title="${escHtml(sp.targetName)} min ${sp.minTarget}"></span>
          <span class="sv-tick sv-tick-origin" style="left:${pct(sp.origTick)}" title="${escHtml(sp.originName)} min ${sp.minOrigin}"></span>
        </div>
        <button type="button" class="sv-step" data-sv="up" aria-label="Keep one more troop in ${escHtml(sp.targetName)}">+</button>
      </div>
      <div class="sv-ticklabels"><span class="sv-tl-target" style="left:${pct(sp.destTick)}">min ${sp.minTarget} ▲</span><span class="sv-tl-origin" style="left:${pct(sp.origTick)}">▲ min ${sp.minOrigin}</span></div>
      ${sp.safe ? `<div class="sv-safezone"><span class="sv-safebar" style="left:${pct(sp.safeLoFrac)};width:${pct(sp.safeHiFrac - sp.safeLoFrac)}"></span></div>
      <p class="sv-safecap">Between the two marks, both provinces stay garrisoned</p>` : ''}
      <div class="sv-minstrip">
        <div class="sv-mincell sv-min-origin">${escHtml(sp.originName)} · min ${sp.minOrigin}<span class="sv-minsub">Met while ${sp.minOrigin} or more return</span></div>
        <div class="sv-mincell sv-min-target">${escHtml(sp.targetName)} · min ${sp.minTarget}<span class="sv-minsub">Met while ${sp.minTarget} or more stay</span></div>
      </div>
      <div class="sv-ends"><span class="sv-end-origin">← More return to ${escHtml(sp.originName)}</span><span class="sv-end-target">More stay in ${escHtml(sp.targetName)} →</span></div>
      <div class="sv-banner ok" data-sv="banner" role="status"></div>
      <p class="sv-note">Minimum garrisons: <b>${escHtml(sp.originName)} min ${sp.minOrigin}</b> · <b>${escHtml(sp.targetName)} min ${sp.minTarget}</b> — ${sp.own} survivors cover both, with ${Math.max(0, sp.own - sp.minTarget - Math.max(0, sp.minOrigin - sp.originTroops))} to spare.</p>
    </div>
    ${genRow}
    <button type="button" class="btn gold sv-confirm" data-sv="confirm"></button>
  </div>`;
}

/**
 * The minimum the province panel shows. Conquered and starting provinces use the garrison minimum.
 * An allied province shows the perk threshold: natives + 1, with Pompey −1 and Garrison Requirement −1, never below 1 (19.r, 19.g).
 * Unowned provinces show nothing. The global floor of 1 still limits troops leaving an ally; that is separate from this number.
 */
export function shownMin(state, data, id) {
  const p = state.provinces[id];
  if (!p?.owner) return null;
  if (p.status === 'allied') {
    const min = alliedRewardNeed(state, data, id);
    return { min, lines: [`allied: natives + 1, with Pompey and Garrison Requirement (19.r, 19.g); never below 1. Shown: ${min}`] };
  }
  return (p.status === 'conquered' || p.status === 'starting') ? minGarrison(state, data, id) : null;
}
export const HIDE_AI_BATTLES_KEY = 'imperator.hideAiBattles';
/** Remembered in this browser. Default off: every battle shows. */
export function hideAiBattlesOn() {
  try { return globalThis.localStorage?.getItem(HIDE_AI_BATTLES_KEY) === '1'; } catch { return false; }
}
export function setHideAiBattles(on) {
  try { globalThis.localStorage?.setItem(HIDE_AI_BATTLES_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
/**
 * v31.30 (Update 4): DISPLAY-ONLY under-garrison check for the map token "!" marker and the province panels.
 * The engine selector `isUnderGarrisoned` counts conquered provinces only and must stay that way (AI scoring,
 * Horn gating, turn.js) — but an ALLIED province below the threshold the map already shows (displayMin: natives + 1,
 * with Pompey / Garrison −1) is under-garrisoned for display too: it loses the Game Roll reward / bonus troop (19.e).
 * Same test the desktop table and the mobile sheet already used inline; now one helper so both token renderers agree.
 */
export function displayUnderGarrisoned(state, data, id) {
  const p = state?.provinces?.[id];
  if (!p?.owner) return false;
  if (p.status === 'allied') return p.troops < displayMin(state, data, id);
  if (p.status === 'conquered') return p.troops < minGarrison(state, data, id).min;
  return false;
}
export const SHOW_PROV_NUMBERS_KEY = 'imperator.showProvNumbers';
/** v31.30 (Update 5): "Show Prov Numbers" map toggle. Off by default; remembered in this browser like Hide AI battles. */
export function showProvNumbersOn() {
  try { return globalThis.localStorage?.getItem(SHOW_PROV_NUMBERS_KEY) === '1'; } catch { return false; }
}
export function setShowProvNumbers(on) {
  try { globalThis.localStorage?.setItem(SHOW_PROV_NUMBERS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
/** The Game Roll number to show on `id`'s token when the toggle is on, or null. Roma has no number (null);
 * every other province carries one (3–8, assigned at setup). `on` defaults to the saved toggle. */
export function provNumberLabel(state, id, on = showProvNumbersOn()) {
  if (!on) return null;
  const n = state?.provinces?.[id]?.number;
  return Number.isInteger(n) ? String(n) : null;
}
export const SHOW_LINKS_KEY = 'imperator.showLinks';
/** v31.31 (Update 1): "Show links" map toggle for mobile (Menu → View). Off by default, like the desktop checkbox;
 *  remembered in this browser. The desktop checkbox itself is still session-only; this key is the mobile toggle's store. */
export function showLinksOn() {
  try { return globalThis.localStorage?.getItem(SHOW_LINKS_KEY) === '1'; } catch { return false; }
}
export function setShowLinks(on) {
  try { globalThis.localStorage?.setItem(SHOW_LINKS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
export const SHOW_MIN_GARRISON_KEY = 'imperator.showMinGarrison';
/** v31.31 (Update 1): "Min garrison on map" toggle for mobile (Menu → View). On by default, like the desktop checkbox;
 *  remembered in this browser. */
export function showMinGarrisonOn() {
  try { const v = globalThis.localStorage?.getItem(SHOW_MIN_GARRISON_KEY); return v === null || v === undefined ? true : v === '1'; } catch { return true; }
}
export function setShowMinGarrison(on) {
  try { globalThis.localStorage?.setItem(SHOW_MIN_GARRISON_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}
/** The "min N" label for `id`'s token when the toggle is on, or null. The same number the desktop map shows (shownMin:
 *  conquered = natives + 1, starting = 1, allied = the reward threshold; Roma-held and unowned show nothing).
 *  `on` defaults to the saved toggle. */
export function minGarrisonLabel(state, data, id, on = showMinGarrisonOn()) {
  if (!on) return null;
  const m = shownMin(state, data, id);
  return m?.min ? `min ${m.min}` : null;
}
/**
 * v31.34 (Bug 2): stacked general tokens — when several generals share a province (Roma after a recall, or any
 * other stack), fan their tokens out so every letter stays visible and clickable. One general keeps the exact old
 * spot (no visual change at all); with n > 1 the tokens spread in a row at the same height. Returns one
 * { dx, dy, side } per general, in map-% offsets from the province token: off the Large Map the row is centred
 * on the old above-left spot; on the Large Map it steps left from clear of the Wall badge (the old spot goes
 * through placeSideMarks, so only a lone general keeps `side: true`).
 */
export function generalTokenFan(n, largeMap) {
  if (n <= 1) return [{ dx: largeMap ? -2.9 : -2.3, dy: largeMap ? 0 : -3.9, side: largeMap }];
  const step = 2.2;
  if (largeMap) return Array.from({ length: n }, (_, i) => ({ dx: -5.1 - i * step, dy: 0, side: false }));
  return Array.from({ length: n }, (_, i) => ({ dx: -2.3 + (i - (n - 1) / 2) * step, dy: -3.9, side: false }));
}
/** True when the full battle screen should be skipped. Natives are not a human. `on` defaults to the saved toggle. */
export function skipBattleUi(state, attacker, defender, on = hideAiBattlesOn()) {
  if (!on || !state) return false;
  const human = id => {
    if (!id) return false;
    const p = state.players.find(x => x.id === id);
    return !!p && p.controller !== 'ai';
  };
  return !human(attacker) && !human(defender);
}
const BATTLE_FACE = new Set(['attackDeclared', 'battleStarted', 'battleRoundRolled', 'battleRoundResolved', 'battleDiceAdjusted', 'battleEnded', 'defenderFled', 'enemyFled', 'generalSummoned', 'generalPerkTriggered', 'casualtiesApplied', 'lossCapped', 'decreeBattle', 'decreeResolved', 'elephantPanicked']);
/** Who is in this battle event, even after the action has cleared state.battle. */
export function battleParticipants(state, event) {
  const p = event?.pub ?? {};
  if (!event) return null;
  if (event.type === 'attackDeclared') return { att: p.player ?? null, def: p.defender ?? null, target: p.target ?? null, id: p.battleId ?? null };
  if (event.type === 'battleEnded') return { att: event.actor ?? null, def: p.defender ?? null, target: p.target ?? null, id: p.battleId ?? null };
  if (event.type === 'battleRoundRolled' || event.type === 'battleDiceAdjusted') {
    const att = p.attPlayer ?? p.attacker?.player ?? null;
    const def = p.defPlayer !== undefined ? p.defPlayer : (p.defender && typeof p.defender === 'object' ? p.defender.player ?? null : null);
    if (att || p.attacker) return { att, def, target: p.target ?? state?.battle?.target ?? null, id: p.battleId ?? state?.battle?.id ?? null };
  }
  if (p.attPlayer !== undefined || p.defPlayer !== undefined) return { att: p.attPlayer ?? null, def: p.defPlayer ?? null, target: p.target ?? state?.battle?.target ?? null, id: p.battleId ?? state?.battle?.id ?? null };
  if (event.type === 'decreeBattle' || event.type === 'decreeResolved') return { att: p.roller ?? event.actor ?? null, def: null, target: 'carthage', id: p.battleId ?? null };
  if (state?.battle && BATTLE_FACE.has(event.type)) return { att: state.battle.att?.player ?? null, def: state.battle.def?.player ?? null, target: state.battle.target ?? null, id: state.battle.id ?? null };
  return null;
}
/** A battle event whose screen is skipped: AI vs AI, or AI vs natives, and only while the toggle is on. */
export function battleEventHidden(state, event, on = hideAiBattlesOn()) {
  if (!on || !event) return false;
  if (event.type === 'cardPlayed') {
    if (!state?.battle) return false;
    return skipBattleUi(state, state.battle.att.player, state.battle.def.player, on);
  }
  if (!BATTLE_FACE.has(event.type)) return false;
  const who = battleParticipants(state, event);
  if (!who) return false;
  return skipBattleUi(state, who.att, who.def, on);
}
/** Drop a live "attacks X" title and arrow when a battle ends, a hidden battle is skipped, or the next turn begins with no battle. */
export function battleChromeClear(event, state, on = false) {
  if (!event) return false;
  if (event.type === 'turnStarted' && !state?.battle) return true;
  if (event.type === 'battleEnded') return true;
  if (battleEventHidden(state, event, on) && ['attackDeclared', 'battleStarted', 'battleRoundRolled', 'battleRoundResolved'].includes(event.type)) return true;
  return false;
}
/** Title and arrow after one event. Used by the battle screen and by the regression tests. */
export const battleSheetNeedsRebuild = (openId, nextId) => nextId != null && openId !== nextId;
export function battleChromeStep(chrome, event, state, on = false) {
  const cur = { title: null, arrow: null, id: null, ...(chrome ?? {}) };
  if (battleChromeClear(event, state, on)) return { title: null, arrow: null, id: null };
  if (event.type === 'attackDeclared') return { title: event.pub?.target ?? null, arrow: event.pub?.target ?? null, id: event.pub?.battleId ?? null };
  return cur;
}
/**
 * The public events of `playerId`'s latest finished turn: from their turnStarted through their turnEnded.
 * Anything after that turnEnded (the next player's Resources step, which shares the End Turn action) is left out.
 */
export function eventsOfTurn(log, playerId) {
  if (!Array.isArray(log) || !playerId) return [];
  let end = -1;
  for (let i = log.length - 1; i >= 0; i--) if (log[i].type === 'turnEnded' && log[i].pub?.player === playerId) { end = i; break; }
  if (end < 0) return [];
  let start = 0;
  for (let i = end; i >= 0; i--) if (log[i].type === 'turnStarted' && log[i].pub?.player === playerId) { start = i; break; }
  return log.slice(start, end + 1);
}
/**
 * High-level summary of one turn, from that turn's events. Public fields only: a hidden Game Card stays "a Game Card".
 * Battles are one line each (who, where, result, troop losses), never the dice.
 * `skip` is true when the turn produced nothing worth reading.
 */
export function aiTurnSummary(events, state, data, playerId) {
  const name = state.players?.find(p => p.id === playerId)?.name ?? playerId ?? 'AI';
  const prov = id => data.provincesById?.[id]?.name ?? id ?? '?';
  const card = def => (def && data.cardDefsById?.[def]?.name) || def || 'a card';
  const mine = e => e.actor === playerId || e.pub?.player === playerId;
  const turn = (events.find(e => e.type === 'turnStarted' && e.pub?.player === playerId) ?? events.find(e => e.type === 'turnEnded' && e.pub?.player === playerId))?.pub?.number ?? null;
  const gained = [], rolls = [], actions = [], battles = [];
  let open = null, sawDecree = false;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const e of events ?? []) {
    const p = e.pub ?? {};
    if (e.type === 'attackDeclared' && p.player === playerId) { open = { place: prov(p.target), rounds: [] }; continue; }
    if (open && e.type === 'battleRoundResolved') { open.rounds.push(p); continue; }
    if (open && e.type === 'battleEnded') {
      const aLoss = open.rounds.reduce((t, r) => t + (r.attackerLoss ?? 0), 0);
      const dLoss = open.rounds.reduce((t, r) => t + (r.defenderLoss ?? 0), 0);
      const how = p.outcome === 'conquered' ? 'won' : p.outcome === 'retreat' ? 'retreated' : 'lost';
      battles.push(`${name} attacked ${open.place} and ${how}, lost ${plural(aLoss, 'troop')} (defender lost ${dLoss}).`);
      open = null; continue;
    }
    if (['diceRolled', 'battleRoundRolled', 'battleDiceAdjusted', 'battleStarted', 'actionSpent', 'stepStarted', 'turnStarted', 'turnEnded', 'casualtiesApplied', 'borrowDecided', 'battleCardsCommitted', 'battleCardsSkipped', 'battleCardsSpent', 'battleCardsReturned', 'perkChosen', 'generalPerkTriggered', 'enemyFled'].includes(e.type)) continue;
    if (e.type === 'senateDecree' && (e.actor === playerId || p.player === playerId)) sawDecree = true;
    switch (e.type) {
      case 'bonusTroopsGranted': if (p.player === playerId) gained.push(`+${p.n ?? 1} troop in ${prov(p.province)} (Resources).`); break;
      case 'startProvinceGold': if (p.player === playerId) gained.push(`+${p.gold} Gold from the start province.`); break;
      case 'merchantBonus': if (p.player === playerId) gained.push(`Merchant Bonus: +${p.gold} Gold (${p.roads} Roads to Roma).`); break;
      case 'rewardGranted': if (p.player === playerId) gained.push(`Game Roll reward: ${p.reward} from ${prov(p.province)}.`); break;
      case 'resourceApplied': if (p.player === playerId) gained.push(`Resource card ${card(p.def)}: +${p.gold ?? 0} Gold, ${plural(p.troops ?? 0, 'troop')} to place.`); break;
      case 'troopsPlaced': if (p.player === playerId) gained.push(`Placed ${plural(p.n, 'troop')} in ${prov(p.province)}.`); break;
      case 'cardDrawn': if (p.player === playerId) {
        if (p.deck === 'game') gained.push(p.def ? `Drew ${card(p.def)}${p.autoPlay ? ' (played at once)' : ''}.` : 'Drew a Game Card.');
        else if (p.deck === 'resource') gained.push(`Drew a Resource card${p.def ? ': ' + card(p.def) : ''}.`);
        else gained.push(`Drew a ${p.deck} card.`);
      } break;
      case 'unusedActionGold': if (p.player === playerId && p.gold) gained.push(`+${p.gold} Gold for ${plural(p.unused, 'unused action')}.`); break;
      case 'coinMasterBonus': if (p.player === playerId) gained.push(`+${p.gold} Gold from ${card(p.def)}${p.reason === 'sale' ? ` (sold ${card(p.sold)})` : ''}.`); break;   // v31.37 (18.aa, 18.ab)
      case 'goldPrestige': if (p.player === playerId && p.goldPrestige) gained.push(`Gold Prestige +${p.goldPrestige} from ${p.gold} Gold (not spent).`); break;
      case 'prestigeChanged': if (p.player === playerId && p.to !== p.from) gained.push(`Prestige ${p.from} → ${p.to}.`); break;
      case 'gameRollResolved': if (mine(e)) rolls.push(p.kind === 'rome' ? `Game Roll ${p.value}: Rome Roll.` : p.kind === 'decree' ? `Game Roll ${p.value}: Senate Decree.` : `Game Roll ${p.value}.`); break;
      case 'gameRollRerolled': if (mine(e)) rolls.push(`Early-game protection: ${p.value} was rolled again.`); break;
      case 'romeRoll': if (mine(e) || p.roller === playerId) rolls.push(`Rome Roll${p.number != null ? ' ' + p.number : ''}.`); break;
      case 'romeTaxPaid': if (p.player === playerId) rolls.push(p.nothing ? 'Rome Roll: paid nothing.' : p.troop ? 'Rome Roll: paid a troop.' : `Rome Roll: paid ${p.gold} Gold.`); break;
      case 'senateDecree': if (e.actor === playerId || p.player === playerId) rolls.push(`Senate Decree ${p.number}: legions against Carthage.`); break;
      case 'decreeBattle': if (sawDecree || p.roller === playerId) rolls.push(`Senate Decree: ${p.legions} legion${p.legions === 1 ? '' : 's'} attack Carthage.`); break;
      case 'decreeResolved': if (sawDecree) rolls.push(`Senate Decree result: ${p.result}.`); break;
      case 'revoltRoll': if (mine(e)) rolls.push(p.provinces?.length ? `Revolt Roll ${p.value}: ${p.provinces.map(prov).join(', ')} revolt.` : `Revolt Roll ${p.value}: nothing revolts.`); break;
      case 'revoltRollSkipped': if (p.player === playerId) rolls.push('No Revolt Roll.'); break;
      case 'provinceRevolted': if (p.player === playerId) rolls.push(`${prov(p.province)} revolted (${p.killed} killed, ${p.survivors} survived).`); break;
      case 'displeasedDrawn': if (p.player === playerId) rolls.push(`Drew Rome Is Displeased: ${card(p.def)}.`); break;
      case 'troopsMoved': if (p.player === playerId) actions.push(`Moved ${plural(p.troops, 'troop')} ${prov(p.from)} → ${prov(p.to)}.`); break;
      case 'provinceAllied': if (p.player === playerId) actions.push(`Allied with ${prov(p.province)}.`); break;
      case 'roadBuilt': if (p.player === playerId) actions.push(`Built a Road in ${prov(p.province)}.`); break;
      case 'wallBuilt': if (p.player === playerId) actions.push(`Built a Wall in ${prov(p.province)}.`); break;
      case 'catapultBought': if (p.player === playerId) actions.push('Bought a Catapult.'); break;
      case 'merchantShipBought': if (p.player === playerId) actions.push(`Bought a Merchant ship on ${prov(p.a)}–${prov(p.b)}.`); break;
      case 'troopsBought': if (p.player === playerId) actions.push(`Bought ${plural(p.n ?? 1, 'troop')} in ${prov(p.province)} for ${p.gold} Gold.`); break;
      case 'prestigeBought': if (p.player === playerId) actions.push(`Bought 1 Prestige for ${p.gold} Gold.`); break;
      case 'gameCardBought': if (p.player === playerId) actions.push('Bought a Game Card.'); break;
      case 'cardPlayed': if (p.player === playerId) actions.push(`Played ${card(p.def)}.`); break;
      case 'spyPlayed': if (p.player === playerId) actions.push(`Stole ${card(p.def)} from ${state.players?.find(x => x.id === p.victim)?.name ?? p.victim}.`); break;   // v31.41 (18.af): the stolen card is public, so the AI's summary names it too
      case 'cardSold': if (p.player === playerId) actions.push(`Sold ${card(p.card)} for ${p.gold} Gold.`); break;
      case 'generalMoved': if (p.player === playerId) actions.push(`Moved the general to ${prov(p.to)}.`); break;
      case 'nativesRolled': if (mine(e)) actions.push(`Scouted ${prov(p.province)}: ${p.count} natives.`); break;
      case 'resourceSaved': if (p.player === playerId) actions.push(`Saved a ${p.piece} card.`); break;
      case 'resourceCardUsed': if (p.player === playerId) actions.push(`Built a free ${p.piece} in ${prov(p.province)}.`); break;
      default: break;
    }
  }
  const sections = [
    { title: 'Gained', lines: gained },
    { title: 'Rolls', lines: rolls },
    { title: 'Actions', lines: actions },
    { title: 'Battles', lines: battles },
  ].filter(s => s.lines.length);
  return { player: playerId, name, turn, sections, skip: sections.length === 0 };
}
/** Attack Builder facts (items 2, 3, 5): the engine's attack preview for the chosen variant. */
export { attackPreview } from '../../engine/index.js';

// ------------------------------------------------------------------ why not (M8 items 3, 4): the engine's own reason, never a guess
/** "Can't play now: no rival conquered province under 10 troops (18.m)." — or the general's protection, when that is the blocker — or null when the card can be played. */
export function cardBlockReason(state, data, pid, uid) {
  const b = cardBlock(state, data, pid, uid); if (!b) return null;
  return `Can't play now: ${b.reason}${b.rule ? ` (${b.rule})` : ''}.`;
}
/** Why `from` cannot attack `target` (any choice of the general), or null. */
export function attackWhy(state, data, pid, from, target) {
  const b = [false, true].map(g => attackBlock(state, data, pid, from, target, { withGeneral: g }));
  if (b.some(x => !x)) return null;
  return (b.find(x => x.code !== 'GENERAL_NOT_THERE') ?? b[0]).reason;
}
/** Why `from` cannot be the origin of any attack, or null. */
export const attackOriginWhy = (state, data, pid, from) => attackOriginBlock(state, data, pid, from)?.reason ?? null;

/** M8.1 (Vidi 2026-10-22): the general view on the setup screen and in-game. Everything comes from data/generals.json (one source of
 * truth, each line carries its rules.md labels); the page only lays it out. Lines: {text, rules: '15.b, 17.k'}. */
export function generalView(data, id) {
  const g = data.generalsById[id]; if (!g) return null;
  const line = l => ({ text: l.text, rules: (l.rule ?? []).join(', ') });
  return {
    id: g.id, name: g.name, title: g.title, quote: g.quote ?? '', summary: g.text, rules: g.rule.join(', '),
    intro: (g.intro ?? []).map(line),
    perks: g.perks.map(p => ({ id: p.id, name: p.name ?? p.id, when: p.when ?? '', withArmy: p.needsWithArmy, attackOnly: !!p.attackOnly, detail: (p.detail ?? []).map(line) })),
    common: (data.generalCommon ?? []).map(line),
  };
}
/** Batch 4 item 5: the one caption for a general (player panel, setup thumbnails, the in-game picker, the detail view's heading):
 *  its current perk name or summary, from data/generals.json through generalView. */
export const generalCaption = (data, id) => generalView(data, id)?.title ?? '';

// ------------------------------------------------------------------ v27 (M15): the "card played" popup (Vidi 2026-10-25)
/** Event types that end a played card's outcome (the next thing happening is no longer this card's effect). */
const PLAY_STOP = new Set(['cardPlayed', 'resourceApplied', 'resourceCardUsed', 'stepStarted', 'battleStarted', 'attackDeclared', 'allyDeclared', 'turnStarted', 'turnEnded',
  'cardDrawn', 'displeasedDrawn', 'diceRolled', 'battleCardsSkipped', 'gameRollStarted', 'revoltRollStarted', 'battleRoundStarted', 'roundStarted']);
const PLAY_QUIET = new Set(['actionSpent', 'garrisonStatusChanged', 'stepChanged', 'phaseChanged', 'framePushed', 'framePopped']);
/** True for an event that shows the card-played popup: any game card played (hand, auto-play, battle, Horn, Roma, Busy Bee) or a Resource card used. */
export const isCardPlay = e => e?.type === 'cardPlayed' || e?.type === 'resourceApplied' || e?.type === 'resourceCardUsed' || e?.type === 'coinMasterBonus';   // v31.37: a Coin Master is SHOWN when its bonus is taken (18.aa, 18.ab)
/**
 * v31.24 (Update 5): a Resource card's application right after its draw is the SAME reveal twice. The engine emits
 * cardDrawn and then, immediately, resourceApplied for a gainResources card (turn.js drawCard); the page shows the draw
 * as a central flip and the application as a second popup on the right. One reveal per draw: the application popup is
 * skipped when it is the very next event after that card's draw (same player, same card). A Resource card used later
 * from the hand (resourceCardUsed, 20.f) is never adjacent to its draw, so it still shows.
 */
export function isRepeatCardReveal(events, i) {
  const e = events[i];
  if (!e || e.type !== 'resourceApplied') return false;
  const prev = events[i - 1];
  return !!prev && prev.type === 'cardDrawn' && prev.pub?.deck === 'resource'
    && prev.pub?.def === e.pub?.def && prev.pub?.player === e.pub?.player;
}
/**
 * The card-played popup for events[i] (v27): which card, WHO played it, and its public outcome — the lines that the
 * following events report until the next card, step or battle. Only public fields are read, so the redacted event list
 * a guest gets yields the same popup (a played card is public, 18.h). Null when events[i] is not a card play.
 */
export function cardPlayPopup(events, i, state, data) {
  const e = events[i]; if (!isCardPlay(e)) return null;
  if (isRepeatCardReveal(events, i)) return null;   // v31.24 (Update 5): the central flip already showed this draw
  const p = e.pub; const defId = p.def; const def = data.cardDefsById[defId] ?? null;
  const nm = id => nameOf(state, id); const who = p.player;
  const outcome = [];
  if (e.type === 'resourceApplied') {
    if (p.gold) outcome.push(`+${p.gold} Gold for ${nm(who)}.`);
    if (p.troops) outcome.push(`${p.troops} troop${p.troops === 1 ? '' : 's'} to place in ${nm(who)}'s provinces.`);
  }
  if (e.type === 'cardPlayed' && p.role) outcome.push(`Played by the ${p.role}${p.round ? ` in round ${p.round}` : ''}${p.source === 'horn' ? '' : ' of the battle'}.`);
  if (e.type === 'cardPlayed' && p.source === 'attackRoma') outcome.push(`${nm(who)} may attack Roma.`);
  if (e.type === 'cardPlayed' && p.dest === 'throwaway') outcome.push('Gone for good — it goes to the throwaway pile, never the discard pile (18.z).');
  if (e.type === 'cardPlayed' && p.inPlay) outcome.push('Stays in play in front of the player.', ...(def?.text ? [def.text] : []));
  if (e.type === 'coinMasterBonus') {   // v31.37 (18.aa, 18.ab): shown, then back to the hand — never played
    const sold = p.sold ? (data.cardDefsById[p.sold]?.name ?? p.sold) : null;
    outcome.push(p.reason === 'sale' ? `+${p.gold} Gold on top of the sale price for selling ${sold} (3 Gold in all).` : `+${p.gold} Gold for leaving ${p.unused} action${p.unused === 1 ? '' : 's'} unused.`, 'The card goes back to the hand: it keeps working while held.');
    return { kind: 'cardPlayed', player: who, playerName: nm(who), human: isHuman(state, who), def: defId, uid: null, deck: 'game', name: def?.name ?? defId, type: def?.type ?? null, verb: 'shows', outcome, battle: false };
  }
  for (let k = i + 1; k < events.length && outcome.length < 7; k++) {
    const x = events[k]; if (PLAY_STOP.has(x.type)) break; if (PLAY_QUIET.has(x.type)) continue;
    // v31.41 (18.af): the stolen card is public now — the popup is the same for every viewer (v27), and its outcome lines
    // are formatted without priv, so the spyPlayed line below names the stolen card for everyone (the thief learns nothing
    // extra here; the victim's remaining hand stays hidden).
    const t = formatEvent({ ...x, priv: undefined }, state, data).text; if (t && !/^[a-zA-Z]+ \{/.test(t)) outcome.push(t.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, id => data.cardDefsById[id]?.name ?? id));
  }
  if (!outcome.length && def?.text) outcome.push(def.text);
  const deck = def?.deck ?? (e.type === 'cardPlayed' ? 'game' : 'resource');
  return { kind: 'cardPlayed', player: who, playerName: nm(who), human: isHuman(state, who), def: defId, uid: p.uid ?? null, deck,
    name: def?.name ?? defId, type: def?.type ?? null, verb: deck === 'resource' ? 'used' : 'played', outcome, battle: def?.type === 'battle' };
}

/**
 * v29 (batch 8): may this screen act for seat `pid` right now? The General popup shows every action button for its player and greys them
 * unless this is true (the player section shows them only for the seat that acts). `who` = whoActs(state); `legal` = this screen's own
 * legal moves (a guest gets only its own seat's from the host, hot-seat only the human who acts). Returns { live, why, legal }.
 */
export function seatActsGate(state, pid, legal, { who = null, busy = false } = {}) {
  const nm = id => nameOf(state, id);
  if (state.phase === 'finished') return { live: false, why: 'The game is over.', legal: [] };
  if (!who) return { live: false, why: 'Nobody can act right now.', legal: [] };
  if (who !== pid) return { live: false, why: `It is ${nm(who)}'s move, not ${nm(pid)}'s.`, legal: [] };
  if (!isHuman(state, pid)) return { live: false, why: `${nm(pid)} is played by the computer.`, legal: [] };
  const own = (legal ?? []).filter(d => (d.playerId ?? pid) === pid);
  if (!own.length) return { live: false, why: `Only ${nm(pid)}'s own screen can act for ${nm(pid)}.`, legal: [] };
  if (busy) return { live: false, why: 'Wait: the last move is still being shown.', legal: own };
  return { live: true, why: '', legal: own };
}
