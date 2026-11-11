// M11 (online plan step b): the transport behind the online game, kept behind one small interface so the PeerJS (WebRTC) transport
// can later be swapped for a server one (e.g. a Cloudflare Durable Object WebSocket) without touching the protocol or the engine.
//
// Interface (one transport object per page):
//   open({role: 'host'|'guest', code}) -> Promise<{code}>
//        host: claim the room `code`; guest: connect to the host of room `code`.
//        Rejects with an Error whose `.code` is 'ROOM_TAKEN' (host: the code is in use), 'NO_ROOM' (guest: no host with that code),
//        or 'NETWORK' (the signalling server cannot be reached), or 'HOST_UNREACHABLE' (signalling worked, the host's
//        WebRTC link did not).
//   send(peer, obj)          host: peer = a guest's id; guest: peer = HOST. obj is plain JSON.
//   onMessage(fn(peer, obj)) every message from a peer, in order.
//   onPeer(fn(peer))         host: a guest connected.            onPeerClose(fn(peer)) a peer went away (guest: HOST went away).
//   close()                  leave the room / drop every connection.
// Implementations: createMemoryNet().transport() (in-memory, tests), createBroadcastTransport() (two tabs of one browser, tests and
// a no-network fallback), createPeerTransport(Peer) (PeerJS on the free PeerJS Cloud signalling server, STUN plus PeerJS TURN).
import { peerIdOf, normCode } from './protocol.js';

export const HOST = 'host';
const err = (code, message) => Object.assign(new Error(message), { code });
function hub() {
  const h = { msg: [], peer: [], close: [], progress: [] };
  return {
    onMessage: fn => h.msg.push(fn), onPeer: fn => h.peer.push(fn), onPeerClose: fn => h.close.push(fn),
    emitMsg: (p, m) => h.msg.forEach(f => f(p, m)), emitPeer: p => h.peer.forEach(f => f(p)), emitClose: p => h.close.forEach(f => f(p)),
    // v31.3: a long message arrives in pieces (a full sync of a Large Map 1 game: ~50-60): onProgress(fn(peer, got, of)) after each piece
    onProgress: fn => h.progress.push(fn), emitProgress: (p, got, of) => h.progress.forEach(f => f(p, got, of)),
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

// STUN plus the TURN relays bundled with PeerJS 1.5.5 (src/vendor/peerjs.min.js defaultConfig). That default is
// stun.l.google.com plus turn:eu-0.turn.peerjs.com:3478 and turn:us-0.turn.peerjs.com:3478 (user peerjs, credential peerjsp).
// It has no TCP or port-443 TURN URLs; 443 there is only the signalling port. Cloudflare's STUN server stays as well.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];
/** Shown when 0.peerjs.com itself cannot be reached (before the peer id opens). */
export const SIGNALLING_TEXT = 'Could not reach the online service: check the internet connection and try again.';
/** Shown when signalling succeeded and the WebRTC link to the host did not. */
export const HOST_UNREACHABLE_TEXT = 'Couldn\'t connect to the host\'s game. Make sure the host\'s page is open and awake, then try again. On different networks this can take a moment.';
const SIGNALLING_TYPES = new Set(['server-error', 'socket-error', 'socket-closed']);
/** Map a PeerJS error, or the open() timer, to ROOM_TAKEN / NO_ROOM / NETWORK / HOST_UNREACHABLE.
 *  `signalled` is true once the peer id has opened. A webrtc error is the host link, not the signalling server. */
export function classifyPeerFailure(e, { signalled = false, timedOut = false } = {}) {
  if (e?.type === 'unavailable-id') return err('ROOM_TAKEN', 'That room code is already in use.');
  if (e?.type === 'peer-unavailable') return err('NO_ROOM', 'No game with that code was found (is the host\'s page still open?).');
  if (!timedOut && (SIGNALLING_TYPES.has(e?.type) || (e?.type === 'network' && !signalled))) return err('NETWORK', SIGNALLING_TEXT);
  if (timedOut && !signalled) return err('NETWORK', SIGNALLING_TEXT);
  if (e?.type === 'webrtc' || (timedOut && signalled) || signalled) return err('HOST_UNREACHABLE', HOST_UNREACHABLE_TEXT);
  return err('NETWORK', SIGNALLING_TEXT);
}
// v30.5.1: PeerJS's JSON channel DROPS (a "Message too big" error, nothing sent) any message of util.chunkedMTU = 16300 bytes or more,
// counted as the UTF-8 of JSON.stringify(frame). A frame's text is a JSON string inside the frame, so its quotes are escaped again
// and non-ASCII letters take 2-3 bytes: frames are cut by their real size (the old 16000-character chunks were ~19000 bytes, so
// every long message, such as the whole view a rejoining or new player gets in a game that has run a while, was lost).
export const MAX_FRAME_BYTES = 15000;
const ENC = new TextEncoder();
const frameBytes = f => ENC.encode(JSON.stringify(f)).length;
/** The data-channel frames for one message text: {k:'m', s} when it fits, else {k:'c', id, i, n, s} parts, each under MAX_FRAME_BYTES. */
export function peerFrames(s, id, max = MAX_FRAME_BYTES) {
  if (frameBytes({ k: 'm', s }) <= max) return [{ k: 'm', s }];
  const parts = []; let i = 0; let size = 12000;
  while (i < s.length) {
    let n = Math.min(size, s.length - i);
    while (n > 1 && frameBytes({ k: 'c', id, i: 99999, n: 99999, s: s.slice(i, i + n) }) > max) n = Math.max(1, Math.floor(n * 0.75));
    parts.push(s.slice(i, i + n)); i += n; size = Math.max(n, 1000);
  }
  return parts.map((x, j) => ({ k: 'c', id, i: j, n: parts.length, s: x }));
}

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
      else if (d.k === 'c') { const b = parts.get(who + d.id) ?? []; b[d.i] = d.s; parts.set(who + d.id, b); const got = b.filter(x => x !== undefined).length;
        if (got === d.n) { parts.delete(who + d.id); text = b.join(''); } else ev.emitProgress(who, got, d.n); }
      if (text !== null) { let m; try { m = JSON.parse(text); } catch { return; } ev.emitMsg(who, m); }
    });
    conn.on('close', () => { if (conns.get(who) === conn) { conns.delete(who); ev.emitClose(who); } });
    conn.on('error', e => { if (e?.type !== 'peer-unavailable') console.warn('data channel', e?.type ?? e?.message ?? e); });   // a close follows a real failure
  };
  return {
    get id() { return peer?.id ?? null; },
    open({ role, code }) {
      return new Promise((resolve, reject) => {
        let done = false; let signalled = false;
        const finish = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
        const timer = setTimeout(() => { finish(reject, classifyPeerFailure(null, { signalled, timedOut: true })); try { peer?.destroy(); } catch { /* */ } }, timeoutMs);
        const opts = { debug, config: { iceServers } };
        const fail = e => { if (!done) { finish(reject, classifyPeerFailure(e, { signalled })); try { peer.destroy(); } catch { /* */ } } else if (debug > 1) console.warn('peer', e); };
        if (role === 'host') {
          peer = new Peer(peerIdOf(code), opts);
          peer.on('open', () => { signalled = true; finish(resolve, { code: normCode(code) }); });
          peer.on('connection', conn => { conn._who = conn.peer; conn.on('open', () => { const old = conns.get(conn.peer); conns.set(conn.peer, conn); if (old && old !== conn) try { old.close(); } catch { /* */ } wire(conn); ev.emitPeer(conn.peer); }); });
          peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* */ } });   // lost the signalling server: existing games keep running
        } else {
          peer = new Peer(opts);
          peer.on('open', () => {
            signalled = true;
            const conn = peer.connect(peerIdOf(code), { reliable: true, serialization: 'json' }); conn._who = HOST;
            conn.on('open', () => { conns.set(HOST, conn); wire(conn); finish(resolve, { code: normCode(code) }); });
          });
        }
        // A single webrtc error is often one bad ICE candidate (PeerJS emits it and keeps negotiating). Do not abort; the timer decides.
        peer.on('error', e => { if (e?.type === 'webrtc') { if (debug > 1) console.warn('webrtc', e); return; } fail(e); });
      });
    },
    send(to, obj) {
      const c = conns.get(to); if (!c || !c.open) return;
      for (const f of peerFrames(JSON.stringify(obj), ++seq)) c.send(f);
    },
    onMessage: ev.onMessage, onPeer: ev.onPeer, onPeerClose: ev.onPeerClose, onProgress: ev.onProgress,
    close() { for (const c of conns.values()) try { c.close(); } catch { /* */ } conns.clear(); try { peer?.destroy(); } catch { /* */ } peer = null; },
  };
}
