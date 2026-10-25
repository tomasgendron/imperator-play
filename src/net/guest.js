// M11 (online plan step b): the guest's side. Pure (no DOM). A guest runs no engine: it keeps the last views the host sent as a
// small session-like object ({data, seed, steps}) that the page renders, and sends its moves to the host.
import { PROTO, parse, msg } from './protocol.js';
import { HOST } from './transport.js';

const KEEP = 3;   // views kept (the page only reads the current step and the one before it)

export class GuestClient {
  /** hooks: {onWelcome(c), onLobby(c, lobby), onUpdate(c, update), onReject(c, reject), onBye(c, reason), onHostGone(c)} */
  constructor({ transport, build, name, token = null, data, hooks = {} }) {
    Object.assign(this, { transport, build, name, token, data, hooks });
    this.seat = null; this.playerId = null; this.lobby = null; this.session = null; this.legal = []; this.seq = null; this.ended = null; this.ai = false;
    transport.onMessage((p, m) => { if (p === HOST) this.receive(m); });
    transport.onPeerClose(p => { if (p === HOST && !this.ended) { this.ended = 'HOST_GONE'; this.hooks.onHostGone?.(this); } });
  }
  async join(code) {
    const r = await this.transport.open({ role: 'guest', code });
    this.code = r.code;
    this.transport.send(HOST, msg('hello', { proto: PROTO, build: this.build, name: this.name, ...(this.token ? { token: this.token } : {}) }));
    return r;
  }
  receive(raw) {
    const m = parse(raw); if (!m) return;
    switch (m.t) {
      case 'welcome': this.seat = m.seat; this.token = m.token; this.name = m.name ?? this.name; this.hooks.onWelcome?.(this, m); break;
      case 'lobby': this.lobby = m; this.hooks.onLobby?.(this, m); break;
      case 'ping': this.transport.send(HOST, msg('pong', { n: m.n })); break;
      case 'update': {
        this.seq = m.seq; this.playerId = m.you?.playerId ?? this.playerId; this.legal = m.legal ?? []; this.ai = !!m.you?.ai;
        if (m.seats) this.lobby = { ...(this.lobby ?? {}), seats: m.seats, started: true };
        const step = { state: m.view, events: m.events ?? [], action: null, error: null, by: m.by };
        const steps = this.session ? [...this.session.steps, step].slice(-KEEP) : [step];
        this.session = { data: this.data, seed: 'online', steps, online: true };
        this.hooks.onUpdate?.(this, m); break;
      }
      case 'reject': this.hooks.onReject?.(this, m); break;
      case 'bye': this.ended = m.reason ?? 'BYE'; this.hooks.onBye?.(this, this.ended); break;
      default: break;
    }
  }
  /** Sends a move for this guest's own seat (the host checks it, rolls any dice and answers with an update or a reject). */
  act(action) { const { dice, ...a } = action ?? {}; this.transport.send(HOST, msg('act', { seq: this.seq, action: a })); }   // eslint-disable-line no-unused-vars
  leave() { if (!this.ended) { this.ended = 'LEFT'; this.transport.send(HOST, msg('bye', {})); } this.transport.close(); }
}
