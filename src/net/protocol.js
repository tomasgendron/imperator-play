// M11 (online plan step b): the host/guest protocol. Versioned JSON messages over any transport (src/net/transport.js).
// The host's browser is authoritative: it runs the engine, rolls every die (state.rng never leaves it) and sends each guest a
// view and that guest's legal moves. Guests run no engine; they send actions and render what they get.
//
//   guest -> host   hello {proto, build, name, token?}      join the lobby, or take back a seat with its token
//                   act   {seq, action}                      a move for the guest's own seat (any `dice` is ignored)
//                   pong  {n}                                answer to ping
//                   bye   {}                                 leaving
//   host -> guest   welcome {proto, build, code, seat, token}   seat = seat index (0-based); token = keep it to rejoin
//                   lobby   {seats: [{i, name, kind, taken, connected}], started}
//                   update  {seq, by, view, events, legal, you: {seat, playerId, ai}, seats}
//                   reject  {seq?, code, message}            the move (or the hello) was refused; a hello refusal is followed by bye
//                   ping    {n}
//                   bye     {reason}
export const PROTO = 1;
export const TYPES = ['hello', 'welcome', 'lobby', 'act', 'reject', 'update', 'ping', 'pong', 'bye'];
export const LOG_TAIL = 300;   // the page's log shows the last 150 lines (model.js logFor reads 2x that); older lines are not sent

/** A message as a plain object, or null when it is not one of ours (wrong shape, unknown type, wrong protocol in a hello). */
export function parse(msg) {
  const m = typeof msg === 'string' ? (() => { try { return JSON.parse(msg); } catch { return null; } })() : msg;
  if (!m || typeof m !== 'object' || Array.isArray(m) || !TYPES.includes(m.t)) return null;
  return m;
}
export const msg = (t, body = {}) => ({ t, ...body });

/** The seat's view of the state that a guest receives (step b, minimal; step c makes it a real per-seat view with viewFor):
 *  - no `rng` (nobody but the host may predict a die),
 *  - deck order hidden (each deck is a list of '?' of the same length) and the cards still in a deck dropped from the registry,
 *  - the log cut to its last LOG_TAIL entries, and each entry's private part kept only for the players it is for.
 *  NOT yet hidden (step c): the other players' hand cards (their uids and defs are in the state; the page only shows counts) and
 *  the pending prompts (e.g. a Horn offer names its card). */
export function guestView(state, seat) {
  const { rng, log, decks, cards, ...rest } = state;
  const v = structuredClone(rest);
  const inDeck = new Set(Object.values(decks ?? {}).flat());
  v.decks = Object.fromEntries(Object.entries(decks ?? {}).map(([k, d]) => [k, d.map(() => '?')]));
  v.cards = Object.fromEntries(Object.entries(cards ?? {}).filter(([uid]) => !inDeck.has(uid)));
  v.log = redactFor((log ?? []).slice(-LOG_TAIL), seat);
  return v;
}
/** Events (or log entries) with `priv` kept only when `seat` is in `privTo` (privTo itself stays, the page reads it). */
export const redactFor = (events, seat) => events.map(e => (e.priv && !(seat && e.privTo?.includes(seat)) ? (({ priv, ...x }) => x)(e) : e));

/** An action as the host accepts it from a guest: a plain object with a type; never a rigged-dice queue. */
export function cleanAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.type !== 'string') return null;
  const { dice, ...rest } = a;   // eslint-disable-line no-unused-vars
  return JSON.parse(JSON.stringify(rest));
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1
export function roomCode(rnd = Math.random) { let s = ''; for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]; return s; }
export const normCode = c => String(c ?? '').trim().toUpperCase().replace(/^IMPERATOR-/, '').replace(/[^A-Z0-9]/g, '');
export const peerIdOf = code => 'imperator-' + normCode(code);
export const token = (rnd = Math.random) => Array.from({ length: 4 }, () => Math.floor(rnd() * 2 ** 32).toString(36)).join('');
