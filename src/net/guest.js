// M11-M14 (online plan steps b-d): the guest's side. Pure (no DOM). A guest runs no engine: it keeps the last views the host sent as a
// small session-like object ({data, seed, steps}) that the page renders, and sends its moves to the host.
// M14 (step d): when the link to the host drops (or the host leaves, and may resume), the guest reconnects by itself: a new
// transport, the same room code, the seat token in the hello, with retries (`retryMs`); the host gives the same seat back with the
// whole current view. A host that stops answering (no ping for HOST_AWAY_MS) is shown as away until it answers again.
import { PROTO, parse, msg, normCode } from './protocol.js';
import { HOST } from './transport.js';

const KEEP = 3;   // views kept (the page only reads the current step and the one before it)
export const HOST_AWAY_MS = 15000;
/** No word at all for this long (the host pings every 5 s): the link is taken as lost, even if the transport never said so (a host
 *  tab that was closed or reloaded without a goodbye), and the guest starts reconnecting. */
export const HOST_LOST_MS = 35000;
/** Waits between reconnect attempts: quick at first, then every 10 s, about 5 minutes in all (then the page offers "Try again"). */
export const RETRY_MS = [500, 1000, 2000, 3000, 5000, 8000, ...Array(28).fill(10000)];
/** Bye reasons that end the session for good (no reconnecting). HOST_LEFT does not: the host may resume the game. */
/** A reconnect attempt whose link opened but that got no welcome in this time (a page that is not our host) fails and retries. */
export const HELLO_MS = 8000;
/** v26.1: a resync asked for and not answered in this time may be asked for again (a lost request must not stop it for good). */
export const RESYNC_RETRY_MS = 4000;
export const FINAL_BYES = ['BUILD_MISMATCH', 'FULL', 'STARTED', 'SEAT_REMOVED', 'REPLACED', 'GAME_OVER', 'BAD_CLAIM', 'SEAT_IN_USE', 'NO_ANSWER'];
/** v30.5: a first join whose link opened but that got no welcome (nor a refusal) in this time ends with bye NO_ANSWER: the page says so
 *  (never a silent "Connecting…"). */
export const JOIN_MS = 12000;
/** v30.5: why a join ended, in words (the page shows it under Join). */
export const JOIN_END_TEXT = {
  NO_ANSWER: 'The host\'s page did not answer (timeout). Check that the host has Imperator open and in front, then tap Join again.',
  NO_ROOM: 'Room not found: check the code. If it is right, the host\'s page is closed or asleep (host offline): ask the host to open it.',
  NETWORK: 'Could not reach the online service: check the internet connection and try again.',
};

export class GuestClient {
  /** hooks: {onWelcome(c), onLobby(c, lobby), onUpdate(c, update), onReject(c, reject), onBye(c, reason), onHostGone(c),
   *          onStatus(c, status, info)}   status: 'connected' | 'reconnecting' {attempt, of, inMs, why} | 'hostAway' | 'lost'
   *  makeTransport: () => transport (or a Promise of one), used for every reconnect attempt; without it a lost link ends the
   *  session (onHostGone), as in M11. */
  constructor({ transport, makeTransport = null, build, name, token = null, tokens = [], claim = null, joinMs = JOIN_MS, data, hooks = {}, retryMs = RETRY_MS, now = () => Date.now(), timers = globalThis }) {
    Object.assign(this, { makeTransport, build, name, token, tokens: (tokens ?? []).filter(t => t && t !== token), claim, joinMs, data, hooks, retryMs, now, timers });
    this.seat = null; this.playerId = null; this.lobby = null; this.session = null; this.legal = []; this.seq = null; this.ended = null; this.ai = false; this.log = []; this.logTo = null; this.resyncAsked = false; this.resyncAt = 0; this.resyncs = []; this.applied = null;
    this.status = 'connecting'; this.hostAway = false; this.lastHeard = now(); this.attempt = 0; this.timer = null; this.reconnects = 0;
    this.bind(transport);
  }
  bind(t) {
    this.transport = t;
    t.onMessage((p, m) => { if (t === this.transport && p === HOST) this.receive(m); });
    t.onPeerClose(p => { if (t === this.transport && p === HOST && !this.ended) this.linkLost('LINK_LOST'); });
  }
  setStatus(st, info = {}) { this.status = st; this.hooks.onStatus?.(this, st, info); }
  async join(code) {
    const r = await this.transport.open({ role: 'guest', code });
    this.code = r.code; this.lastHeard = this.now();
    if (this.ended) { try { this.transport.close(); } catch { /* */ } return r; }   // left while the link was opening
    this.hello();
    this.timers.clearTimeout(this.timer);
    if (this.joinMs) this.timer = this.timers.setTimeout(() => { if (this.status === 'connecting' && !this.ended) { this.ended = 'NO_ANSWER'; try { this.transport.close(); } catch { /* */ } this.hooks.onBye?.(this, 'NO_ANSWER'); } }, this.joinMs);
    return r;
  }
  hello() { this.transport.send(HOST, msg('hello', { proto: PROTO, build: this.build, name: this.name, ...(this.token ? { token: this.token } : {}), ...(this.tokens?.length ? { tokens: this.tokens } : {}), ...(this.claim ? { claim: this.claim } : {}) })); }
  /** The link is gone (or the host said HOST_LEFT): reconnect with the token, or (no factory / no seat yet) end as in M11. */
  linkLost(why) {
    if (this.ended) return;
    if (!this.makeTransport || !this.token) { this.ended = 'HOST_GONE'; this.hooks.onHostGone?.(this); return; }
    if (this.status === 'reconnecting') return;
    try { this.transport.close(); } catch { /* */ }
    this.attempt = 0; this.why = why; this.scheduleRetry();
  }
  scheduleRetry() {
    if (this.ended) return;
    if (this.attempt >= this.retryMs.length) { this.setStatus('lost', { why: this.why }); return; }
    const inMs = this.retryMs[this.attempt];
    this.setStatus('reconnecting', { attempt: this.attempt + 1, of: this.retryMs.length, inMs, why: this.why });
    this.timers.clearTimeout(this.timer); this.timer = this.timers.setTimeout(() => this.tryOnce(), inMs);
  }
  /** "Try now" (or "Try again" after giving up; `code`: the host resumed under a new room code). */
  retryNow(code = null) {
    if (this.ended) return;
    if (code) this.code = normCode(code);
    if (this.status === 'lost') { this.attempt = 0; }
    if (this.status !== 'reconnecting' && this.status !== 'lost') { this.linkLost('RETRY'); return; }
    this.timers.clearTimeout(this.timer); this.tryOnce();
  }
  async tryOnce() {
    if (this.ended) return;
    const n = ++this.attempt;
    let t;
    try {
      t = await this.makeTransport(); this.bind(t);
      await t.open({ role: 'guest', code: this.code });
      if (this.ended || t !== this.transport) { try { t.close(); } catch { /* */ } return; }
      this.lastHeard = this.now(); this.resyncAsked = false; this.logTo = null;   // the host answers the hello with a full update
      this.hello();
      this.timers.clearTimeout(this.timer);
      this.timer = this.timers.setTimeout(() => { if (t === this.transport && this.status === 'reconnecting' && n === this.attempt) this.notOurs(t, 'NO_ANSWER'); }, HELLO_MS);
    } catch (e) {
      try { t?.close(); } catch { /* */ }
      if (this.ended || n !== this.attempt) return;
      this.why = e?.code ?? 'NETWORK'; this.scheduleRetry();
    }
  }
  /** This attempt reached a page that is not our host (no answer, or a room that does not know our token): drop it, retry. */
  notOurs(t, why) { try { t.send(HOST, msg('bye', {})); } catch { /* */ } try { t.close(); } catch { /* */ } this.why = why; this.scheduleRetry(); }
  /** Every few seconds (the page's timer): a host that has said nothing for HOST_AWAY_MS is shown as away. */
  tick() {
    if (this.ended || this.status !== 'connected') return;
    const quiet = this.now() - this.lastHeard;
    if (quiet > HOST_LOST_MS && this.makeTransport && this.token) { this.hostAway = false; this.linkLost('TIMEOUT'); return; }
    const away = quiet > HOST_AWAY_MS;
    if (away !== this.hostAway) { this.hostAway = away; this.hooks.onStatus?.(this, away ? 'hostAway' : 'connected', {}); }
  }
  receive(raw) {
    const m = parse(raw); if (!m) return;
    this.lastHeard = this.now();
    if (this.hostAway) { this.hostAway = false; if (this.status === 'connected') this.hooks.onStatus?.(this, 'connected', { back: true }); }
    switch (m.t) {
      case 'welcome': {
        const again = this.status === 'reconnecting' || this.status === 'lost';
        if (again && m.token !== this.token) { this.notOurs(this.transport, 'NOT_OUR_ROOM'); break; }   // another game under this code
        this.seat = m.seat; this.token = m.token; this.tokens = []; this.claim = null; this.name = m.name ?? this.name; this.code = m.code ?? this.code;
        this.timers.clearTimeout(this.timer); this.attempt = 0;
        if (again) this.reconnects++;
        this.setStatus('connected', { rejoined: again });
        this.hooks.onWelcome?.(this, m); break;
      }
      case 'lobby': this.lobby = m; this.hooks.onLobby?.(this, m); break;
      case 'ping': {
        this.transport.send(HOST, msg('pong', { n: m.n }));
        // v26.1 heartbeat: the host's last update is not the one this guest has (dropped, discarded on a gap, never applied): resync.
        // The link keeps order, so every update the host sent before this ping has already arrived.
        if (Number.isInteger(m.seq) && this.session) {
          const v = this.session.steps.at(-1)?.state?.turn ?? {};
          const off = m.seq !== this.seq ? 'SEQ' : (m.turn != null && m.turn !== v.number) || (m.step != null && m.step !== v.step) ? 'STEP' : null;
          if (off) this.resync('BEAT_' + off);
        }
        this.hooks.onBeat?.(this, m);
        break;
      }
      case 'update': {
        // M12: the view has no log; the log is kept here from the events (the whole log when `full`). A gap: ask for everything.
        if (!m.full && m.from !== this.logTo) { this.resync('GAP'); return; }
        if (m.resync || (m.full && this.resyncAsked)) m.resynced = true;
        this.resyncAsked = false;
        this.log = m.full ? [...(m.events ?? [])] : [...(this.log ?? []), ...(m.events ?? [])];
        this.logTo = m.to;
        this.seq = m.seq; this.playerId = m.you?.playerId ?? this.playerId; this.legal = m.legal ?? []; this.ai = !!m.you?.ai;
        if (m.seats) this.lobby = { ...(this.lobby ?? {}), seats: m.seats, started: true };
        m.state = { ...m.view, log: this.log };   // what the page renders
        m.anim = m.full ? [] : (m.events ?? []);   // what it animates (never a whole resent log)
        const step = { state: m.state, events: m.anim, action: null, error: null, by: m.by };
        const steps = this.session ? [...this.session.steps, step].slice(-KEEP) : [step];
        this.session = { data: this.data, seed: 'online', steps, online: true };
        this.hooks.onUpdate?.(this, m); break;
      }
      case 'reject': if (m.code === 'STALE') this.resync('STALE'); this.hooks.onReject?.(this, m); break;
      case 'bye': {
        const r = m.reason ?? 'BYE';
        if ((this.status === 'reconnecting' || this.status === 'lost') && (r === 'FULL' || r === 'STARTED')) { this.notOurs(this.transport, 'NOT_OUR_ROOM'); break; }
        if (r === 'HOST_LEFT' && this.makeTransport && this.token) { this.hooks.onBye?.(this, r); this.linkLost('HOST_LEFT'); break; }
        this.ended = r; this.timers.clearTimeout(this.timer); this.hooks.onBye?.(this, this.ended); break;
      }
      default: break;
    }
  }
  /** v26.1: asks the host for the whole current view (a seq gap, a heartbeat that does not match, a page that could not apply an
   *  update, a STALE answer). Once per RESYNC_RETRY_MS at most, and again if the first request got no answer. */
  resync(why = 'PAGE') {
    if (this.ended || this.status !== 'connected') return false;
    if (this.resyncAsked && this.now() - this.resyncAt < RESYNC_RETRY_MS) return false;
    this.resyncAsked = true; this.resyncAt = this.now(); this.resyncs.push(why);
    this.transport.send(HOST, msg('resync', { why }));
    this.hooks.onResync?.(this, why);
    return true;
  }
  /** Sends a move for this guest's own seat (the host checks it, rolls any dice and answers with an update or a reject). */
  act(action) { const { dice, ...a } = action ?? {}; this.transport.send(HOST, msg('act', { seq: this.seq, action: a })); }   // eslint-disable-line no-unused-vars
  leave() { this.timers.clearTimeout(this.timer); if (!this.ended) { this.ended = 'LEFT'; this.transport.send(HOST, msg('bye', {})); } this.transport.close(); }
}
