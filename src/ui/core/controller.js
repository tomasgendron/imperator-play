// M18 / v30 (Vidi 2026-10-27, Q2 approved): the game controller, moved out of src/ui/game/app.js as it was (moved, not rewritten), so the
// desktop page and the mobile page (src/ui-mobile/) run the same loop: the session, apply-an-action, the AI timing, the automatic
// human steps, the autosave, the host's seat view, and the v26.1 background-tab rule. Everything a page draws goes through `view`:
//   view.data() -> the game data          view.render()                 view.playEvents(events, before) -> Promise (animations)
//   view.freezeControls()                 view.applied({ fromAi })      view.thinking(pid)       view.toast(text)    view.sound(id)
//   view.showGameOver()                   view.displeasedAlert(frame) -> Promise<bool>
//   view.guestSend(action)  view.netPush()  view.hostDrain()  view.guestDrain()   (online wiring, still on the desktop page)
// The page keeps its state on the returned object: C.S (the session), C.viewer, C.busy, C.NET, C.speed, C.aiTimer, C.aiPaused, ...
import { current } from '../consoleModel.js';
import { topFrame, whoActs, viewFor, eventsFor } from '../../engine/index.js';
import * as G from '../game/model.js';

export function createController(view) {
  const c = {
    S: null,                       // the session (history of states)
    viewer: null,
    busy: false, aiTimer: null, aiPaused: false,
    uiLabel: 'v17',
    speed: 1,
    NET: null,                     // host: {role, code, transport, room, me, inbox}; guest: {role, code, transport, client, me, q, pending}
    displeasedSeen: null, autoRoll: false,
    seatViewCache: { s: null, me: null, v: null },
  };
  try { c.speed = Number(localStorage.getItem('imperator.speed')) || 1; } catch { /* */ }
  // v26.1 (Vidi 2026-10-25, the stuck Revolt Roll): a host page in a background tab has its timers throttled by the browser (1 s, then
  // once a minute), so its animations, popups and AI delays held a guest's move for minutes ("No roll is due for you right now" on the
  // guest). Hidden, the host skips the waits: `sleep` returns at once and `later` runs through a MessageChannel (not throttled).
  const hostHidden = () => c.NET?.role === 'host' && document.hidden;
  const later = (fn, ms) => { if (!hostHidden()) return setTimeout(fn, ms); const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); fn(); }; ch.port2.postMessage(0); return null; };
  const sleep = ms => new Promise(r => (hostHidden() ? r() : setTimeout(r, ms)));
  const spd = ms => Math.max(10, ms * c.speed);
  // M12 (online step c): an online host's own screen shows the host's seat view too (viewFor: no peeking at the guests' hands or
  // prompts); the engine, the AI, saves and the guests' updates use the full state (full()). Offline hot-seat: unchanged.
  const full = () => G.stateOf(c.S);
  const st = () => {
    const s = G.stateOf(c.S);
    if (c.NET?.role !== 'host' || !c.NET.me || !s) return s;
    if (c.seatViewCache.s !== s || c.seatViewCache.me !== c.NET.me) c.seatViewCache = { s, me: c.NET.me, v: viewFor(s, view.data(), c.NET.me) };
    return c.seatViewCache.v;
  };

  // ------------------------------------------------------------------ the loop: apply an action, animate its events, schedule the AI
  async function apply(action, { fromAi = false, remote = null } = {}) {
    if (c.busy || !c.S) return false;
    if (c.NET?.role === 'guest') return view.guestSend(action);
    const before = st();
    const r = G.play(c.S, action);
    if (remote) remote(r.error);   // M11: a guest's move; the engine's checks decide, its error goes back to that guest only
    if (r.error) { if (!remote) { view.sound('error_denied'); view.toast(r.error.message + (r.error.rule ? ` (${r.error.rule})` : '')); } return false; }
    c.S = r.session; c.busy = true; document.body.dataset.busy = '1';
    if (c.NET?.role === 'host') view.netPush();
    view.freezeControls();
    view.applied({ fromAi });      // desktop: the builder closes (not for an AI move) and the prompt overlay goes
    const evs = c.NET?.role === 'host' && c.NET.me ? eventsFor(current(c.S).events, c.NET.me) : current(c.S).events;   // M12: the host sees its seat's events
    if (!hostHidden()) { try { await view.playEvents(evs, before); } catch (e) { console.warn('animation', e); } }   // v26.1: a hidden host does not animate
    c.busy = false; document.body.dataset.busy = '';
    autosave(); view.render(); schedule();
    return true;
  }
  function schedule() {
    clearTimeout(c.aiTimer); c.aiTimer = null; c.autoRoll = false;
    if (!c.S || document.body.dataset.screen !== 'game') return;
    const s = st();
    if (s.phase === 'finished') { view.showGameOver(); return; }
    if (c.NET?.role === 'guest') { if (!c.busy) humanAuto(s); return; }   // M11: a guest runs no AI and no automatic rolls: the host does
    if (c.NET?.role === 'host' && !c.busy && c.NET.inbox.length) { later(view.hostDrain, 0); return; }
    if (!c.busy && humanAuto(s)) return;
    if (c.aiPaused || c.busy || !G.aiToMove(c.S)) return;
    const f = topFrame(s); const auto = f && f.kind === 'roll' && !f.player;
    view.thinking(whoActs(s));
    c.aiTimer = later(async () => { c.aiTimer = null; if (c.busy || !G.aiToMove(c.S) || c.aiPaused) return; await apply(G.aiMove(c.S), { fromAi: true }); }, spd(auto ? 300 : 650));
  }
  /** Batch 5 items 1 and 8: what happens by itself for a human. Scouting rolls the natives at once (no Roll click, 17.h); a Rome Is
   *  Displeased draw that falls on a human is announced first by a big banner that waits for OK (16.m). */
  function humanAuto(s) {
    const f = topFrame(s); if (!f) return false;
    if (f.kind === 'roll' && f.purpose === 'nativeRoll' && G.isHuman(s, f.player) && c.NET?.role !== 'guest') {
      c.autoRoll = true; document.body.dataset.humanTurn = '';
      c.aiTimer = later(() => { c.aiTimer = null; c.autoRoll = false; if (!c.busy && topFrame(st())?.purpose === 'nativeRoll') apply({ type: 'ROLL', playerId: f.player }); else view.render(); }, spd(200));
      return true;
    }
    if (f.kind === 'draw' && f.deck === 'displeased' && G.isHuman(s, f.player) && (!c.NET || f.player === c.viewer) && c.displeasedSeen !== f.id) {
      c.displeasedSeen = f.id; c.busy = true; document.body.dataset.busy = '1';
      view.displeasedAlert(f).then(draw => {
        c.busy = false; document.body.dataset.busy = ''; view.render(); schedule(); view.guestDrain();
        const d = draw && !c.busy && displeasedDraw(f); if (d && topFrame(st())?.id === f.id) human(d);   // v27: "Draw the card now"
      });   // v26.1: an update that came during the alert
      return true;
    }
    return false;
  }
  /** The DRAW from Rome Is Displeased this screen may make for frame `f` (null: not this screen's draw). */
  function displeasedDraw(f) { return mineNow().find(d => d.type === 'DRAW_CARD' && d.action.playerId === f.player && (!c.NET || f.player === c.NET.me)) ?? null; }
  const human = d => { if (c.busy) return; view.sound('button_click'); return apply(d.range ? G.withValue(d, d._v ?? d.range.max) : d.action); };
  /** The human who decides now and their legal moves (none for AI seats). Hot-seat (Q95, Vidi 2026-10-21): no curtain; the board
   *  switches to the next player's context at End Turn, and the optional hide-hand toggle covers the hand. */
  function mineNow() {
    if (c.NET?.role === 'guest') return c.NET.pending ? [] : current(c.S).legal ?? [];   // M11: the host sends each guest its legal moves
    const s = full(); const w = whoActs(s);   // the full state: legal moves need the own hand and the decks
    if (!G.isHuman(s, w) || w !== c.viewer) return [];
    return G.humanLegal(s, view.data(), w);
  }
  // ------------------------------------------------------------------ save
  /** M14: a host's save keeps the room (code, seats, guest tokens, the seed salt), so "Resume online game" can reopen it. */
  const withOnline = o => (c.NET?.role === 'host' && c.NET.me && c.NET.room.started ? { ...o, online: { code: c.NET.code, me: c.NET.me, salt: c.NET.salt, room: c.NET.room.snapshot() } } : o);
  const makeSaveNow = kind => withOnline(G.makeSave(c.S, { appVersion: c.uiLabel, kind }));
  function autosave() { if (!c.S || c.NET?.role === 'guest') return; try { localStorage.setItem('imperator.autosave', JSON.stringify(makeSaveNow('autosave'))); } catch (e) { console.warn('autosave failed', e.message); } }

  return Object.assign(c, { hostHidden, later, sleep, spd, full, st, mineNow, apply, schedule, humanAuto, displeasedDraw, human, withOnline, makeSaveNow, autosave });
}
