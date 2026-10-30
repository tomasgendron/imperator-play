// v30.5 (Vidi via Boardicca 2026-10-29, the iPhone guest who lost her seat): the seats this browser holds in online games, one
// entry PER ROOM in localStorage['imperator.online.seats'] = {CODE: {token, seat, name, at, was?}}. Kept when the page goes back to
// the start screen, reloads, or switches view (mobile <-> desktop share the key); removed only when the game is over, when the
// player leaves for good, or after SEAT_TTL_MS. The legacy single entry (M14, 'imperator.online.seat') is read too and still
// written, so an older page of the same origin keeps working. Every hello sends all these tokens, so a typed new code (the host
// resumed under a new room code) still finds the seat. Pure: `store` is localStorage or a stand-in ({getItem, setItem, removeItem}).
import { normCode } from './protocol.js';

export const SEATS_KEY = 'imperator.online.seats';
export const LEGACY_SEAT_KEY = 'imperator.online.seat';
export const SEAT_TTL_MS = 48 * 3600 * 1000;
const MAX = 12;
const read = (store, k) => { try { return JSON.parse(store?.getItem(k) || 'null'); } catch { return null; } };
const write = (store, k, v) => { try { if (v == null) store?.removeItem(k); else store?.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/** Every saved seat, newest first, the expired ones dropped: [{code, token, seat, name, at, was}]. */
export function savedSeats(store, now = Date.now()) {
  const all = read(store, SEATS_KEY); const map = all && typeof all === 'object' && !Array.isArray(all) ? { ...all } : {};
  const leg = read(store, LEGACY_SEAT_KEY);
  if (leg?.code && leg.token && !Object.values(map).some(e => e?.token === leg.token)) map[normCode(leg.code)] = { token: leg.token, seat: leg.seat ?? null, name: leg.name ?? null, at: leg.at ?? now };
  const list = Object.entries(map).filter(([c, e]) => c && e && typeof e.token === 'string' && now - (e.at ?? 0) < SEAT_TTL_MS)
    .map(([code, e]) => ({ code, token: e.token, seat: e.seat ?? null, name: e.name ?? null, at: e.at ?? 0, ...(e.was ? { was: e.was } : {}) }));
  return list.sort((a, b) => b.at - a.at);
}
function save(store, list) {
  const map = {}; for (const e of list.slice(0, MAX)) map[e.code] = { token: e.token, seat: e.seat, name: e.name, at: e.at, ...(e.was ? { was: e.was } : {}) };
  write(store, SEATS_KEY, map);
  const top = list[0]; write(store, LEGACY_SEAT_KEY, top ? { code: top.code, token: top.token, seat: top.seat, at: top.at } : null);
}
/** A welcome: this browser holds `seat` in room `code` with `token`. The same token under another code (a resumed game) moves. */
export function rememberSeat(store, code, { token, seat = null, name = null, was = null } = {}, now = Date.now()) {
  code = normCode(code); if (!code || !token) return;
  const rest = savedSeats(store, now).filter(e => e.code !== code && e.token !== token);
  save(store, [{ code, token, seat, name, at: now, ...(was && normCode(was) !== code ? { was: normCode(was) } : {}) }, ...rest]);
}
/** The game is over, or the player left it for good: forget the room `code` (and any entry with the same token). */
export function forgetSeat(store, code, now = Date.now()) {
  code = normCode(code); const e = savedSeats(store, now).find(x => x.code === code);
  save(store, savedSeats(store, now).filter(x => x.code !== code && (!e || x.token !== e.token)));
}
/** The tokens to send in a hello to room `code`: that room's first, then the old code's (?was=), then every other saved seat. */
export function tokensFor(store, code, was = '', now = Date.now()) {
  code = normCode(code); was = normCode(was || '');
  const list = savedSeats(store, now); const rank = e => (e.code === code ? 0 : was && e.code === was ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.at - a.at).map(e => e.token).filter((t, i, a) => a.indexOf(t) === i).slice(0, MAX);
}
export const seatFor = (store, code, now = Date.now()) => savedSeats(store, now).find(e => e.code === normCode(code)) ?? null;
/** The newest saved seat (the start screen's "Rejoin game"), or null. */
export const latestSeat = (store, now = Date.now()) => savedSeats(store, now)[0] ?? null;

/** v30.5: what was typed or pasted into a "Room code" field: a code ("abc 123"), a whole join link (…?join=CODE&claim=X&was=OLD),
 *  or a 12-character room code + rejoin code as the host may read it out ("ABC123-XYZ789"). Returns {code, claim, was}. */
export function parseJoin(input) {
  const s = String(input ?? '').trim();
  const q = s.match(/[?&#]join=([^&#\s]+)/i);
  if (q) {
    const get = k => (s.match(new RegExp(`[?&#]${k}=([^&#\\s]+)`, 'i')) || [])[1] ?? '';
    return { code: normCode(decodeURIComponent(q[1])), claim: normCode(decodeURIComponent(get('claim'))) || null, was: normCode(decodeURIComponent(get('was'))) || '' };
  }
  const c = normCode(s);
  if (c.length === 12) return { code: c.slice(0, 6), claim: c.slice(6), was: '' };
  return { code: c, claim: null, was: '' };
}
