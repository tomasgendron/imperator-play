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

// Fallback ICE list, used only if the Cloudflare relay service cannot be reached.
// STUN plus the TURN relays bundled with PeerJS 1.5.5 (src/vendor/peerjs.min.js defaultConfig). That default is
// stun.l.google.com plus turn:eu-0.turn.peerjs.com:3478 and turn:us-0.turn.peerjs.com:3478 (user peerjs, credential peerjsp).
// It has no TCP or port-443 TURN URLs; 443 there is only the signalling port. Cloudflare's STUN server stays as well.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];
/** Short-lived Cloudflare TURN credentials. The secret stays on this service; the public game only gets temporary usernames. */
export const ICE_CREDENTIALS_URL = 'https://imperator-ice.pages.dev/ice';
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

const logNet = (what, detail) => { try { console.warn('[net]', what, detail ?? ''); } catch { /* */ } };

/** Fetch short-lived Cloudflare TURN credentials. Falls back to ICE_SERVERS if the relay service is unreachable. */
export async function loadIceServers({ url = ICE_CREDENTIALS_URL, timeoutMs = 5000, fallback = ICE_SERVERS, fetchFn } = {}) {
  const fetchImpl = fetchFn ?? globalThis.fetch;
  if (!url || typeof fetchImpl !== 'function') return fallback;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetchImpl(url, { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('ice ' + r.status);
    const data = await r.json();
    const servers = data.iceServers;
    if (!Array.isArray(servers) || !servers.length) throw new Error('empty ice');
    const hasTurn = servers.some(s => [].concat(s.urls).some(u => /^turns?:/i.test(String(u))));
    if (!hasTurn) throw new Error('no turn');
    logNet('ice-loaded', { n: servers.length });
    return servers;
  } catch (e) {
    logNet('ice-fetch-failed', e?.message ?? e);
    return fallback;
  }
}
/** PeerJS puts the RTCPeerConnection on the DataConnection. Log its ICE state: a failed relay used to look like "the host is unreachable". */
function watchIce(conn, onDead) {
  const arm = () => {
    const pc = conn?.peerConnection; if (!pc || pc.__imperatorIce) return;
    pc.__imperatorIce = true;
    const deadish = () => ['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState) || ['disconnected', 'failed', 'closed'].includes(pc.connectionState);
    const report = () => {
      logNet('ice', { peer: conn.peer ?? conn._who ?? null, ice: pc.iceConnectionState, pc: pc.connectionState });
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed' || pc.connectionState === 'connected') { clearTimeout(conn.__dead); return; }
      if (!deadish()) return;
      clearTimeout(conn.__dead);
      conn.__dead = setTimeout(() => { if (deadish()) { logNet('connection-dead', { peer: conn.peer ?? conn._who ?? null, ice: pc.iceConnectionState, pc: pc.connectionState }); onDead?.(); } }, 1200);
    };
    pc.addEventListener('iceconnectionstatechange', report);
    pc.addEventListener('connectionstatechange', report);
    report();
  };
  arm(); setTimeout(arm, 0);
}
/** PeerJS (WebRTC data channels) with the free PeerJS Cloud signalling server (0.peerjs.com). The room code is the host's peer id
 *  (`imperator-<CODE>`). Messages are JSON strings, split into chunks when long. `Peer` is the PeerJS constructor (src/vendor).
 *  `reclaim`: a host reload keeps retrying the same id while the cloud still lists the old socket (unavailable-id). */
export function createPeerTransport(Peer, { iceServers = ICE_SERVERS, timeoutMs = 20000, debug = 1 } = {}) {
  const ev = hub(); let peer = null; const conns = new Map(); const parts = new Map(); let seq = 0; let watchTimer = null;
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
    open({ role, code, reclaim = false }) {
      return new Promise((resolve, reject) => {
        let done = false; let signalled = false; const started = Date.now();
        const finish = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
        const onTimeout = () => { finish(reject, classifyPeerFailure(null, { signalled, timedOut: true })); try { peer?.destroy(); } catch { /* */ } };
        let timer = setTimeout(onTimeout, timeoutMs);
        const arm = ms => { clearTimeout(timer); timer = setTimeout(onTimeout, ms); };
        const opts = { debug, config: { iceServers } };
        const comeBack = () => {
          logNet('disconnected', peer?.id ?? role);
          try { peer?.reconnect(); } catch (e) { logNet('reconnect-failed', e?.message ?? e); }
        };
        const listen = () => {
          peer.on('disconnected', comeBack);
          // A single webrtc error is often one bad ICE candidate. Do not abort; the timer decides.
          peer.on('error', e => {
            logNet('error', { type: e?.type ?? null, message: e?.message ?? '', signalled, role });
            if (e?.type === 'webrtc') return;
            if (!done && role === 'host' && reclaim && e?.type === 'unavailable-id' && Date.now() - started < timeoutMs - 1500) {
              logNet('reclaim', normCode(code));
              try { peer.destroy(); } catch { /* */ }
              setTimeout(startPeer, 1000);
              return;
            }
            if (!done) { finish(reject, classifyPeerFailure(e, { signalled })); try { peer.destroy(); } catch { /* */ } }
          });
        };
        const startPeer = () => {
          if (done) return;
          if (role === 'host') {
            peer = new Peer(peerIdOf(code), opts);
            listen();
            peer.on('open', id => {
              signalled = true; logNet('open', { role, id });
              if (!watchTimer) {
                watchTimer = setInterval(() => {
                  if (!peer || peer.destroyed) return;
                  if (peer.disconnected || peer.open === false) {
                    logNet('host-reconnect', { id: peer.id, disconnected: !!peer.disconnected, open: peer.open });
                    try { peer.reconnect(); } catch (e) { logNet('reconnect-failed', e?.message ?? String(e)); }
                  }
                }, 2000);
                watchTimer.unref?.();
              }
              finish(resolve, { code: normCode(code) });
            });
            peer.on('connection', conn => {
              const describe = extra => ({ peer: conn.peer, open: !!conn.open, metadata: conn.metadata ?? null, label: conn.label ?? null, reliable: conn.reliable ?? null, serialization: conn.serialization ?? null, ice: conn.peerConnection?.iceConnectionState ?? null, ...extra });
              logNet('connection', describe());
              conn._who = conn.peer; watchIce(conn, () => { if (conns.get(conn.peer) === conn) { conns.delete(conn.peer); try { conn.close(); } catch { /* */ } ev.emitClose(conn.peer); } });
              const arm = () => {
                if (conns.get(conn.peer) === conn && conn.__wired) return;
                conn.__wired = true;
                logNet('connection-open', describe());
                const old = conns.get(conn.peer); conns.set(conn.peer, conn);
                if (old && old !== conn) { logNet('connection-replace', { peer: conn.peer }); try { old.close(); } catch { /* a stale channel for this peer id */ } }
                wire(conn); ev.emitPeer(conn.peer);
              };
              conn.on('open', arm);
              if (conn.open) arm();
              conn.on('close', () => logNet('connection-close', describe()));
              conn.on('error', e => logNet('connection-error', describe({ type: e?.type ?? null, message: e?.message ?? String(e) })));
              conn.on('iceStateChanged', state => logNet('connection-ice', describe({ ice: state })));
            });
          } else {
            peer = new Peer(opts);
            listen();
            peer.on('open', id => {
              signalled = true; logNet('open', { role, id });
              if (timeoutMs >= 20000) arm(45000);   // TURN can take longer than the signalling handshake
              const conn = peer.connect(peerIdOf(code), { reliable: true, serialization: 'json' }); conn._who = HOST;
              watchIce(conn);
              conn.on('open', () => { conns.set(HOST, conn); wire(conn); finish(resolve, { code: normCode(code) }); });
              conn.on('error', e => logNet('conn-error', { type: e?.type ?? null, message: e?.message ?? String(e), peer: HOST }));
            });
          }
        };
        startPeer();
      });
    },
    /** Call when the page wakes up: a backgrounded tab's signalling socket is often dead while the id is still registered. */
    nudge() {
      if (!peer || peer.destroyed) return;
      if (peer.disconnected || peer.open === false) {
        logNet('nudge', peer.id);
        try { peer.reconnect(); } catch (e) { logNet('reconnect-failed', e?.message ?? e); }
      }
    },
    /** Drop a stale data channel (a guest whose browser died) so a new one can take the seat. */
    drop(id) { const c = conns.get(id); if (!c) return; conns.delete(id); try { c.close(); } catch { /* */ } },
    /** False when this peer's data channel is already gone, so the seat can be offered again. */
    isOpen(id) {
      const c = conns.get(id); if (!c?.open) return false;
      const pc = c.peerConnection;
      if (!pc) return true;
      const dead = ['disconnected', 'failed', 'closed'];
      return !dead.includes(pc.iceConnectionState) && !dead.includes(pc.connectionState);
    },
    send(to, obj) {
      const c = conns.get(to); if (!c || !c.open) { logNet('send-drop', { to, open: !!c?.open, type: obj?.t }); return; }
      const frames = peerFrames(JSON.stringify(obj), ++seq);
      if (obj?.t === 'update') logNet('send-update', { to, full: !!obj.full, seq: obj.seq, frames: frames.length, bytes: frames.reduce((n, f) => n + frameBytes(f), 0) });
      for (const f of frames) c.send(f);
    },
    onMessage: ev.onMessage, onPeer: ev.onPeer, onPeerClose: ev.onPeerClose, onProgress: ev.onProgress,
    close() { clearInterval(watchTimer); watchTimer = null; for (const c of conns.values()) try { c.close(); } catch { /* */ } conns.clear(); try { peer?.destroy(); } catch { /* */ } peer = null; },
  };
}
