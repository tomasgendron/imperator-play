// M11 (online plan step b): the host's room. Pure (no DOM): the page and the Node tests drive the same object.
// The host's browser runs the engine; this object only keeps the seat table, checks who may send what, and sends each guest its
// view of every step together with that guest's legal moves. It never applies an action itself: `onAct` (the page's apply, or a
// test's consoleModel.play) does, so the engine's own checks (NOT_YOUR_TURN, NOT_YOUR_PROMPT, illegal moves) decide, and any
// `dice` a guest sends is stripped before that (only the host's state.rng rolls).
import { PROTO, parse, msg, seatView, seatEvents, cleanAction, token as newToken } from './protocol.js';
import { humanLegal } from '../ui/game/model.js';

export const PING_MS = 5000, AWAY_MS = 15000;
export const BUILD_MISMATCH = (host, guest) => `This game was started with Imperator ${host}, but your page is ${guest}. Reload the page (Ctrl+F5) so both of you play the same version, then join again.`;
export const STARTED_MSG = 'This game has already started, and this device has no seat in it. If it is your seat, ask the host for a rejoin link: on the host\'s screen, your seat → "Let a new device take this seat".';
export const BAD_CLAIM_MSG = 'That rejoin code does not work: it was already used, the host made a newer one, or the game is over. Ask the host for a new rejoin link.';
export const SEAT_IN_USE_MSG = 'That seat is in use: its player is connected right now. Only the host can hand it to another device.';
const CLAIM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normClaim = c => String(c ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanName = (s, i) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || `Guest ${i + 1}`;

export class HostRoom {
  /** seats: [{kind: 'local'|'remote'|'ai', name}] (exactly one 'local' = the host). hooks: {onLobby(room), onAct(seatIndex, action, reply(error|null)),
   *  onSeat(room, seatIndex) a seat's connection or kind changed}. */
  constructor({ transport, build, code, seats, data, hooks = {}, now = () => Date.now(), rnd = Math.random }) {
    Object.assign(this, { transport, build, code, data, hooks, now, rnd });
    this.seats = seats.map((x, i) => ({ i, kind: x.kind, name: x.kind === 'remote' ? '' : x.name, peer: null, token: null, connected: false, lastSeen: 0, playerId: null }));
    this.started = false; this.last = null; this.pingN = 0;
    transport.onMessage((p, m) => this.receive(p, m));
    transport.onPeerClose(p => { const s = this.bySeatPeer(p); if (s) { s.connected = false; s.peer = null; this.changed(s.i); } });
  }
  bySeatPeer(p) { return this.seats.find(s => s.peer === p) ?? null; }
  /** `connected` = the seat is playable (a guest seat: its guest answers). `guest` = an AI seat that once had a guest: whether that
   *  guest is connected now (M14: the host may give the seat back). */
  lobby() { return { code: this.code, started: this.started, seats: this.seats.map(s => ({ i: s.i, kind: s.kind, name: s.name, taken: !!s.token, connected: s.kind !== 'remote' || s.connected,
    ...(s.kind === 'ai' && s.token ? { returnable: true, guestConnected: !!s.connected } : {}) })) }; }
  /** Every Online seat has its guest (and is connected): the host may start. */
  ready() { return this.seats.every(s => s.kind !== 'remote' || (s.token && s.connected)); }
  changed(i) { this.hooks.onSeat?.(this, i); this.sendLobby(); }
  sendLobby() { const l = msg('lobby', this.lobby()); for (const s of this.seats) if (s.peer) this.transport.send(s.peer, l); this.hooks.onLobby?.(this); }
  reject(peer, code, message, extra = {}) { this.transport.send(peer, msg('reject', { code, message, ...extra })); }

  receive(peer, raw) {
    const m = parse(raw); if (!m) return;
    const seat = this.bySeatPeer(peer);
    if (seat) { seat.lastSeen = this.now(); if (!seat.connected && m.t !== 'bye') { seat.connected = true; this.changed(seat.i); } }
    if (m.t === 'hello') return this.hello(peer, m);
    if (m.t === 'pong') return;
    if (m.t === 'resync') { if (seat && this.started && this.last) { this.resyncs = (this.resyncs ?? 0) + 1; this.hooks.onResync?.(seat.i, m.why ?? null); this.sendUpdate(seat, this.last, { full: true, resync: true }); } return; }
    if (m.t === 'bye') { if (seat) { seat.connected = false; seat.peer = null; this.changed(seat.i); } return; }
    if (m.t !== 'act') return;
    if (!seat) return this.reject(peer, 'NOT_SEATED', 'You have no seat in this game.', { seq: m.seq });
    if (!this.started) return this.reject(peer, 'NOT_STARTED', 'The game has not started yet.', { seq: m.seq });
    if (seat.kind !== 'remote') return this.reject(peer, 'SEAT_IS_AI', 'The host gave your seat to the AI.', { seq: m.seq });
    const action = cleanAction(m.action);   // drops any `dice`: the host's own dice roll
    if (!action) return this.reject(peer, 'BAD_ACTION', 'That move could not be read.', { seq: m.seq });
    if (action.playerId !== seat.playerId) return this.reject(peer, 'WRONG_SEAT', 'You can only move for your own seat.', { seq: m.seq });
    if (this.last && Number.isInteger(m.seq) && m.seq !== this.last.seq) return this.reject(peer, 'STALE', 'The game moved on before your move arrived; choose again.', { seq: m.seq });
    // v26.1: a busy host page queues the move; `fresh()` checks the seq again when it is applied, so a move re-sent after a long
    // wait (the guest's pending timeout) can never be applied twice: the second copy is STALE by then
    const fresh = () => !(this.last && Number.isInteger(m.seq) && m.seq !== this.last.seq);
    this.hooks.onAct?.(seat.i, action, error => { if (error) this.reject(peer, error.code ?? 'ILLEGAL', error.message ?? String(error), { seq: m.seq }); }, fresh);
  }
  hello(peer, m) {
    if (m.proto !== PROTO || m.build !== this.build) {
      this.reject(peer, 'BUILD_MISMATCH', m.proto !== PROTO ? BUILD_MISMATCH(this.build, `an incompatible version (protocol ${m.proto})`) : BUILD_MISMATCH(this.build, m.build ?? 'an unknown version'));
      this.transport.send(peer, msg('bye', { reason: 'BUILD_MISMATCH' })); return;
    }
    // v30.5: a hello carries every seat token this browser holds (`tokens`, newest first; `token` as before), so a typed new code
    // (the host resumed under a new room code) still finds the seat; or a one-time claim code the host made for this seat
    // (the extra `tokens` only find a seat nobody holds right now: another player's seat on a shared browser is never taken by them)
    const extra = (Array.isArray(m.tokens) ? m.tokens.slice(0, 16) : []).filter(t => typeof t === 'string' && t);
    let seat = m.token ? this.seats.find(s => s.token && s.token === m.token) ?? null : null;
    if (!seat && extra.length) seat = this.seats.find(s => s.token && extra.includes(s.token) && !(s.connected && s.peer && s.peer !== peer)) ?? null;
    if (!seat && typeof m.claim === 'string' && m.claim) return this.claimHello(peer, m);
    if (!seat) {
      if (this.started) { this.reject(peer, 'STARTED', STARTED_MSG); this.transport.send(peer, msg('bye', { reason: 'STARTED' })); return; }
      seat = this.seats.find(s => s.kind === 'remote' && !s.token);
      if (!seat) { this.reject(peer, 'FULL', 'This game has no free seat.'); this.transport.send(peer, msg('bye', { reason: 'FULL' })); return; }
      seat.token = newToken(this.rnd); seat.name = cleanName(m.name, seat.i);
    }
    this.seatIn(peer, seat);
  }
  seatIn(peer, seat) {
    if (seat.peer && seat.peer !== peer) this.transport.send(seat.peer, msg('bye', { reason: 'REPLACED' }));   // the same player from a new tab
    Object.assign(seat, { peer, connected: true, lastSeen: this.now(), sentTo: null });   // sentTo null: its next update has the whole log
    this.transport.send(peer, msg('welcome', { proto: PROTO, build: this.build, code: this.code, seat: seat.i, token: seat.token, name: seat.name }));
    this.changed(seat.i);
    if (this.started && this.last) this.sendUpdate(seat, this.last);   // a rejoin mid-game gets the whole current view at once
  }
  /** v30.5, the host's reseat tool ("Let a new device take this seat"): a one-time claim code for seat i, a guest seat that is not
   *  connected now (away, never taken, or played by the AI after its player left). A new claim for the same seat replaces the old
   *  one. Returns the code, or null (an occupied, host or plain AI seat). */
  claimable(i) { const s = this.seats[i]; return !!s && !s.connected && (s.kind === 'remote' || (s.kind === 'ai' && !!s.token)); }
  claim(i) {
    if (!this.claimable(i)) return null;
    this.claims ??= new Map();
    for (const [k, v] of this.claims) if (v === i) this.claims.delete(k);
    let c; do { c = Array.from({ length: 6 }, () => CLAIM_CHARS[Math.floor(this.rnd() * CLAIM_CHARS.length)]).join(''); } while (this.claims.has(c));
    this.claims.set(c, i); return c;
  }
  claimOf(i) { for (const [k, v] of this.claims ?? []) if (v === i) return k; return null; }
  /** Every claim code stops working (the game is over, the room closes). */
  dropClaims() { this.claims?.clear(); }
  claimHello(peer, m) {
    const c = normClaim(m.claim); const i = this.claims?.get(c);
    const no = (code, text) => { this.reject(peer, code, text); this.transport.send(peer, msg('bye', { reason: code })); };
    if (i === undefined || this.last?.state?.phase === 'finished') return no('BAD_CLAIM', BAD_CLAIM_MSG);
    const seat = this.seats[i];
    if (seat.connected && seat.peer) return no('SEAT_IN_USE', SEAT_IN_USE_MSG);   // an impostor (or a stale link) cannot take a seat in use
    this.claims.delete(c);   // single use
    const wasAI = seat.kind === 'ai';
    seat.token = newToken(this.rnd);   // the old device's token stops working: the seat is this device's now
    if (!seat.name) seat.name = cleanName(m.name, seat.i);
    this.seatIn(peer, seat);
    this.hooks.onClaimed?.(this, seat.i, { wasAI });
  }
  /** The host changed the setup (lobby only): seat kinds and the names of the host's and AI seats. A guest keeps its seat when it is
   *  still Online, otherwise moves to a free Online seat, otherwise is told its seat is gone. Sends the lobby only when it changed. */
  configure(seats) {
    if (this.started) return;
    const before = JSON.stringify(this.lobby());
    const old = this.seats;
    const next = seats.map((x, i) => {
      const o = old[i];
      if (x.kind === 'remote' && o?.kind === 'remote') return { ...o, i };
      return { i, kind: x.kind, name: x.kind === 'remote' ? '' : x.name, peer: null, token: null, connected: false, lastSeen: 0, playerId: null };
    });
    for (const s of next) if (s.kind !== 'remote') s.name = seats[s.i].name;
    for (const o of old) {
      if (!o.token || next.some(s => s.token === o.token)) continue;
      const free = next.find(s => s.kind === 'remote' && !s.token);
      if (free) Object.assign(free, { name: o.name, peer: o.peer, token: o.token, connected: o.connected, lastSeen: o.lastSeen });
      else if (o.peer) { this.reject(o.peer, 'SEAT_REMOVED', 'The host removed your seat.'); this.transport.send(o.peer, msg('bye', { reason: 'SEAT_REMOVED' })); }
    }
    this.seats = next;
    if (JSON.stringify(this.lobby()) !== before) this.changed(null);
  }
  /** The host pressed Start: `playerIds[i]` is seat i's engine player id. */
  start(playerIds) { this.started = true; this.seats.forEach((s, i) => { s.playerId = playerIds[i]; }); this.sendLobby(); }
  /** After every applied step (and once at the start): {seq, state, events, by}. Every connected guest gets its own view. */
  update(step) { this.last = step; if (step?.state?.phase === 'finished') this.dropClaims(); for (const s of this.seats) if (s.peer) this.sendUpdate(s, step); }
  /** One seat's update: its viewFor view (no log) + the log entries it has not had yet (all of them after a welcome or a resync). */
  sendUpdate(s, step, { full = false, resync = false } = {}) {
    const pid = s.playerId; const log = step.state.log ?? [];
    const to = log.length ? log[log.length - 1].seq : 0;
    full = full || s.sentTo == null || s.sentTo > to;
    const from = full ? 0 : s.sentTo;
    this.transport.send(s.peer, msg('update', {
      seq: step.seq, by: step.by ?? null, view: seatView(step.state, this.data, pid), events: seatEvents(log, from, pid), from, to, full,
      legal: s.kind === 'remote' ? humanLegal(step.state, this.data, pid) : [], you: { seat: s.i, playerId: pid, ai: s.kind === 'ai' }, seats: this.lobby().seats, ...(resync ? { resync: true } : {}),
    }));
    s.sentTo = to;
  }
  /** The host's "give this seat to the AI" button (a dropped or away player). The page switches the engine controller to 'ai'.
   *  M14: the guest keeps its token, so the seat can be given back (seatBack) when the friend returns. */
  seatToAI(i) { const s = this.seats[i]; if (!s || s.kind !== 'remote') return false; s.kind = 'ai'; this.changed(i); if (s.peer && this.last) this.sendUpdate(s, this.last); return true; }
  /** M14 (Vidi Q134-137): the reverse of seatToAI: a seat the AI took over from a guest goes back to that guest, who must be
   *  connected now. The page switches the engine controller back to 'human'. Returns false (and changes nothing) otherwise. */
  seatBack(i) {
    const s = this.seats[i]; if (!s || s.kind !== 'ai' || !s.token || !s.connected || !s.peer) return false;
    s.kind = 'remote'; this.changed(i); if (this.last) this.sendUpdate(s, this.last); return true;
  }
  /** M14: what a host save keeps of the room, so the host can resume the game online later: seat kinds, names, tokens, player ids. */
  snapshot() { return { code: this.code, started: this.started, seats: this.seats.map(s => ({ i: s.i, kind: s.kind, name: s.name, token: s.token, playerId: s.playerId })) }; }
  /** M14: a resumed online game (from a host save): the seats and tokens come back, nobody is connected until they rejoin. */
  restore(snap) {
    this.started = !!snap.started;
    this.seats = snap.seats.map((x, i) => ({ i, kind: x.kind, name: x.name ?? '', peer: null, token: x.token ?? null, connected: false, lastSeen: 0, playerId: x.playerId ?? null, sentTo: null }));
    this.sendLobby();
  }
  /** Every PING_MS: ping each guest; one that has said nothing for AWAY_MS is shown as away (the host may give its seat to the AI).
   *  It comes back as soon as it answers again. */
  tick() {
    const t = this.now(); this.pingN++;
    for (const s of this.seats) {
      if (!s.peer) continue;
      if (t - s.lastSeen > AWAY_MS && s.connected) { s.connected = false; this.changed(s.i); }
      this.transport.send(s.peer, msg('ping', { n: this.pingN, ...this.beat() }));
    }
  }
  /** v26.1: the heartbeat carried by every ping: the host's last step seq and the turn/step it is on. A guest whose last applied
   *  update is not this one (a dropped, discarded or never-applied update: its view went stale) asks for a full resync. */
  beat() {
    if (!this.started || !this.last) return {};
    const t = this.last.state?.turn ?? {};
    return { seq: this.last.seq, turn: t.number ?? null, step: t.step ?? null };
  }
  close(reason = 'HOST_LEFT') { this.dropClaims(); for (const s of this.seats) if (s.peer) this.transport.send(s.peer, msg('bye', { reason })); this.transport.close(); }
}
