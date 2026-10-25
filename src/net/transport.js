// M11 (online plan step b): the transport behind the online game, kept behind one small interface so the PeerJS (WebRTC) transport
// can later be swapped for a server one (e.g. a Cloudflare Durable Object WebSocket) without touching the protocol or the engine.
//
// Interface (one transport object per page):
//   open({role: 'host'|'guest', code}) -> Promise<{code}>
//        host: claim the room `code`; guest: connect to the host of room `code`.
//        Rejects with an Error whose `.code` is 'ROOM_TAKEN' (host: the code is in use), 'NO_ROOM' (guest: no host with that code),
//        or 'NETWORK' (the signalling server cannot be reached / the connection failed).
//   send(peer, obj)          host: peer = a guest's id; guest: peer = HOST. obj is plain JSON.
//   onMessage(fn(peer, obj)) every message from a peer, in order.
//   onPeer(fn(peer))         host: a guest connected.            onPeerClose(fn(peer)) a peer went away (guest: HOST went away).
//   close()                  leave the room / drop every connection.
// Implementations: createMemoryNet().transport() (in-memory, tests), createBroadcastTransport() (two tabs of one browser, tests and
// a no-network fallback), createPeerTransport(Peer) (PeerJS on the free PeerJS Cloud signalling server, STUN only, no TURN).
import { peerIdOf, normCode } from './protocol.js';

export const HOST = 'host';
const err = (code, message) => Object.assign(new Error(message), { code });
function hub() {
  const h = { msg: [], peer: [], close: [] };
  return {
    onMessage: fn => h.msg.push(fn), onPeer: fn => h.peer.push(fn), onPeerClose: fn => h.close.push(fn),
    emitMsg: (p, m) => h.msg.forEach(f => f(p, m)), emitPeer: p => h.peer.forEach(f => f(p)), emitClose: p => h.close.forEach(f => f(p)),
  };
}

/** In-memory network: every transport() of one net can reach the others. Messages are JSON-copied and delivered asynchronously,
 *  in order, like a real data channel. `net.drop(peer)` simulates a lost connection. */
export function createMemoryNet() {
  const rooms = new Map();   // code -> host endpoint
  let n = 0;
  const later = f => setTimeout(f, 0);
  const net = {
    rooms,
    transport() {
      const ev = hub(); let me = null; const links = new Map();   // peer -> deliver(fn)
      const t = {
        id: null,
        async open({ role, code }) {
          code = normCode(code);
          if (role === 'host') {
            if (rooms.has(code)) throw err('ROOM_TAKEN', `Room ${code} is already in use.`);
            me = { role, code, accept(guestId, deliverToGuest) { links.set(guestId, deliverToGuest); later(() => ev.emitPeer(guestId)); return (m) => later(() => ev.emitMsg(guestId, m)); },
              drop(guestId) { if (links.delete(guestId)) later(() => ev.emitClose(guestId)); } };
            rooms.set(code, me); t.id = HOST; return { code };
          }
          const host = rooms.get(code); if (!host) throw err('NO_ROOM', `No game with the code ${code} was found.`);
          t.id = 'g' + (++n); me = { role, code, host };
          const toHost = host.accept(t.id, m => later(() => ev.emitMsg(HOST, m)));
          links.set(HOST, toHost);
          me.hostGone = () => { links.delete(HOST); later(() => ev.emitClose(HOST)); };
          (host.guests ??= new Map()).set(t.id, t);
          return { code };
        },
        send(peer, obj) { const d = links.get(peer); if (d) d(JSON.parse(JSON.stringify(obj))); },
        onMessage: ev.onMessage, onPeer: ev.onPeer, onPeerClose: ev.onPeerClose,
        close() {
          if (!me) return;
          if (me.role === 'host') { rooms.delete(me.code); for (const g of (me.guests ?? new Map()).values()) g._hostGone(); }
          else me.host.drop(t.id);
          links.clear(); me = null;
        },
        _hostGone() { if (me?.hostGone) me.hostGone(); },
        _drop() { if (me?.role === 'guest') { me.host.drop(t.id); me.hostGone(); } },
      };
      return t;
    },
  };
  return net;
}

/** Two tabs of the same browser (same origin) via BroadcastChannel: no server at all. Used by the loopback browser test (?net=local). */
export function createBroadcastTransport(BC = globalThis.BroadcastChannel) {
  const ev = hub(); let ch = null; let role = null; const peers = new Set();
  const id = 'b' + Math.random().toString(36).slice(2, 10);
  const post = (to, kind, data) => ch?.postMessage({ from: role === 'host' ? HOST : id, to, kind, data });
  return {
    id,
    async open({ role: r, code }) {
      role = r; code = normCode(code); ch = new BC('imperator-net-' + code);
      if (r === 'host') {
        const taken = await new Promise(res => { const t = setTimeout(() => res(false), 300); ch.onmessage = e => { if (e.data.kind === 'probe-ok') { clearTimeout(t); res(true); } }; post(HOST, 'probe'); });
        if (taken) { ch.close(); ch = null; throw err('ROOM_TAKEN', `Room ${code} is already in use.`); }
        ch.onmessage = e => { const m = e.data; if (m.to !== HOST && m.kind !== 'probe') return;
          if (m.kind === 'probe') post(m.from, 'probe-ok');
          else if (m.kind === 'conn') { peers.add(m.from); post(m.from, 'conn-ok'); ev.emitPeer(m.from); }
          else if (m.kind === 'msg' && peers.has(m.from)) ev.emitMsg(m.from, m.data);
          else if (m.kind === 'close' && peers.delete(m.from)) ev.emitClose(m.from); };
        return { code };
      }
      await new Promise((res, rej) => {
        const t = setTimeout(() => { ch.close(); ch = null; rej(err('NO_ROOM', `No game with the code ${code} was found.`)); }, 2000);
        ch.onmessage = e => { const m = e.data; if (m.to !== id) return;
          if (m.kind === 'conn-ok') { clearTimeout(t); res(); }
          else if (m.kind === 'msg') ev.emitMsg(HOST, m.data);
          else if (m.kind === 'close') ev.emitClose(HOST); };
        post(HOST, 'conn');
      });
      return { code };
    },
    send(peer, obj) { post(peer, 'msg', JSON.parse(JSON.stringify(obj))); },
    onMessage: ev.onMessage, onPeer: ev.onPeer, onPeerClose: ev.onPeerClose,
    close() { if (!ch) return; if (role === 'host') for (const p of peers) post(p, 'close'); else post(HOST, 'close'); ch.close(); ch = null; },
  };
}

// STUN only (no TURN account, decision 2026-10-25): Google's and Cloudflare's free public STUN servers.
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const CHUNK = 16000;   // characters per data-channel message (safe under every browser's SCTP message limit, even as UTF-8)

/** PeerJS (WebRTC data channels) with the free PeerJS Cloud signalling server (0.peerjs.com). The room code is the host's peer id
 *  (`imperator-<CODE>`). Messages are JSON strings, split into chunks when long. `Peer` is the PeerJS constructor (src/vendor). */
export function createPeerTransport(Peer, { iceServers = ICE_SERVERS, timeoutMs = 20000, debug = 1 } = {}) {
  const ev = hub(); let peer = null; const conns = new Map(); const parts = new Map(); let seq = 0;
  const wire = conn => {
    const who = conn._who;
    conn.on('data', d => {
      if (!d || typeof d !== 'object') return;
      let text = null;
      if (d.k === 'm') text = d.s;
      else if (d.k === 'c') { const b = parts.get(who + d.id) ?? []; b[d.i] = d.s; parts.set(who + d.id, b); if (b.filter(x => x !== undefined).length === d.n) { parts.delete(who + d.id); text = b.join(''); } }
      if (text !== null) { let m; try { m = JSON.parse(text); } catch { return; } ev.emitMsg(who, m); }
    });
    conn.on('close', () => { if (conns.get(who) === conn) { conns.delete(who); ev.emitClose(who); } });
    conn.on('error', () => { /* close follows */ });
  };
  const mapErr = e => (e?.type === 'unavailable-id' ? err('ROOM_TAKEN', 'That room code is already in use.')
    : e?.type === 'peer-unavailable' ? err('NO_ROOM', 'No game with that code was found (is the host\'s page still open?).')
    : err('NETWORK', `Could not reach the online service (${e?.type ?? e?.message ?? 'unknown error'}). Check the internet connection and try again.`));
  return {
    get id() { return peer?.id ?? null; },
    open({ role, code }) {
      return new Promise((resolve, reject) => {
        let done = false; const finish = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
        const timer = setTimeout(() => { finish(reject, err('NETWORK', 'The connection timed out. Check the code and the internet connection, then try again.')); try { peer?.destroy(); } catch { /* */ } }, timeoutMs);
        const opts = { debug, config: { iceServers } };
        if (role === 'host') {
          peer = new Peer(peerIdOf(code), opts);
          peer.on('open', () => finish(resolve, { code: normCode(code) }));
          peer.on('connection', conn => { conn._who = conn.peer; conn.on('open', () => { const old = conns.get(conn.peer); conns.set(conn.peer, conn); if (old && old !== conn) try { old.close(); } catch { /* */ } wire(conn); ev.emitPeer(conn.peer); }); });
          peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* */ } });   // lost the signalling server: existing games keep running
        } else {
          peer = new Peer(opts);
          peer.on('open', () => {
            const conn = peer.connect(peerIdOf(code), { reliable: true, serialization: 'json' }); conn._who = HOST;
            conn.on('open', () => { conns.set(HOST, conn); wire(conn); finish(resolve, { code: normCode(code) }); });
          });
        }
        peer.on('error', e => { if (!done) { finish(reject, mapErr(e)); try { peer.destroy(); } catch { /* */ } } else if (debug > 1) console.warn('peer', e); });
      });
    },
    send(to, obj) {
      const c = conns.get(to); if (!c || !c.open) return;
      const s = JSON.stringify(obj);
      if (s.length <= CHUNK) { c.send({ k: 'm', s }); return; }
      const id = ++seq; const n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) c.send({ k: 'c', id, i, n, s: s.slice(i * CHUNK, (i + 1) * CHUNK) });
    },
    onMessage: ev.onMessage, onPeer: ev.onPeer, onPeerClose: ev.onPeerClose,
    close() { for (const c of conns.values()) try { c.close(); } catch { /* */ } conns.clear(); try { peer?.destroy(); } catch { /* */ } peer = null; },
  };
}
