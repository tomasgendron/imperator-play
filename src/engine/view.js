// What a viewer may see (PLAN 8.1, 9, 6.1). Hot-seat uses the public view for the shared screen and the owner's view for a revealed hand.
// M12 (online plan step c): viewFor is also what an online guest receives, so it redacts the pending prompts of other players, the
// game seed and every hidden card uid anywhere in the state (a uid names its card: g01..g04 are Elephants), and eventsFor drops the
// log lines whose mere existence tells what is in a hand.
import { clone } from './state.js';
import { cyrb128 } from './rng.js';

/** Events as one viewer sees them: `priv` is dropped unless the viewer is in `privTo`. */
export function redactEvents(events, viewerId) {
  return events.map(e => {
    const mine = e.priv && viewerId && e.privTo.includes(viewerId);
    return { seq: e.seq, turn: e.turn, type: e.type, actor: e.actor, rule: e.rule, pub: e.pub, ...(mine ? { priv: e.priv } : {}) };
  });
}

/** Event types that only their actor may see at all: a skipped Horn (the holder had it) and a passed response window (the player
 *  held a card that could answer). Everyone else would learn a hand card from the line existing. */
export const SECRET_EVENTS = new Set(['hornSkipped', 'responsePassed']);

/** The log (or new events) as an online seat receives it: redactEvents, minus SECRET_EVENTS of other players, minus the seed. */
export function eventsFor(events, viewerId) {
  return redactEvents(events.filter(e => !SECRET_EVENTS.has(e.type) || (viewerId && (e.privTo?.includes(viewerId) || e.actor === viewerId))), viewerId)
    .map(e => (e.type === 'gameCreated' && e.pub && 'seed' in e.pub ? { ...e, pub: (({ seed, ...p }) => p)(e.pub) } : e));   // eslint-disable-line no-unused-vars
}

/** Frame fields kept when the frame belongs to someone else (everything else is dropped). The kind, owner and battle stay so the
 *  page can say "Waiting for X" and keep the battle panel up. */
const FRAME_KEEP = ['id', 'kind', 'player', 'resolvableBy', 'battleId'];
const FRAME_PUBLIC = {
  roll: null, draw: null, setupGeneral: null, setupStartProvince: null, placeTroops: null, chooseProvince: null, chooseBorrow: null,
  choosePerk: null, battleContinue: null, placeSurvivors: null, decree: null, rome: null, number: null, natives: null,   // null = all fields public
  chooseBattleCards: ['role', 'attackerPlayed'],   // not `held` (the defs and counts of the hand's battle cards)
  discardCards: ['purpose', 'count'],               // not `options` (the hand's uids)
  resourceBuild: ['piece'],                         // not `card` (its uid); the piece is public once built or saved (Q48)
  responseWindow: [],                               // which window and which card would tell what the hand holds
};
/** A pending frame as `viewerId` sees it: the viewer's own frames in full; another player's with its private fields removed. */
export function redactFrame(f, viewerId) {
  if (viewerId && (f.player === viewerId || (!f.player && f.resolvableBy?.includes(viewerId)))) return f;
  const keep = f.kind in FRAME_PUBLIC ? FRAME_PUBLIC[f.kind] : [];   // an unknown kind: only the basics
  if (keep === null) return f;
  const out = {};
  for (const k of [...FRAME_KEEP, ...keep]) if (k in f) out[k] = f[k];
  if (f.kind === 'responseWindow') out.window = 'hidden';
  if (f.kind === 'discardCards') out.options = { hidden: true, count: f.options?.length ?? 0 };
  return out;
}

/** Replaces every string in `x` that is one of `hidden` (card uids) by '?', in place. */
function scrub(x, hidden) {
  if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { if (typeof x[i] === 'string') { if (hidden.has(x[i])) x[i] = '?'; } else if (x[i] && typeof x[i] === 'object') scrub(x[i], hidden); } return x; }
  if (x && typeof x === 'object') for (const k of Object.keys(x)) { const v = x[k]; if (typeof v === 'string') { if (hidden.has(v)) x[k] = '?'; } else if (v && typeof v === 'object') scrub(v, hidden); }
  return x;
}

/**
 * The state as `viewerId` may see it: no RNG and no seed, no deck order (only sizes), other players' hands replaced by
 * {hidden:true, count}, the card registry reduced to the cards the viewer can see, other players' pending prompts redacted
 * (redactFrame), any other hidden card uid (e.g. battle cards committed but not yet played) replaced by '?', and the log through
 * eventsFor. `viewerId: null` is the public (spectator) view. Saved Road/Wall cards and cards in play are public (Q48).
 */
export function viewFor(state, data, viewerId = null, { log = true } = {}) {
  const { log: fullLog, ...rest } = state;
  const v = clone(rest);
  delete v.rng;
  if (v.config) delete v.config.seed;
  if (typeof v.gameId === 'string') v.gameId = 'g-' + cyrb128(v.gameId).map(x => x.toString(16).padStart(8, '0')).join('').slice(0, 12);   // the id is 'g-' + seed
  const visible = new Set();
  for (const p of v.players) {
    for (const c of p.inPlay) visible.add(c.uid);
    for (const c of p.savedResources) visible.add(c.uid);
    if (p.id === viewerId) { for (const c of p.hand) visible.add(c.uid); }
    else p.hand = { hidden: true, count: p.hand.length };
  }
  for (const d of Object.values(state.discards ?? {})) for (const uid of d) visible.add(uid);   // discard piles are public
  v.decks = Object.fromEntries(Object.entries(state.decks).map(([k, d]) => [k, { count: d.length }]));
  v.cards = Object.fromEntries([...visible].sort().filter(uid => state.cards[uid]).map(uid => [uid, state.cards[uid]]));
  v.pending = (v.pending ?? []).map(f => redactFrame(f, viewerId));
  const hidden = new Set(Object.keys(state.cards).filter(uid => !visible.has(uid)));
  scrub(v.pending, hidden); scrub(v.battle ?? null, hidden); scrub(v.turn ?? null, hidden); scrub(v.setup ?? null, hidden); scrub(v.decree ?? null, hidden);
  if (log) v.log = eventsFor(fullLog ?? [], viewerId);
  v.viewer = viewerId;
  return v;
}
