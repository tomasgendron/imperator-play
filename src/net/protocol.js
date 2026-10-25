// M11-M12 (online plan steps b-c): the host/guest protocol. Versioned JSON messages over any transport (src/net/transport.js).
// The host's browser is authoritative: it runs the engine, rolls every die (state.rng never leaves it) and sends each guest a
// view and that guest's legal moves. Guests run no engine; they send actions and render what they get.
//
//   guest -> host   hello {proto, build, name, token?}      join the lobby, or take back a seat with its token
//                   act   {seq, action}                      a move for the guest's own seat (any `dice` is ignored)
//                   pong  {n}                                answer to ping
//                   resync {}                                the events did not line up (a lost update): send everything again
//                   bye   {}                                 leaving
//   host -> guest   welcome {proto, build, code, seat, token}   seat = seat index (0-based); token = keep it to rejoin
//                   lobby   {seats: [{i, name, kind, taken, connected}], started}
//                   update  {seq, by, view, events, from, to, full, legal, you: {seat, playerId, ai}, seats}
//                           view = the engine's viewFor(state, data, playerId) without its log (M12, step c); events = that seat's
//                           log entries with from < seq <= to (eventsFor); full = true: events is the whole log (welcome, resync)
//                   reject  {seq?, code, message}            the move (or the hello) was refused; a hello refusal is followed by bye
//                   ping    {n}
//                   bye     {reason}
import { viewFor, eventsFor } from '../engine/view.js';
export const PROTO = 2;   // M12: updates carry viewFor views and only the new events
export const TYPES = ['hello', 'welcome', 'lobby', 'act', 'reject', 'update', 'ping', 'pong', 'resync', 'bye'];

/** A message as a plain object, or null when it is not one of ours (wrong shape, unknown type, wrong protocol in a hello). */
export function parse(msg) {
  const m = typeof msg === 'string' ? (() => { try { return JSON.parse(msg); } catch { return null; } })() : msg;
  if (!m || typeof m !== 'object' || Array.isArray(m) || !TYPES.includes(m.t)) return null;
  return m;
}
export const msg = (t, body = {}) => ({ t, ...body });

/** What one seat receives of the state (M12, online step c): the engine's own per-seat view (viewFor: no rng, no seed, no deck
 *  order, other hands as {hidden, count}, other players' prompts redacted, hidden uids replaced by '?'), without the log. */
export const seatView = (state, data, playerId) => viewFor(state, data, playerId, { log: false });
/** The seat's log entries after event seq `after` (eventsFor: priv only for its addressees, secret lines dropped, no seed). */
export const seatEvents = (log, after, playerId) => eventsFor((log ?? []).filter(e => e.seq > after), playerId);
/** Events with `priv` kept only when `seat` is in `privTo` (kept for older callers; seatEvents is what the host sends). */
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
