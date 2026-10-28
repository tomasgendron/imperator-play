// M18.2 / v30.2 (Vidi via Boardicca 2026-10-28, "AGREE, PROCEED"): a phone JOINS online games (hosting from a phone comes later).
// The same guest wiring as the desktop page (src/ui/game/app.js, M11-M14 + the v26.1 sync fix), on the same pure modules: src/net/guest.js
// (GuestClient: hello with the seat token, reconnect with retries, host-away, heartbeat resync), src/net/transport.js (PeerJS, or the
// BroadcastChannel loopback with ?net=local) and the controller (src/ui/core/controller.js: C.NET, apply -> view.guestSend, mineNow
// = the legal moves the host sent). The desktop page is not changed and never loads this file.
import { GuestClient, HOST_AWAY_MS } from '../net/guest.js';
import { createPeerTransport, createBroadcastTransport } from '../net/transport.js';
import { normCode } from '../net/protocol.js';

export const SEAT_TOKEN_KEY = 'imperator.online.seat';   // the desktop's key: a seat joined on this browser is kept across reloads
export const NAME_KEY = 'imperator.online.name';
export const PEND_SLOW_MS = 6000, PEND_RETRY_MS = 25000;   // v26.1, as on the desktop
export { HOST_AWAY_MS, normCode };
export const netMode = () => new URLSearchParams(location.search).get('net');   // 'local' = BroadcastChannel between tabs (tests)
let peerLib = null;
function loadPeer() {
  if (window.peerjs?.Peer) return Promise.resolve(window.peerjs.Peer);
  return peerLib ??= new Promise((res, rej) => {
    let u = 'src/vendor/peerjs.min.js'; try { u = import.meta.resolve('../vendor/peerjs.min.js'); } catch { /* */ }
    const sc = document.createElement('script'); sc.src = u;
    sc.onload = () => (window.peerjs?.Peer ? res(window.peerjs.Peer) : rej(new Error('The online module did not load.')));
    sc.onerror = () => { peerLib = null; rej(new Error('Could not load the online module (src/vendor/peerjs.min.js).')); };
    document.head.append(sc);
  });
}
export async function makeTransport() { return netMode() === 'local' ? createBroadcastTransport() : createPeerTransport(await loadPeer()); }
export const whyText = w => ({ LINK_LOST: 'the link dropped', HOST_LEFT: 'the host left the game', NO_ROOM: 'the room is not open', NETWORK: 'network error', TIMEOUT: 'no answer', RETRY: 'retrying' })[w] ?? String(w ?? 'no link').toLowerCase().replace(/_/g, ' ');

/**
 * page: { C, data, inGame(), say(msg, bad), lobby(m), enter(), render(), schedule(), toast(m), sound(id), freezeControls(),
 *         playEvents(evs, before) -> Promise, lost(msg), banner(), resynced(u) }
 */
export function createGuest(page) {
  const { C } = page;
  const st = () => page.st();
  function leave() {
    const n = C.NET; if (!n) return;
    C.NET = null; clearInterval(n.ping); clearTimeout(n.pendSlow); clearTimeout(n.pendRetry);
    try { n.client.leave(); } catch (e) { console.warn('leave', e); }
    document.body.dataset.online = ''; document.body.dataset.netStatus = ''; page.banner();
  }
  async function join(codeIn, nameIn, was = '') {
    const code = normCode(codeIn); const name = String(nameIn ?? '').trim().slice(0, 20);
    if (code.length < 4) { page.say('Type the room code the host sent you (6 letters/digits).', true); return false; }
    if (!name) { page.say('Type your name first.', true); return false; }
    try { localStorage.setItem(NAME_KEY, name); } catch { /* */ }
    leave(); page.say('Connecting…'); page.busyJoin(true);
    let saved = null; try { saved = JSON.parse(localStorage.getItem(SEAT_TOKEN_KEY) || 'null'); } catch { /* */ }
    const mine = saved && (saved.code === code || (was && saved.code === was));   // M14: ?was=OLD: the same game under a new code
    let t; try { t = await makeTransport(); } catch (e) { page.say(e.message, true); page.busyJoin(false); return false; }
    const n = { role: 'guest', code, transport: t, me: null, q: [], pending: false, shown: null, healOff: 0 };
    const mineNet = () => C.NET === n;
    n.client = new GuestClient({ transport: t, makeTransport, build: C.uiLabel, name, token: mine ? saved.token : null, data: page.data(), hooks: {
      onWelcome: (c, m) => { n.code = c.code; if (mineNet()) pendDone(); else n.pending = false;
        try { localStorage.setItem(SEAT_TOKEN_KEY, JSON.stringify({ code: c.code, token: m.token, seat: m.seat, at: Date.now() })); } catch { /* */ }
        if (!page.inGame()) page.say(`Joined room ${c.code} as ${m.name} (seat ${m.seat + 1}). Waiting for the host to start…`); },
      onLobby: (c, m) => { if (mineNet()) page.lobby(m); if (C.S && mineNet() && page.inGame()) page.render(); },
      onUpdate: (c, u) => { if (!mineNet()) return; n.me = u.you.playerId; n.q.push(u); if (!page.inGame()) enter(); else drain(); },
      onReject: (c, m) => { if (!mineNet()) return;
        if (!page.inGame()) { page.say(m.message, true); return; }
        pendDone(); if (m.code !== 'STALE') { page.sound('error_denied'); page.toast(m.message); } page.render(); },
      onBye: (c, r) => { if (!mineNet()) return;
        if (r === 'HOST_LEFT' && !c.ended) return;   // M14: not final: the host may resume; the client reconnects (onStatus)
        if (r === 'BUILD_MISMATCH' || r === 'FULL' || r === 'STARTED') { page.busyJoin(false); leave(); return; }
        if (r === 'GAME_OVER' && page.inGame()) { n.lost = 'The game is over; the host closed the room.'; page.banner(); return; }
        lost(r === 'SEAT_REMOVED' ? 'The host removed your seat.' : r === 'REPLACED' ? 'You joined this game from another tab; this tab is disconnected.' : 'The host ended the connection.'); },
      onHostGone: () => { if (mineNet()) lost('Lost the connection to the host.'); },
      onStatus: (c, status, info) => { if (!mineNet()) return;
        n.status = status; n.info = info; (n.statuses ??= []).push(status + (info.why ? ':' + info.why : ''));
        if (status === 'reconnecting' || status === 'lost') pendDone();
        if (status === 'connected' && info.rejoined) { if (page.inGame()) page.toast('Reconnected: you are back in your seat'); else page.say(`Reconnected to room ${c.code}.`); }
        if (!page.inGame() && status === 'reconnecting') page.say(`Lost the host (${whyText(info.why)}). Reconnecting… (try ${info.attempt} of ${info.of})`, true);
        if (!page.inGame() && status === 'lost') { page.say('Could not reach the host. Tap Join to try again.', true); page.busyJoin(false); leave(); return; }
        page.banner(); if (page.inGame()) page.render(); },
    } });
    C.NET = n; document.body.dataset.online = 'guest';
    n.ping = setInterval(() => { n.client.tick(); try { heal(); } catch (e) { console.warn('heal', e); } }, 2000);
    try { await n.client.join(code); } catch (e) { if (mineNet()) leave(); page.say(e.message, true); page.busyJoin(false); return false; }
    return true;
  }
  function lost(msg) {
    const n = C.NET; if (!n) return;
    if (!C.S || !page.inGame()) { page.say(msg, true); page.busyJoin(false); C.NET = null; clearInterval(n.ping); try { n.transport.close(); } catch { /* */ } return; }
    n.lost = msg; document.body.dataset.netLost = '1'; page.render(); page.banner(); page.lost(msg);
  }
  function enter() {
    const u = C.NET.q.shift(); if (!u) return;
    C.S = { data: page.data(), seed: 'room ' + C.NET.code, steps: [{ state: u.state, events: [], action: null, error: null, legal: u.legal, seq: u.seq }] }; C.NET.shown = u.seq;
    page.busyJoin(false); page.sound('deck_shuffle'); page.enter();
    if (C.NET.q.length) drain();
  }
  /** The host's updates in order, each animated like a local move (several waiting at once: only the last is animated). v26.1: a throw
   *  anywhere asks the host for the whole view again instead of leaving this screen on an old step. */
  async function drain() {
    const n = C.NET;
    if (n?.role !== 'guest' || C.busy || !C.S || !n.q.length || !page.inGame()) return;
    let u, before;
    try {
      while (n.q.length) {
        u = n.q.shift(); before = st();
        if (n.throwOnce) { n.throwOnce = false; throw new Error('test: the page could not apply this update'); }
        C.S = { ...C.S, steps: [...C.S.steps.slice(-2), { state: u.state, events: u.anim ?? [], action: null, error: null, legal: u.legal, seq: u.seq }] };
        n.shown = u.seq;
        if (u.by === n.me) pendDone();
        if (u.resynced) { n.resynced = (n.resynced ?? 0) + 1; document.body.dataset.resynced = String(n.resynced); page.toast('Resynced with the host: your screen now shows the game as it is'); }
      }
    } catch (e) { return broke(e); }
    C.busy = true; document.body.dataset.busy = '1';
    try { page.freezeControls(); await page.playEvents(u.anim ?? [], before); } catch (e) { console.warn('animation', e); }
    C.busy = false; document.body.dataset.busy = '';
    try { page.render(); page.schedule(); } catch (e) { return broke(e); }
    drain();
  }
  function broke(e) {
    console.error('guest update', e);
    C.busy = false; document.body.dataset.busy = '';
    if (C.NET?.role !== 'guest') return;
    C.NET.broke = (C.NET.broke ?? 0) + 1; document.body.dataset.guestBroke = String(C.NET.broke);
    C.NET.client.resync('APPLY');
  }
  /** Every 2 s: a queue nothing drains is drained; a shown step that is not the client's last asks for a resync (two ticks in a row). */
  function heal() {
    const n = C.NET; if (n?.role !== 'guest' || !C.S || !page.inGame() || n.client.status !== 'connected') return;
    if (C.busy) { n.healOff = 0; return; }
    if (n.q.length) { drain(); return; }
    if (n.client.seq != null && n.shown !== n.client.seq) { if (++n.healOff >= 2) { n.healOff = 0; n.client.resync('VIEW'); } } else n.healOff = 0;
  }
  function send(action) {
    const n = C.NET;
    if (n.pending || n.lost) { if (n.lost) page.toast(n.lost); return false; }
    if (n.client.status !== 'connected') { page.toast('Reconnecting to the host: wait a moment'); return false; }
    n.pending = true; n.client.act(action); pendWatch(); page.freezeControls(); return true;
  }
  function pendWatch() {
    const n = C.NET; clearTimeout(n.pendSlow); clearTimeout(n.pendRetry); n.slow = false;
    n.pendSlow = setTimeout(() => { if (C.NET === n && n.pending) { n.slow = true; page.banner(); } }, PEND_SLOW_MS);
    n.pendRetry = setTimeout(() => { if (C.NET === n && n.pending) { n.pending = false; n.slow = false; page.toast('The host has not answered your move yet: you can make it again'); page.render(); } }, PEND_RETRY_MS);
  }
  function pendDone() {
    if (C.NET?.role !== 'guest') return;
    const was = C.NET.slow; C.NET.pending = false; C.NET.slow = false; clearTimeout(C.NET.pendSlow); clearTimeout(C.NET.pendRetry);
    if (was) page.banner();
  }
  /** Why this guest cannot act now (null: nothing special; the shared gate's own reason is used). */
  function notDue() {
    const n = C.NET; if (n?.role !== 'guest') return null;
    if (n.lost) return n.lost;
    if (n.pending) return `Your move was sent: waiting for the host to answer${n.slow ? ' (their page may be showing a popup, or be in the background)' : '…'}`;
    if (n.client.ai) return 'The host gave your seat to the AI: the AI plays it for now.';
    if (n.client.status !== 'connected') return 'Reconnecting to the host: wait a moment.';
    return null;
  }
  /** The online strip on the game screen: 'connected' (hidden) | reconnecting | lost | hostAway | waiting | ai | ended. */
  function status() {
    const n = C.NET; if (n?.role !== 'guest') return '';
    const c = n.client;
    return n.lost ? 'ended' : c.status === 'connected' && c.hostAway ? 'hostAway' : c.status === 'connected' && c.ai ? 'ai' : c.status === 'connected' && n.pending && n.slow ? 'waiting' : c.status;
  }
  return { join, leave, send, drain, heal, notDue, status, pendDone };
}
