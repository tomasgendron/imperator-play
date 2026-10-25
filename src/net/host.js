// M11 (online plan step b): the host's room. Pure (no DOM): the page and the Node tests drive the same object.
// The host's browser runs the engine; this object only keeps the seat table, checks who may send what, and sends each guest its
// view of every step together with that guest's legal moves. It never applies an action itself: `onAct` (the page's apply, or a
// test's consoleModel.play) does, so the engine's own checks (NOT_YOUR_TURN, NOT_YOUR_PROMPT, illegal moves) decide, and any
// `dice` a guest sends is stripped before that (only the host's state.rng rolls).
import { PROTO, parse, msg, guestView, redactFor, cleanAction, token as newToken } from './protocol.js';
import { humanLegal } from '../ui/game/model.js';

export const PING_MS = 5000, AWAY_MS = 15000;
export const BUILD_MISMATCH = (host, guest) => `This game was started with Imperator ${host}, but your page is ${guest}. Reload the page (Ctrl+F5) so both of you play the same version, then join again.`;
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
  lobby() { return { code: this.code, started: this.started, seats: this.seats.map(s => ({ i: s.i, kind: s.kind, name: s.name, taken: !!s.token, connected: s.kind !== 'remote' || s.connected })) }; }
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
    if (m.t === 'bye') { if (seat) { seat.connected = false; seat.peer = null; this.changed(seat.i); } return; }
    if (m.t !== 'act') return;
    if (!seat) return this.reject(peer, 'NOT_SEATED', 'You have no seat in this game.', { seq: m.seq });
    if (!this.started) return this.reject(peer, 'NOT_STARTED', 'The game has not started yet.', { seq: m.seq });
    if (seat.kind !== 'remote') return this.reject(peer, 'SEAT_IS_AI', 'The host gave your seat to the AI.', { seq: m.seq });
    const action = cleanAction(m.action);   // drops any `dice`: the host's own dice roll
    if (!action) return this.reject(peer, 'BAD_ACTION', 'That move could not be read.', { seq: m.seq });
    if (action.playerId !== seat.playerId) return this.reject(peer, 'WRONG_SEAT', 'You can only move for your own seat.', { seq: m.seq });
    if (this.last && Number.isInteger(m.seq) && m.seq !== this.last.seq) return this.reject(peer, 'STALE', 'The game moved on before your move arrived; choose again.', { seq: m.seq });
    this.hooks.onAct?.(seat.i, action, error => { if (error) this.reject(peer, error.code ?? 'ILLEGAL', error.message ?? String(error), { seq: m.seq }); });
  }
  hello(peer, m) {
    if (m.proto !== PROTO || m.build !== this.build) {
      this.reject(peer, 'BUILD_MISMATCH', m.proto !== PROTO ? BUILD_MISMATCH(this.build, `an incompatible version (protocol ${m.proto})`) : BUILD_MISMATCH(this.build, m.build ?? 'an unknown version'));
      this.transport.send(peer, msg('bye', { reason: 'BUILD_MISMATCH' })); return;
    }
    let seat = m.token ? this.seats.find(s => s.token && s.token === m.token) : null;
    if (!seat) {
      if (this.started) { this.reject(peer, 'STARTED', 'This game has already started; only its players can rejoin it.'); this.transport.send(peer, msg('bye', { reason: 'STARTED' })); return; }
      seat = this.seats.find(s => s.kind === 'remote' && !s.token);
      if (!seat) { this.reject(peer, 'FULL', 'This game has no free seat.'); this.transport.send(peer, msg('bye', { reason: 'FULL' })); return; }
      seat.token = newToken(this.rnd); seat.name = cleanName(m.name, seat.i);
    }
    if (seat.peer && seat.peer !== peer) this.transport.send(seat.peer, msg('bye', { reason: 'REPLACED' }));   // the same player from a new tab
    Object.assign(seat, { peer, connected: true, lastSeen: this.now() });
    this.transport.send(peer, msg('welcome', { proto: PROTO, build: this.build, code: this.code, seat: seat.i, token: seat.token, name: seat.name }));
    this.changed(seat.i);
    if (this.started && this.last) this.sendUpdate(seat, this.last);   // a rejoin mid-game gets the whole current view at once
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
  update(step) { this.last = step; for (const s of this.seats) if (s.peer) this.sendUpdate(s, step); }
  sendUpdate(s, step) {
    const pid = s.playerId;
    this.transport.send(s.peer, msg('update', {
      seq: step.seq, by: step.by ?? null, view: guestView(step.state, pid), events: redactFor(step.events ?? [], pid),
      legal: s.kind === 'remote' ? humanLegal(step.state, this.data, pid) : [], you: { seat: s.i, playerId: pid, ai: s.kind === 'ai' }, seats: this.lobby().seats,
    }));
  }
  /** The host's "give this seat to the AI" button (a dropped or away player). The page switches the engine controller to 'ai'. */
  seatToAI(i) { const s = this.seats[i]; if (!s || s.kind !== 'remote') return false; s.kind = 'ai'; this.changed(i); if (s.peer && this.last) this.sendUpdate(s, this.last); return true; }
  /** Every PING_MS: ping each guest; one that has said nothing for AWAY_MS is shown as away (the host may give its seat to the AI).
   *  It comes back as soon as it answers again. */
  tick() {
    const t = this.now(); this.pingN++;
    for (const s of this.seats) {
      if (!s.peer) continue;
      if (t - s.lastSeen > AWAY_MS && s.connected) { s.connected = false; this.changed(s.i); }
      this.transport.send(s.peer, msg('ping', { n: this.pingN }));
    }
  }
  close(reason = 'HOST_LEFT') { for (const s of this.seats) if (s.peer) this.transport.send(s.peer, msg('bye', { reason })); this.transport.close(); }
}
