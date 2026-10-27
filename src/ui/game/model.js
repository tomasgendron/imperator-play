// Pure model of the M5 game page: no DOM, so `node --test` drives exactly what the page shows and clicks.
// The page keeps a console session (src/ui/consoleModel.js) and asks this module who looks at the screen, what a human may do
// now (grouped for the phase bar, the map and the builder), what a card looks like, which sounds an event plays, and how a save file reads.
import { legalActions, whoActs, topFrame, validateState, SCHEMA_VERSION, redactEvents, minGarrison, cardBlock, attackBlock, attackOriginBlock } from '../../engine/index.js';
import { newSession, play, aiToMove, aiMove, stateOf, formatEvent, describePrompt } from '../consoleModel.js';

export { newSession, play, aiToMove, aiMove, stateOf, describePrompt };
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
  ATTACK: 'move', ALLY: 'move', MOVE: 'move', BUY_TROOP: 'buy', BUY_GAME_CARD: 'buy', BUY_CATAPULT: 'build',   // M6: the Catapult is built on the Build screen (item 9)
 
  BUILD_ROAD: 'build', BUILD_WALL: 'build', USE_SAVED_RESOURCE: 'build', PLAY_CARD: 'card', PREVIEW_TARGET: 'scout', END_TURN: 'end',
  SELL_CARD: 'sell', MOVE_GENERAL: 'general',   // M7: free moves with their own buttons (20.p, 15.j)
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
export function soundsFor(e, state = null) {
  switch (e.type) {
    case 'diceRolled': return [e.pub.die === 'd10' ? 'dice_roll_d10' : 'dice_roll_d6'];
    case 'cardDrawn': return ['card_draw'];
    case 'cardPlayed': case 'resourceCardUsed': return ['card_play'];
    case 'troopsMoved': case 'troopsPlaced': case 'survivorsMoved': return ['troops_move'];
    case 'attackDeclared': return ['attack_confirm'];
    case 'battleRoundRolled': return ['battle_round_start'];
    case 'provinceConquered': return ['conquest'];
    case 'provinceAllied': return ['ally_made'];
    case 'provinceRevolted': return ['revolt'];
    case 'romeRoll': return ['rome_roll'];
    case 'senateDecree': return ['senate_decree'];
    case 'deckReshuffled': return ['deck_shuffle'];
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
    placeTroops: 'Place troops', resourceBuild: 'Build now or save the card', chooseProvince: 'Choose a province', chooseBorrow: 'Borrow natives?',
    chooseBattleCards: 'Battle cards', choosePerk: 'General perk', battleContinue: 'Continue the battle?', placeSurvivors: 'Place the survivors',
    discardCards: "The Emperor's tax", responseWindow: { revoltResponse: 'A province revolts!', displeasedResponse: 'Rome is displeased with you', defenceAnnounced: 'You are attacked!' }[f.window] ?? 'Your answer',
  };
  return T[f.kind] ?? f.kind;
}

/** A save file (PLAN 8.6): the full state incl. RNG and hidden hands; a host file, not for sharing mid-game. */
export function makeSave(session, meta = {}) {
  const state = stateOf(session);
  return { schema: SAVE_SCHEMA, schemaVersion: state.schemaVersion, ruleset: session.data.ruleset?.id ?? null, seed: session.seed, snapshot: state, meta: { savedAt: new Date().toISOString(), ...meta } };
}
/** Reads a save (object or JSON text); throws an Error that says what is wrong. Returns a fresh session at the saved state. */
export function readSave(input, data) {
  let o = input;
  if (typeof input === 'string') { try { o = JSON.parse(input); } catch { throw new Error('This is not a JSON file.'); } }
  if (!o || o.schema !== SAVE_SCHEMA) throw new Error(`This is not an Imperator save (schema "${o?.schema ?? 'missing'}", expected "${SAVE_SCHEMA}").`);
  const state = o.snapshot; const made = o.meta?.appVersion ? ` It was made by ${o.meta.appVersion}.` : '';
  if (!state || typeof state !== 'object' || !Array.isArray(state.players)) throw new Error('This save has no game in it (the snapshot is missing).' + made);
  if (state.schemaVersion !== SCHEMA_VERSION) throw new Error(`This save was made by ${state.schemaVersion < SCHEMA_VERSION ? 'an older' : 'a newer'} build (game format ${state.schemaVersion}; this build reads format ${SCHEMA_VERSION}), so it cannot be loaded.${made} The file itself is not changed. Start a new game, or run the build that made it.`);
  let errs;
  try { errs = validateState(state, data); } catch (e) { errs = [e.message]; }
  if (errs.length) throw new Error(`This save does not fit this build's rules data, so it cannot be loaded safely.${made} The file itself is not changed. Details:\n` + errs.slice(0, 5).join('\n'));
  return { data, seed: o.seed ?? 'loaded', steps: [{ state, events: [], action: null, error: null }] };
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
  return { kind: 'gameRoll', value: v, title, lines, art, players: [...players], matched };
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
    const ok = saved.length && buildSteps(state, data, legal).pieces.find(x => x.piece === piece)?.provinces.some(p => p.free || p.facings?.some(f => f.free));
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
  for (const x of immune) lines.push(`${provName(data, x.pub.province)} has number ${v} but ${x.pub.troops} troops: 10 or more never revolt (17.c).`);
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
  if (p.outcome === 'conquered') {
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
  if (p.outcome === 'conquered') {
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

const DISPLEASED_RESULT = { generalRecalled: 'recalled_to_rome', goldConfiscated: 'confiscates_gold', provinceRemoved: 'removed_from_province', troopsStolen: 'steals_troops', cardsTaxed: 'taxes_you' };
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
  if (e.type === 'cardsTaxed') lines.push(`${nm(pid)}, you lose ${p.n} saved card(s): ${p.defs.map(d => data.cardDefsById[d]?.name ?? d).join(', ')} (18.u).`);
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
 * why not; per piece the provinces (and for a Wall the borders), each with its paid descriptor and its free saved-card descriptor.
 * For the resourceBuild frame (a Bonus Road/Wall card just drawn), `frame` is set and the piece is fixed (build free or save).
 */
export function buildSteps(state, data, legal) {
  const f = topFrame(state);
  const pid = whoActs(state); const pl = playerById(state, pid); const c = data.rules.costs;
  if (f?.kind === 'resourceBuild') {
    const piece = f.piece; const provs = {};
    for (const d of legal.filter(x => x.type === 'RESOURCE_BUILD' && x.action.mode === 'build')) {
      const p = (provs[d.action.province] ??= { id: d.action.province, name: provName(data, d.action.province), paid: null, free: d.action.facing ? null : d, facings: [] });
      if (d.action.facing) p.facings.push({ id: d.action.facing, name: provName(data, d.action.facing), paid: null, free: d });
    }
    return { frame: true, pieces: [{ piece, name: piece === 'road' ? 'Road' : 'Wall', cost: 0, enabled: true, reason: '', free: true, provinces: Object.values(provs) }], save: legal.find(x => x.type === 'RESOURCE_BUILD' && x.action.mode === 'save') ?? null };
  }
  const left = state.phase === 'turn' ? data.rules.actionsPerTurn - state.turn.actionsUsed : 0;
  const mine = Object.keys(state.provinces).sort().filter(id => state.provinces[id].owner === pid);
  const saved = piece => (pl?.savedResources ?? []).filter(x => data.cardDefsById[state.cards[x.uid].def]?.effect?.params?.piece === piece).length;
  const mk = (piece, name, cost) => {
    const provs = {};
    const paidT = piece === 'road' ? 'BUILD_ROAD' : 'BUILD_WALL';
    for (const d of legal.filter(x => x.type === paidT || (x.type === 'USE_SAVED_RESOURCE' && data.cardDefsById[state.cards[x.action.cardUid].def]?.effect?.params?.piece === piece))) {
      const id = d.action.province; const kind = d.type === paidT ? 'paid' : 'free';
      const p = (provs[id] ??= { id, name: provName(data, id), paid: null, free: null, facings: [] });
      if (piece === 'road') { if (!p[kind]) p[kind] = d; continue; }
      let fc = p.facings.find(x => x.id === d.action.facing); if (!fc) p.facings.push(fc = { id: d.action.facing, name: provName(data, d.action.facing), paid: null, free: null });
      if (!fc[kind]) fc[kind] = d;
    }
    const list = Object.values(provs);
    const nSaved = saved(piece); const anyPaid = list.some(p => p.paid || p.facings.some(x => x.paid));
    let reason = '';
    if (!list.length) {
      const room = piece === 'road' ? mine.some(id => !state.provinces[id].road) : mine.some(id => data.provincesById[id] && [...data.provincesById[id].land, ...data.provincesById[id].sea].some(n => !state.provinces[id].walls.includes(n)));
      reason = !room ? (piece === 'road' ? 'every one of your provinces already has a Road' : 'every border of your provinces already has a Wall')
        : left <= 0 ? `no actions left this turn (${data.rules.actionsPerTurn}/${data.rules.actionsPerTurn} used)` : (pl?.gold ?? 0) < cost ? `needs ${cost} Gold, you have ${pl?.gold ?? 0}` : 'not possible right now';
    } else if (!anyPaid) reason = left <= 0 ? `paying needs an action: none left (${data.rules.actionsPerTurn}/${data.rules.actionsPerTurn} used)` : (pl?.gold ?? 0) < cost ? `paying needs ${cost} Gold, you have ${pl?.gold ?? 0}` : '';
    return { piece, name, cost, enabled: list.length > 0, reason, saved: nSaved, provinces: list };
  };
  const cat = legal.find(x => x.type === 'BUY_CATAPULT') ?? null; const catCost = data.itemsById.catapult.cost.gold;
  const catalog = { piece: 'catapult', name: 'Catapult', cost: catCost, enabled: !!cat, reason: cat ? '' : left <= 0 ? `no actions left this turn (${data.rules.actionsPerTurn}/${data.rules.actionsPerTurn} used)` : (pl?.gold ?? 0) < catCost ? `needs ${catCost} Gold, you have ${pl?.gold ?? 0}` : 'not possible right now', saved: 0, provinces: [], paid: cat, owned: pl?.items?.catapult ?? 0 };
  return { frame: false, gold: pl?.gold ?? 0, actionsLeft: left, pieces: [mk('road', 'Road', c.road), mk('wall', 'Wall', c.wall), catalog] };
}

/**
 * M7 item 4: the step-by-step Buy screen, like Build: what (a troop or a Game Card, with costs; greyed with a reason) -> where -> pay.
 * Returns {gold, actionsLeft, sellable, items:[{item, name, cost, costText, enabled, reason, provinces:[{id, name, troops, enabled, reason, paid}]}]}.
 * No card makes a troop or a Game Card free (the troop Resource cards are taken at once, 20.b), so paying is Gold only (Q107).
 */
export function buySteps(state, data, legal) {
  const pid = whoActs(state); const pl = playerById(state, pid); const c = data.rules.costs; const gold = pl?.gold ?? 0;
  const left = state.phase === 'turn' ? data.rules.actionsPerTurn - state.turn.actionsUsed : 0;
  const mine = Object.keys(state.provinces).sort().filter(id => state.provinces[id].owner === pid);
  const noAct = `no actions left this turn (${data.rules.actionsPerTurn}/${data.rules.actionsPerTurn} used)`;
  const sellable = legal.filter(d => d.type === 'SELL_CARD').length;
  const short = cost => `needs ${cost} Gold, you have ${gold}${sellable ? ` (selling a card gives ${data.rules.sellCard?.gold ?? 2} Gold)` : ''}`;
  const troopProvs = mine.map(id => {
    const d = legal.find(x => x.type === 'BUY_TROOP' && x.action.province === id) ?? null; const p = state.provinces[id];
    return { id, name: provName(data, id), troops: p.troops, enabled: !!d, paid: d, reason: d ? '' : id === 'roma' ? `Roma is full (${data.rules.romaMaxTroops} troops at most, 12.k)` : 'not possible right now' };
  });
  const cardProvs = mine.map(id => {
    const d = legal.find(x => x.type === 'BUY_GAME_CARD' && x.action.fromProvince === id) ?? null; const p = state.provinces[id];
    return { id, name: provName(data, id), troops: p.troops, enabled: !!d, paid: d, reason: d ? '' : p.troops <= c.gameCardTroops ? `only ${p.troops} troop: at least 1 must stay (17.f)` : p.status === 'held' ? `Roma must keep ${data.rules.romaFloorOnHold} while held` : 'not possible right now' };
  });
  const why = (list, cost, extra) => (list.some(x => x.enabled) ? '' : left <= 0 ? noAct : gold < cost ? short(cost) : extra() || 'not possible right now');
  const troop = { item: 'troop', name: 'Troop', cost: c.troop, costText: `${c.troop} Gold · 1 action`, provinces: troopProvs };
  troop.reason = why(troopProvs, c.troop, () => (!mine.length ? 'you control no province' : '')); troop.enabled = !troop.reason;
  const card = { item: 'gameCard', name: 'Game Card', cost: c.gameCardGold, costText: `${c.gameCardGold} Gold + ${c.gameCardTroops} troop · 1 action · max 1 per turn`, provinces: cardProvs };
  card.reason = state.turn?.gameCardBought ? 'you already bought a Game Card this turn (max 1, 17.s)' : why(cardProvs, c.gameCardGold, () => (mine.every(id => state.provinces[id].troops <= c.gameCardTroops) ? 'no province can pay a troop and keep 1 (17.f)' : ''));
  card.enabled = !card.reason;
  return { gold, actionsLeft: left, sellable, items: [troop, card] };
}

/** The minimum garrison the page shows for a province (item 6): conquered AND starting provinces (a start province: flat 1, 17.t); null otherwise. */
export function shownMin(state, data, id) {
  const p = state.provinces[id];
  return p?.owner && (p.status === 'conquered' || p.status === 'starting') ? minGarrison(state, data, id) : null;
}
/** Attack Builder facts (items 2, 3, 5): the engine's attack preview for the chosen variant. */
export { attackPreview } from '../../engine/index.js';

// ------------------------------------------------------------------ why not (M8 items 3, 4): the engine's own reason, never a guess
/** "Can't play now: no rival conquered province under 10 troops (18.m)." or null when the card can be played. */
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
export const isCardPlay = e => e?.type === 'cardPlayed' || e?.type === 'resourceApplied' || e?.type === 'resourceCardUsed';
/**
 * The card-played popup for events[i] (v27): which card, WHO played it, and its public outcome — the lines that the
 * following events report until the next card, step or battle. Only public fields are read, so the redacted event list
 * a guest gets yields the same popup (a played card is public, 18.h). Null when events[i] is not a card play.
 */
export function cardPlayPopup(events, i, state, data) {
  const e = events[i]; if (!isCardPlay(e)) return null;
  const p = e.pub; const defId = p.def; const def = data.cardDefsById[defId] ?? null;
  const nm = id => nameOf(state, id); const who = p.player;
  const outcome = [];
  if (e.type === 'resourceApplied') {
    if (p.gold) outcome.push(`+${p.gold} Gold for ${nm(who)}.`);
    if (p.troops) outcome.push(`${p.troops} troop${p.troops === 1 ? '' : 's'} to place in ${nm(who)}'s provinces.`);
  }
  if (e.type === 'cardPlayed' && p.role) outcome.push(`Played by the ${p.role}${p.round ? ` in round ${p.round}` : ''}${p.source === 'horn' ? '' : ' of the battle'}.`);
  if (e.type === 'cardPlayed' && p.source === 'attackRoma') outcome.push(`${nm(who)} may attack Roma.`);
  if (e.type === 'cardPlayed' && p.inPlay) outcome.push('Stays in play in front of the player.', ...(def?.text ? [def.text] : []));
  for (let k = i + 1; k < events.length && outcome.length < 7; k++) {
    const x = events[k]; if (PLAY_STOP.has(x.type)) break; if (PLAY_QUIET.has(x.type)) continue;
    const t = formatEvent(x, state, data).text; if (t && !/^[a-zA-Z]+ \{/.test(t)) outcome.push(t.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, id => data.cardDefsById[id]?.name ?? id));
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
