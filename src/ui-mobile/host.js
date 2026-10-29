// M18.4 / v30.4 (Vidi via Boardicca 2026-10-28): a phone HOSTS online games. The same host wiring as the desktop page
// (src/ui/game/app.js: openHost, hostNet, hostDrain, nudgeHost, netPush, seatToAI, seatBack, resumeOnline, netLeave; M11-M14 and the
// v26.1 sync fix) on the same pure modules: src/net/host.js (HostRoom: seats, tokens, hello/welcome, the lobby, each guest's own view
// and legal moves, ping/away, snapshot/restore), src/net/transport.js and the shared controller (src/ui/core/controller.js: apply ->
// view.netPush, schedule -> view.hostDrain, withOnline in every save). The phone's browser runs the engine and is the only one that rolls
// dice, exactly as a desktop host. Phone-only parts: the Screen Wake Lock (kept while hosting, asked again when the page comes back),
// and a warning when the page goes to the background or the screen locks (the guests drop then; on return they reconnect to their
// seats by themselves and the host sends every guest the whole view again). The desktop page is not changed and never loads this file.
import { HostRoom, PING_MS } from '../net/host.js';
import { roomCode } from '../net/protocol.js';
import { makeTransport, netMode } from './guest.js';

export const newSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
/** A save of an online game this browser hosted (it has the room: code, seats, guest tokens), not finished. */
export function onlineSave(text) { try { const o = typeof text === 'string' ? JSON.parse(text) : text; return o?.online?.room?.seats && o.snapshot?.phase !== 'finished' ? o : null; } catch { return null; } }
/** The link a guest opens (desktop or phone: the detector on index.html sends a phone on to mobile.html with the query kept). */
export const joinLink = (code, was = null) => `${location.origin}${location.pathname.replace(/mobile\.html$/, '')}?join=${code}${was ? '&was=' + was : ''}${netMode() ? '&net=' + netMode() : ''}`;

/**
 * page: { C, data(), st(), full(), inGame(), lobby(room) (the start screen's host lobby changed), render(), autosave(), schedule(),
 *         toast(m), current(session), closePops() (a hidden host closes a popup that waits for OK), popupWaiting() -> bool,
 *         away(ms) (the page came back after ms in the background), wake(state) }
 */
export function createHost(page) {
  const { C } = page;
  const W = { lock: null, want: false, state: 'off', hiddenAt: 0, awayMs: 0 };
  // ---------------------------------------------------------------- the room
  async function open() {
    let lastErr = null;
    for (let k = 0; k < 4 && !C.NET; k++) {
      const code = roomCode();
      let t; try { t = await makeTransport(); await t.open({ role: 'host', code }); }
      catch (e) { lastErr = e; try { t?.close(); } catch { /* */ } if (e.code === 'ROOM_TAKEN') continue; break; }
      if (page.cancelled?.()) { t.close(); return null; }
      net(t, code, newSalt()); wakeOn(); return C.NET;
    }
    if (!C.NET) throw lastErr ?? new Error('Could not open a room.');
    return C.NET;
  }
  function net(t, code, salt) {
    C.NET = { role: 'host', code, transport: t, me: null, inbox: [], salt };
    C.NET.room = new HostRoom({ transport: t, build: C.uiLabel, code, seats: [], data: page.data(), hooks: {
      onSeat: () => queueMicrotask(() => { if (C.NET?.role !== 'host') return; if (!page.inGame()) page.lobby(C.NET.room); else if (C.S) { page.render(); page.autosave(); } }),
      onAct: (i, action, reply, fresh) => { C.NET.inbox.push({ i, action, reply, fresh }); if (!C.busy) drain(); else nudge(i); },
    } });
    C.NET.ping = setInterval(() => { if (!C.NET?.quiet) C.NET?.room?.tick(); }, PING_MS);   // quiet: tests only
    document.body.dataset.online = 'host';
    return C.NET;
  }
  /** The start screen's seats -> the room's seat table (lobby only): kinds 'local' (this phone) | 'remote' (Online) | 'ai'. */
  function configure(seats) { if (C.NET?.role === 'host' && !page.inGame()) C.NET.room.configure(seats); }
  /** Can the host start? Every Online seat has its player (connected). */
  function readiness(seats) {
    if (C.NET?.role !== 'host') return { ok: false, why: 'Opening the room…' };
    if (!seats.some(x => x.controller === 'remote')) return { ok: false, why: 'Mark at least one seat as Online, or play on this phone instead.' };
    const wait = C.NET.room.seats.filter(x => x.kind === 'remote' && !(x.token && x.connected)).length;
    return wait ? { ok: false, why: `Waiting for ${wait} player${wait > 1 ? 's' : ''} to join: send them the code ${C.NET.code} or the link.` } : { ok: true, why: 'Everyone is here: tap Start game.' };
  }
  const remoteName = i => (C.NET?.role === 'host' ? C.NET.room.seats[i]?.name ?? '' : '');
  /** After the session was made: the host's own seat and the engine's player ids. */
  function started(hostSeat) { const s = page.full(); C.NET.me = s.players[hostSeat].id; C.NET.room.start(s.players.map(p => p.id)); }
  // ---------------------------------------------------------------- moves (as the desktop: one guest move at a time, when not busy)
  async function drain() {
    if (C.NET?.role !== 'host' || C.busy || !C.S || !C.NET.inbox.length) return;
    const { action, reply, fresh } = C.NET.inbox.shift();
    if (fresh && !fresh()) reply({ code: 'STALE', message: 'The game moved on before your move arrived; choose again.' });
    else await C.apply(action, { remote: reply });
    if (C.NET?.inbox.length && !C.busy) drain();
  }
  function nudge(i) {
    if (C.NET?.role !== 'host' || !C.S) return;
    if (document.hidden) { page.closePops(); return; }
    if (page.popupWaiting()) page.toast(`${page.full().players[i]?.name ?? 'A guest'} has moved and is waiting: tap OK to go on`);
  }
  function push() {
    if (C.NET?.role !== 'host' || !C.S) return;
    const c = page.current(C.S); C.NET.room.update({ seq: C.S.steps.length, state: c.state, events: c.events ?? [], by: c.action?.playerId ?? null });
  }
  /** Every guest gets the whole current view again (after the page was in the background). */
  function pushAll() { if (C.NET?.role !== 'host' || !C.S || !C.NET.room.last) return; for (const s of C.NET.room.seats) if (s.peer) C.NET.room.sendUpdate(s, C.NET.room.last, { full: true }); }
  function setController(pid, controller) {
    const c = page.current(C.S);
    C.S = { ...C.S, steps: [...C.S.steps.slice(0, -1), { ...c, state: { ...c.state, players: c.state.players.map(p => (p.id === pid ? { ...p, controller } : p)) } }] };
    C.NET.room.update({ seq: C.S.steps.length, state: page.full(), events: [], by: null });
  }
  function toAI(i) {
    if (C.NET?.role !== 'host' || !C.S) return false;
    const p = page.full().players[i]; if (!p || !C.NET.room.seatToAI(i)) return false;
    setController(p.id, 'ai'); page.toast(`${p.name} is now played by the AI`); page.autosave(); page.render(); page.schedule(); return true;
  }
  function back(i) {
    if (C.NET?.role !== 'host' || !C.S) return false;
    const p = page.full().players[i]; if (!p) return false;
    if (!C.NET.room.seatBack(i)) { page.toast(`${p.name} is not connected: the seat stays with the AI`); return false; }
    setController(p.id, 'human'); page.toast(`${p.name} plays their seat again`); page.autosave(); page.render(); page.schedule(); return true;
  }
  /** One seat's online state for the player chips and the host strip: you | host | online | away | ai-online | ai-away | null. */
  function seatState(i) {
    if (C.NET?.role !== 'host' || !C.S) return null;
    const p = page.full().players[i]; if (!p) return null;
    if (p.id === C.NET.me) return 'you';
    const s = C.NET.room.seats[i]; if (!s) return null;
    if (s.kind === 'ai') return s.token ? (s.connected && s.peer ? 'ai-online' : 'ai-away') : null;
    if (s.kind !== 'remote') return 'host';
    return s.connected ? 'online' : 'away';
  }
  // ---------------------------------------------------------------- resume a hosted game from a save (M14)
  async function resume(obj, readSave) {
    const ns = readSave(obj);   // throws a readable error
    const on = obj.online; leave(); clearTimeout(C.aiTimer);
    let t = null, code = null, err = null;
    for (let k = 0; k < 5 && !t; k++) {
      const c = k === 0 ? on.code : roomCode();
      let x; try { x = await makeTransport(); await x.open({ role: 'host', code: c }); t = x; code = c; }
      catch (e) { err = e; try { x?.close(); } catch { /* */ } if (e.code !== 'ROOM_TAKEN') break; }
    }
    if (!t) throw new Error('Could not reopen the room: ' + (err?.message ?? 'no network'));
    net(t, code, on.salt ?? newSalt());
    C.NET.room.restore({ ...on.room, code }); C.NET.me = on.me;
    C.S = ns; wakeOn();
    return { code, same: code === on.code, old: on.code };
  }
  function leave() {
    const n = C.NET; if (n?.role !== 'host') return;
    C.NET = null; clearInterval(n.ping); wakeOff();
    try { n.room.close(C.S && page.full()?.phase === 'finished' ? 'GAME_OVER' : 'HOST_LEFT'); } catch (e) { console.warn('leave', e); }
    document.body.dataset.online = ''; document.body.dataset.netStatus = '';
  }
  // ---------------------------------------------------------------- the phone: keep the screen on; warn about the background
  const wakeSet = s => { W.state = s; document.body.dataset.wake = s; page.wake?.(s); };
  async function wakeAsk() {
    if (!W.want || document.hidden || W.lock) return;
    if (!('wakeLock' in navigator)) { wakeSet('unsupported'); return; }
    try {
      const l = await navigator.wakeLock.request('screen');
      if (!W.want) { l.release().catch(() => {}); return; }
      W.lock = l; wakeSet('on');
      l.addEventListener('release', () => { if (W.lock === l) { W.lock = null; if (W.want) wakeSet(document.hidden ? 'paused' : 'off'); } });
    } catch (e) { wakeSet('denied'); }
  }
  function wakeOn() { W.want = true; wakeAsk(); }
  function wakeOff() { W.want = false; const l = W.lock; W.lock = null; if (l) l.release().catch(() => {}); wakeSet('off'); }
  function visibility() {
    if (C.NET?.role !== 'host') return;
    if (document.hidden) { W.hiddenAt = Date.now(); page.autosave(); if (C.NET.inbox.length) page.closePops(); return; }
    const ms = W.hiddenAt ? Date.now() - W.hiddenAt : 0; W.hiddenAt = 0; W.awayMs = ms;
    wakeAsk();
    try { C.NET.room.tick(); } catch { /* */ }
    pushAll();
    if (ms >= 2000) page.away(ms);
    drain();
  }
  document.addEventListener('visibilitychange', visibility);
  addEventListener('pageshow', () => { if (!document.hidden) visibility(); });
  return { open, configure, readiness, remoteName, started, drain, nudge, push, pushAll, toAI, back, seatState, resume, leave, wake: () => W.state, visibility, wakeOn, wakeOff };
}
