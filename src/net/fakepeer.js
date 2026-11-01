// v30.5.1 test transport (?net=fakepeer): the REAL PeerJS transport code (createPeerTransport: framing, reassembly, errors) over a
// PeerJS stand-in that runs on a BroadcastChannel between tabs and enforces PeerJS 1.5's JSON-channel rule: a message of
// util.chunkedMTU (16300) UTF-8 bytes or more is refused ("Message too big") and nothing is sent. The browser tests use it to play
// the internet path's size limit end to end without WebRTC (the box has no UDP); ?net=local has no size limit and hid the bug.
export const PEERJS_MTU = 16300;
const enc = new TextEncoder();
const emitter = () => { const h = {}; return { on(e, f) { (h[e] ??= []).push(f); return this; }, emit(e, ...a) { (h[e] ?? []).forEach(f => { try { f(...a); } catch (x) { console.error(x); } }); } }; };
let bc = null; const mine = new Map(); const conns = new Map();   // peers of this tab by id; connections of this tab by cid
const stats = (globalThis.__fakepeer ??= { sent: 0, dropped: 0, maxBytes: 0 });
function chan() {
  if (bc) return bc;
  bc = new BroadcastChannel('imperator-fakepeer');
  bc.onmessage = e => {
    const m = e.data;
    if (m.t === 'who' && mine.has(m.id)) bc.postMessage({ t: 'here', id: m.id, q: m.q });
    else if (m.t === 'conn' && mine.has(m.to)) { const c = makeConn(m.cid, m.from, m.to); conns.set(m.cid, c); bc.postMessage({ t: 'accept', cid: m.cid }); mine.get(m.to).emit('connection', c); setTimeout(() => { c.open = true; c.emit('open'); }, 0); }
    else if (m.t === 'accept' && conns.has(m.cid)) { const c = conns.get(m.cid); clearTimeout(c._t); c.open = true; c.emit('open'); }
    else if (m.t === 'data' && conns.has(m.cid) && m.to === conns.get(m.cid)._me) { const c = conns.get(m.cid); if (c.open) c.emit('data', m.d); }
    else if (m.t === 'close' && conns.has(m.cid) && m.to === conns.get(m.cid)._me) { const c = conns.get(m.cid); conns.delete(m.cid); if (c.open) { c.open = false; c.emit('close'); } }
    else if (m.t === 'here') hereWait.get(m.q)?.();
  };
  addEventListener('pagehide', () => { for (const [cid, c] of conns) if (c.open) bc.postMessage({ t: 'close', cid, to: c.peer }); });
  return bc;
}
const hereWait = new Map();
function makeConn(cid, peerId, me) {
  const c = { ...emitter(), cid, peer: peerId, open: false, _me: me };
  c.send = d => {
    const bytes = enc.encode(JSON.stringify(d)).length; stats.maxBytes = Math.max(stats.maxBytes, bytes);
    if (bytes >= PEERJS_MTU) { stats.dropped++; c.emit('error', { type: 'message-too-big' }); return; }   // as PeerJS: nothing is sent
    stats.sent++; chan().postMessage({ t: 'data', cid, to: peerId, d });
  };
  c.close = () => { if (!c.open) return; c.open = false; chan().postMessage({ t: 'close', cid, to: peerId }); conns.delete(cid); c.emit('close'); };
  return c;
}
export class FakePeer {
  constructor(id, opts) {
    if (typeof id !== 'string') { opts = id; id = 'guest-' + Math.random().toString(36).slice(2, 10); }
    Object.assign(this, emitter()); this.id = id; const ch = chan();
    const q = Math.random().toString(36).slice(2); let taken = false; hereWait.set(q, () => { taken = true; });
    ch.postMessage({ t: 'who', id, q });
    setTimeout(() => { hereWait.delete(q); if (taken) { this.emit('error', { type: 'unavailable-id' }); return; } mine.set(id, this); this.emit('open', id); }, 150);
  }
  connect(id) {
    const cid = this.id + ':' + Math.random().toString(36).slice(2); const c = makeConn(cid, id, this.id); conns.set(cid, c);
    chan().postMessage({ t: 'conn', cid, from: this.id, to: id });
    c._t = setTimeout(() => { conns.delete(cid); this.emit('error', { type: 'peer-unavailable' }); }, 1500);
    return c;
  }
  destroy() { if (mine.get(this.id) === this) mine.delete(this.id); for (const [cid, c] of conns) if (c._me === this.id && c.open) c.close(); }
  reconnect() {}
}
