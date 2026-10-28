// M18 / v30 (Vidi 2026-10-27, PLAN-mobile.md): the phone page. It runs the same engine, rules data, AI and game loop as the desktop page
// (src/ui/core/controller.js: apply, the AI timing, the autosave) and the same helpers (src/ui/game/model.js: legal moves, hands, log,
// steps), so every button here is one of the engine's legal moves for this seat, exactly as on the desktop. Only the screen differs:
// portrait = players on top, the map in the middle, a thumb bar of actions at the bottom; landscape = players left, actions right.
// v30 plays on this phone (hot-seat and AI); online Join is v30.3, hosting after v30.4 (the Host and Join tabs say so).
import { loadGameData } from '../ui/loadData.js';
import { resolveAsset } from '../ui/assets.js';
import { setupChoices, checkSetup } from '../ui/consoleModel.js';
import { topFrame, whoActs, totalTroops, provincesOf as ownedBy, isUnderGarrisoned } from '../engine/index.js';
import * as G from '../ui/game/model.js';
import { createSound } from '../ui/game/sound.js';
import { createController } from '../ui/core/controller.js';
import { createMapView } from './map.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = s => esc(s).replace(/'/g, '&#39;');
const UI_KEY = 'imperator.ui';

let data, assets, SND, MV;
const C = createController({
  data: () => data, render: () => render(), playEvents: (evs, before) => playEvents(evs, before), freezeControls: () => freezeControls(),
  applied: ({ fromAi }) => { if (!fromAi && ['ask', 'list', 'moves', 'cards', 'assassin', 'cardTargets', 'ally', 'drawcall'].includes(sheetKind)) closeSheet(true); },
  thinking: pid => $$('#players .pl').forEach(el => el.classList.toggle('thinking', el.dataset.pid === pid)),
  toast: m => toast(m), sound: id => SND.play(id), showGameOver: () => showGameOver(), displeasedAlert: f => displeasedAlert(f),
  guestSend: () => false, netPush: () => {}, hostDrain: () => {}, guestDrain: () => {},   // v30: no online play on a phone yet (v30.3)
});
const { st, mineNow, human, schedule, autosave, makeSaveNow, spd, sleep } = C;
const img = (id, o = {}) => { const r = resolveAsset(assets, id, o); return r.path ?? r.fallback ?? r.placeholder; };
const prov = id => data.provincesById[id]?.name ?? id;
const pn = id => G.nameOf(st(), id);
const col = id => G.colorClass(st(), id);   // 'p1' | 'p2' | 'p3' | 'none'
const cvar = id => (col(id) === 'none' ? 'var(--native)' : `var(--${col(id)})`);
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

// ------------------------------------------------------------------ v30.1: the shared "who may act" (G.seatActsGate, the desktop General popup's gate)
// Every sheet button goes through act(): it asks the gate for the seat whose move it is and plays the engine's own descriptor for it,
// re-found in the current legal list, so a stale sheet, another seat's screen or a busy animation can never send a move.
const gateWho = s => (s.phase === 'turn' || s.phase === 'setup' ? whoActs(s) : null);
function gateFor(pid) { const s = st(); return G.seatActsGate(s, pid, mineNow(), { who: gateWho(s), busy: C.busy }); }
function act(d) {
  if (!d || !C.S) return false;
  const pid = d.playerId ?? d.action?.playerId ?? whoActs(st()); const g = gateFor(pid);
  if (!g.live) { SND.play('error_denied'); toast(g.why); return false; }
  const want = d.range ? G.withValue(d, d._v ?? d.range.max) : d.action;
  const cur = G.findDesc(g.legal, want);
  if (!cur) { SND.play('error_denied'); toast('That move is no longer possible.'); render(); return false; }
  human(cur.range ? { ...cur, _v: want[cur.range.field] } : cur); return true;
}
const gateNote = g => (g.live ? '' : `<div class="gatebar" data-gate="off">🔒 ${esc(g.why)}</div>`);

// ------------------------------------------------------------------ the view switch (Q3): localStorage['imperator.ui'], see src/ui/detect.js
function goView(v) {
  try { if (v === 'auto') localStorage.removeItem(UI_KEY); else localStorage.setItem(UI_KEY, v); } catch { /* private mode */ }
  const keep = location.search.replace(/^\?/, '').split('&').filter(x => x && !/^ui=/.test(x)).join('&');
  location.href = (v === 'mobile' ? 'mobile.html' : 'index.html') + '?ui=' + v + (keep ? '&' + keep : '') + location.hash;
}
const viewLinks = () => `<a class="viewswitch" id="mDesktop" href="#">🖥 Use desktop view</a>${window.__imperatorUI?.forced ? '<a class="viewswitch" id="mAuto" href="#" style="padding-top:0">↺ Automatic view (phone → mobile)</a>' : ''}`;
function wireViewLinks(root = document) {
  const d = $('#mDesktop', root); if (d) d.onclick = e => { e.preventDefault(); goView('desktop'); };
  const a = $('#mAuto', root); if (a) a.onclick = e => { e.preventDefault(); goView('auto'); };
}

// ------------------------------------------------------------------ boot
async function boot() {
  try { ({ data, assets } = await loadGameData()); } catch (e) { document.body.innerHTML = `<pre style="padding:20px;color:#f0a35e;white-space:pre-wrap">Imperator could not load its data:\n${esc(e.message)}</pre>`; return; }
  SND = createSound(assets);
  try { const b = await (await fetch('BUILD.json', { cache: 'no-store' })).json(); C.uiLabel = b.uiLabel ?? `v30 · ${b.stamp}`; } catch { C.uiLabel = 'v30 · (no BUILD.json)'; }
  document.documentElement.style.setProperty('--title', `url("${new URL(img('ui.title'), location.href).href}")`);
  $('#mapImg').src = img('map'); $('#minimap').style.backgroundImage = `url("${img('map')}")`;
  $('#dieImg').src = img('dice.d10');
  const sp = data.map.map.tokenSpace;
  MV = createMapView({ wrap: $('#mapwrap'), inner: $('#mapinner'), mini: $('#minimap'), frame: $('#mmv'), aspect: sp.h / sp.w });
  $('#zIn').onclick = () => MV.zoomBy(1.35); $('#zOut').onclick = () => MV.zoomBy(1 / 1.35); $('#zFit').onclick = () => MV.fit();
  addEventListener('resize', () => requestAnimationFrame(() => MV.refit()));
  $('#scrim').onclick = () => { if (!sheetSticky) closeSheet(); };
  $('#bLog').onclick = () => openLog();
  $('#bMenu').onclick = () => openMenu();
  $('#dieChip').onclick = () => openLog();
  $('#importFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFrom(await f.text()); };
  renderStart();
  document.body.dataset.ready = '1';
}

// ------------------------------------------------------------------ start screen (This phone / Host / Join, players, starts, decks, advanced)
const SEAT_NAMES = ['Vidi', 'Marcus (AI)', 'Livia (AI)'];
let seats = [{ name: 'Vidi', controller: 'human', general: 'random' }, { name: 'Marcus (AI)', controller: 'ai', general: 'random' }];
let startMode = 'random', playWhere = 'local', advOpen = false;
let seed = 'g' + Math.floor(Math.random() * 1e6);
const engineSeats = () => seats.map(x => ({ name: x.name.trim(), controller: x.controller, general: x.general }));
const autosaveText = () => { try { return localStorage.getItem('imperator.autosave'); } catch { return null; } };
function renderStart() {
  document.body.dataset.screen = 'setup'; $('#app').hidden = true; const el = $('#start'); el.hidden = false; closeSheet(true);
  const gen = x => (x.general === 'random' ? null : data.generalsById[x.general]);
  const seatRow = (x, i) => { const g = gen(x);
    return `<div class="seat" data-seat="${i}" style="--c:var(--p${i + 1})"><button class="gc${g ? '' : ' rnd'}" data-gen="${i}" ${g ? `style="background-image:url('${attr(img('general.' + g.id))}')"` : ''} aria-label="Choose seat ${i + 1}'s general">${g ? '' : '?'}</button>
      <div class="t"><input name="name${i}" value="${attr(x.name)}" aria-label="Seat ${i + 1} name" autocomplete="off"><span class="gpick" data-gen="${i}">${g ? `${esc(g.name)} · ${esc(G.generalCaption(data, g.id))}` : 'Random free general'} ▾</span></div>
      <button class="ctl" data-ctl="${i}" aria-label="Seat ${i + 1}: played by">${x.controller === 'ai' ? '🤖 AI' : '👤 Human'} ▾</button></div>`; };
  const online = playWhere !== 'local';
  const r = checkSetup(data, engineSeats(), startMode); const errs = r.ok ? '' : r.errors.map(e => (e.seat !== null ? `Seat ${e.seat + 1}: ` : '') + e.message).join('\n');
  const auto = autosaveText(); let autoInfo = '';
  try { const o = auto && JSON.parse(auto); if (o?.snapshot) autoInfo = ` (turn ${o.snapshot.turn?.number ?? 0})`; } catch { /* */ }
  el.innerHTML = `<div class="hero"><span class="ver" id="mVer">${esc(C.uiLabel.split(' · ')[0])} · mobile</span><h1>IMPERATOR</h1><p>2 or 3 players · win with ${data.rules.winPrestige} Prestige</p></div>
  <div class="form">
    <div class="seg" role="group" aria-label="Where the players are">${[['local', '📱 This phone'], ['host', '🌐 Host'], ['join', '🔗 Join']].map(([k, t]) => `<button data-where="${k}" class="${playWhere === k ? 'on' : ''}" aria-pressed="${playWhere === k}">${t}</button>`).join('')}</div>
    ${online ? `<div class="grp" id="onlineSoon"><h3>${playWhere === 'host' ? 'Host an online game' : 'Join an online game'}</h3><p class="note" style="margin:0">${playWhere === 'host' ? 'Hosting from a phone comes after v30.4. For now, host on a computer or an iPad, and join from this phone.' : 'Joining from a phone comes in v30.3 (soon). For now, open the join link on a computer or an iPad, or use “Use desktop view” below.'}</p></div>` : ''}
    <div class="grp" id="seatsGrp"><h3>Players <span class="seg" style="padding:2px;border-radius:11px">${[2, 3].map(n => `<button data-n="${n}" class="${seats.length === n ? 'on' : ''}" style="min-width:52px" aria-pressed="${seats.length === n}">${n}</button>`).join('')}</span></h3>
      ${seats.map(seatRow).join('')}</div>
    <div class="grp"><h3>Start provinces</h3><div class="seg" id="startSeg">${[['random', '🎲 Random'], ['selected', '🗺 Pick in the game']].map(([k, t]) => `<button data-mode="${k}" class="${startMode === k ? 'on' : ''}" aria-pressed="${startMode === k}">${t}</button>`).join('')}</div>
      ${startMode === 'selected' ? `<p class="note" style="margin:6px 2px 0">The game starts with a roll-off for turn order; then each player picks a start on the map, the last to move first.${seats.length === 2 && data.rules.twoPlayerSides ? ' With 2 players, the first to pick chooses West or East (4.g).' : ''}</p>` : ''}</div>
    <div class="grp"><h3>The decks</h3><div class="decks">${G.deckCatalog(data).map(d => `<button data-deck="${d.key}" style="background-image:url('${attr(img('deck.' + d.key))}')" aria-label="${attr(d.title)}: see every card"></button>`).join('')}<span>Tap a deck to see every card in it.</span></div></div>
    <div class="grp" style="padding:0 9px"><button class="adv" id="mAdv" aria-expanded="${advOpen}">Advanced: seed, AI speed, sound <span>${advOpen ? '▾' : '▸'}</span></button>
      ${advOpen ? `<div style="padding:0 2px 10px"><label class="fld">Seed (the same seed and setup give the same game)<input type="text" id="mSeed" value="${attr(seed)}" autocomplete="off"></label>
        <label class="fld">AI and animation speed<select id="mSpeed">${[['1.6', 'slow'], ['1', 'normal'], ['0.35', 'fast'], ['0.05', 'instant']].map(([v, t]) => `<option value="${v}" ${String(C.speed) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <div class="seg" style="margin-top:8px"><button id="mSound" class="${SND.isOn() ? 'on' : ''}" aria-pressed="${SND.isOn()}">${SND.isOn() ? '🔊 Sound on' : '🔇 Sound off'}</button></div></div>` : ''}</div>
    <div class="serr" id="mErr">${esc(errs)}</div>
    ${viewLinks()}
  </div>
  <div class="sfoot"><button class="btn gold big" id="mStart" ${r.ok && !online ? '' : 'disabled'}>Start game ▶</button><div class="row"><button class="btn wide" id="mResume" ${auto ? '' : 'disabled'}>↺ Resume${esc(autoInfo)}</button><button class="btn wide" id="mLoad">📂 Load…</button></div></div>`;
  $$('[data-where]', el).forEach(b => b.onclick = () => { playWhere = b.dataset.where; SND.play('button_click'); renderStart(); });
  $$('[data-n]', el).forEach(b => b.onclick = () => { const n = +b.dataset.n; while (seats.length < n) seats.push({ name: SEAT_NAMES[seats.length], controller: 'ai', general: 'random' }); seats.length = n; renderStart(); });
  $$('[data-ctl]', el).forEach(b => b.onclick = () => { const x = seats[+b.dataset.ctl]; x.controller = x.controller === 'ai' ? 'human' : 'ai'; SND.play('button_click'); renderStart(); });
  $$('input[name^=name]', el).forEach(inp => inp.oninput = () => { seats[+inp.name.slice(4)].name = inp.value; const rr = checkSetup(data, engineSeats(), startMode); $('#mErr').textContent = rr.ok ? '' : rr.errors.map(e => (e.seat !== null ? `Seat ${e.seat + 1}: ` : '') + e.message).join('\n'); $('#mStart').disabled = !rr.ok || playWhere !== 'local'; });
  $$('[data-gen]', el).forEach(b => b.onclick = () => openGeneralPick(+b.dataset.gen));
  $$('[data-mode]', el).forEach(b => b.onclick = () => { startMode = b.dataset.mode; renderStart(); });
  $$('[data-deck]', el).forEach(b => b.onclick = () => openDeck(b.dataset.deck));
  $('#mAdv').onclick = () => { advOpen = !advOpen; renderStart(); };
  const sd = $('#mSeed'); if (sd) sd.oninput = () => { seed = sd.value; };
  const spx = $('#mSpeed'); if (spx) spx.onchange = () => { C.speed = Number(spx.value) || 1; try { localStorage.setItem('imperator.speed', String(C.speed)); } catch { /* */ } };
  const so = $('#mSound'); if (so) so.onclick = () => { SND.toggle(); renderStart(); };
  $('#mStart').onclick = startGame;
  $('#mResume').onclick = () => { const t = autosaveText(); if (t) loadFrom(t); };
  $('#mLoad').onclick = () => $('#importFile').click();
  wireViewLinks(el);
}
function openGeneralPick(i) {
  const takenBy = id => seats.findIndex((y, j) => j !== i && y.general === id);
  openSheet('general', `<div class="sh-head"><span class="sw" style="--c:var(--p${i + 1});width:16px;height:16px"></span><h2>${esc(seats[i].name || 'Seat ' + (i + 1))}'s general<small>Tap a card to choose it, or Random (a free one is dealt at the start)</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body"><div class="genlist"><button class="genopt${seats[i].general === 'random' ? ' on' : ''}" data-g="random"><span style="font-size:44px;line-height:1.6">🎲</span><b>Random</b><small>a free general</small></button>
    ${data.generals.map(g => { const by = takenBy(g.id); return `<button class="genopt${seats[i].general === g.id ? ' on' : ''}" data-g="${g.id}" ${by >= 0 ? 'disabled' : ''}><img src="${attr(img('general.' + g.id))}" alt=""><b>${esc(g.name)}</b><small>${by >= 0 ? `taken by ${esc(seats[by].name)}` : esc(G.generalCaption(data, g.id))}</small></button>`; }).join('')}</div>
    <p class="note">Every perk in detail: tap a player's card during the game.</p></div>`);
  $$('#sheet [data-g]').forEach(b => b.onclick = () => { seats[i].general = b.dataset.g; SND.play('card_flip'); closeSheet(true); renderStart(); });
}
function openDeck(key) {
  const d = G.deckCatalog(data).find(x => x.key === key);
  openSheet('deck', `<div class="sh-head"><h2>${esc(d.title)}<small>${d.total} cards · what the deck holds (never the order)</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">${d.cards.map(c => `<div class="cardrow"><img src="${attr(img(c.art))}" alt=""><div class="t"><b>${esc(c.name)} ×${c.copies}</b>${c.battle ? `<span class="pchip" style="min-height:22px;font-size:11px">${G.BATTLE_LABEL}</span> ` : ''}${esc(c.text)}</div></div>`).join('')}</div>`);
}
function startGame() {
  const r = checkSetup(data, engineSeats(), startMode); if (!r.ok) { SND.play('error_denied'); renderStart(); return; }
  try { C.S = G.newSession(data, { seed: (seed.trim() || 'game'), mode: startMode, seats: engineSeats() }); }
  catch (e) { $('#mErr').textContent = e.message; return; }
  SND.play('deck_shuffle'); enterGame(true);
}
function loadFrom(text) {
  let ns; try { ns = G.readSave(text, data); } catch (e) { if (document.body.dataset.screen === 'setup') $('#mErr').textContent = e.message; else toast(e.message); return false; }
  clearTimeout(C.aiTimer); C.S = ns; enterGame(false); toast('Game loaded'); return true;
}
function enterGame(fresh) {
  document.body.dataset.screen = 'game'; $('#start').hidden = true; $('#app').hidden = false; closeSheet(true);
  C.viewer = null; C.aiPaused = false; C.busy = false; selected = null; overShown = false; lastRoll = null; askSeen = null;
  if (popKind) closePop(); $('#cardPlays').innerHTML = ''; battleOff = null;   // nothing of the last game stays on screen
  requestAnimationFrame(() => { MV.start(0.45, 0.5); });
  $('#maphint').hidden = !fresh; if (fresh) setTimeout(() => { $('#maphint').hidden = true; }, 4000);
  autosave(); render(); schedule();
}
function toStart() { clearTimeout(C.aiTimer); C.S = null; renderStart(); }

// ------------------------------------------------------------------ the game screen
let selected = null, overShown = false, lastRoll = null, askSeen = null;
function render() {
  if (!C.S || document.body.dataset.screen !== 'game') return;
  const s = st();
  C.viewer = G.viewerFor(s, C.viewer);
  const legal = mineNow();
  document.body.dataset.whoActs = whoActs(s) ?? '';
  document.body.dataset.frame = topFrame(s)?.kind ?? (s.phase === 'turn' ? 'free' : s.phase);
  document.body.dataset.viewer = C.viewer ?? '';
  document.body.dataset.humanTurn = legal.length ? '1' : '';
  $('#topInfo').textContent = `${s.phase === 'setup' ? 'Setup' : s.phase === 'finished' ? 'Game over' : `Turn ${s.turn.number}`} · ${C.uiLabel.split(' · ')[0]}`;
  $('#dieVal').textContent = lastRoll ? lastRoll.value : '–';
  renderPlayers(s); renderSteps(s, legal); renderTokens(s, legal); renderActs(s, legal); renderLogPeek(s);
  if (sheetKind === 'ask' && (!topFrame(s) || !legal.length || document.body.dataset.askFrame !== topFrame(s).id || s.battle)) closeSheet(true);
  if (['assassin', 'cardTargets', 'ally'].includes(sheetKind) && (!legal.length || topFrame(s))) closeSheet(true);
  if (sheetKind === 'province' && selected) openProvince(selected, true);
  else if (sheetKind === 'log') openLog(true);
  else if (sheetKind === 'player' && $('#genSheet')) openPlayer($('#genSheet').dataset.pid, true);
  // v30.1: the battle sheet is open while a battle runs (its prompts live inside it); ▾ hides it until the gold button or the next battle
  if (s.battle && !popDone && popKind !== 'battle' && battleOff !== s.battle.id && !C.hostHidden()) { if (sheetKind === 'ask') closeSheet(true); openBattle(); }
  else if (popKind === 'battle' && !popDone) { if (!s.battle) { closePop(); bv = null; } else renderBattleCtl(); }
  renderDrawCall(s);
  autoAsk(s, legal);
  if (!C.busy && C.viewer && news[C.viewer]?.length) setTimeout(showNews, 0);
}
function renderPlayers(s) {
  const act = s.phase === 'turn' ? s.turn.activePlayerId : whoActs(s);
  $('#players').classList.toggle('n2', s.players.length === 2);
  $('#players').innerHTML = s.players.map(p => { const g = p.general ? data.generalsById[p.general.id] : null; const on = p.id === act;
    return `<button class="pl${on ? ' active' : ''}${p.out ? ' out' : ''}" style="--c:var(--${col(p.id)})" data-pid="${p.id}" aria-label="${attr(p.name)}${g ? ', ' + attr(g.name) : ''}: open the General">
    <span class="tag ${on ? '' : p.controller === 'ai' ? 'ai' : ''}" ${!on && p.controller !== 'ai' ? 'hidden' : ''}>${on ? '▶ TURN' : 'AI'}</span>
    <span class="r1"><span class="av" style="background-image:url('${attr(img(g ? 'general.' + g.id : 'back.game'))}');background-position:center 15%"></span><span class="nm">${esc(p.name)}<small>${esc(g?.name ?? 'no general yet')}</small>${g ? `<small class="cap" data-caption="${g.id}">${esc(G.generalCaption(data, g.id))}</small>` : ''}</span></span>
    <span class="r2"><span title="Gold">💰${p.gold}</span><span title="Prestige">⭐${p.prestige}<small style="color:var(--muted)">/${data.rules.winPrestige}</small></span><span title="Cards">🂠${G.handCount(p)}</span><span title="Troops">⚔${totalTroops(s, p.id)}</span></span>
    <span class="pbar"><b style="width:${Math.min(100, p.prestige / data.rules.winPrestige * 100)}%"></b></span></button>`; }).join('');
  $$('#players .pl').forEach(b => b.onclick = () => openPlayer(b.dataset.pid));
}
function renderSteps(s, legal) {
  const act = s.phase === 'turn' ? s.turn.activePlayerId : whoActs(s); const si = G.stepIndex(s);
  const el = $('#steps'); el.style.setProperty('--pc', `var(--${col(act)})`);
  const names = { resources: 'Resources', gameRoll: 'Game', revoltRoll: 'Revolt', actions: 'Actions' };
  el.innerHTML = s.phase === 'setup' ? '<span class="step cur"><i>0</i>Setup</span>' : s.phase === 'finished' ? `<span class="step cur"><i>★</i>${esc(pn(s.winner))} wins</span>`
    : G.STEP_CHIPS.map(([k], i) => `<span class="step ${i < si ? 'done' : i === si ? 'cur' : ''}"><i>${i < si ? '✓' : i + 1}</i>${names[k]}${k === 'actions' && i === si ? ` ${s.turn.actionsUsed}/2` : ''}</span>`).join('<span class="step-sep">›</span>');
  const f = topFrame(s); const w = whoActs(s); let p;
  if (s.phase === 'finished') p = `<b>${esc(pn(s.winner))} wins the game.</b> Menu → New game to play again.`;
  else if (!legal.length) p = G.isHuman(s, w) ? `Waiting for <b>${esc(pn(w))}</b>…` : `<b>${esc(pn(w))}</b> (AI) is thinking…${C.aiPaused ? ' (AI paused: Menu → Resume AI)' : ''}`;
  else if (!f) p = `<b>Your turn, ${esc(pn(w))}.</b> Attack, Ally or Move, buy or build, play a card, or tap a province.`;
  else p = `<b>${esc(pn(w))}: ${esc(G.frameTitle(s, data))}.</b> ${esc(G.describePrompt(s, data).replace(/^.*?: /, ''))}`;
  $('#prompt').innerHTML = p;
  const h = G.handFor(s, data, C.viewer);
  $('#handmini').innerHTML = h.owner && h.cards.length ? `<span>Hand</span>${h.cards.slice(0, 4).map(c => `<button data-card="${c.uid}" style="background-image:url('${attr(img(c.art))}')" aria-label="${attr(c.name)}"></button>`).join('')}` : '';
  $$('#handmini [data-card]').forEach(b => b.onclick = () => openCards());
}
const pickFrames = ['chooseProvince', 'setupStartProvince', 'placeTroops', 'resourceBuild', 'placeSurvivors'];
function pickSet(s, legal) {
  const f = topFrame(s);
  if (!f || !(pickFrames.includes(f.kind) || (f.kind === 'responseWindow' && f.window === 'defenceAnnounced'))) return new Set();
  return new Set(legal.map(G.mainProvince).filter(Boolean));
}
function renderTokens(s, legal) {
  const sp = data.map.map.tokenSpace; const picks = pickSet(s, legal); const gensAt = {};
  for (const pl of s.players) if (pl.general?.at && !pl.out) gensAt[pl.general.at] = pl.general.id;
  $('#tokens').innerHTML = data.provinces.map(def => {
    const id = def.id, p = s.provinces[id]; let cls = 'tok', val;
    if (id === 'roma' && !p.owner) { cls += ' roma'; val = p.troops; }
    else if (!p.owner) { cls += ' nat'; val = p.native.present ?? '?'; }
    else { val = p.troops; if (p.status === 'allied') cls += ' ally'; if (isUnderGarrisoned(s, data, id)) cls += ' low'; }
    if (selected === id) cls += ' sel'; if (picks.has(id)) cls += ' pick';
    const nat = p.owner && id !== 'roma' && p.native?.count ? p.native.count : 0;
    const g = gensAt[id];
    return `<button class="${cls}" data-id="${id}" style="left:${def.token.x / sp.w * 100}%;top:${def.token.y / sp.h * 100}%;${p.owner ? `--c:var(--${col(p.owner)})` : ''}" aria-label="${attr(def.name)}">${val}${p.number ? `<span class="nn">${p.number}</span>` : ''}${nat ? `<span class="natb">${nat}</span>` : ''}${g ? `<span class="gen" style="background-image:url('${attr(img('general.' + g))}');background-position:center 15%"></span>` : ''}${p.walls?.length ? '<span class="wall">🧱</span>' : ''}${p.road ? '<span class="rd">🛣</span>' : ''}<span class="lbl">${esc(def.name)}${p.status === 'allied' ? ' · ally' : ''}</span></button>`;
  }).join('');
  $$('#tokens .tok').forEach(t => t.onclick = () => tokenTap(t.dataset.id));
}
function tokenTap(id) {
  SND.play('province_select'); selected = id; openProvince(id);
  $$('#tokens .tok').forEach(t => t.classList.toggle('sel', t.dataset.id === id));
}
// ------------------------------------------------------------------ the thumb bar: every enabled button opens or plays legal moves only
const ICON = { ATTACK: '⚔', ALLY: '🤝', MOVE: '➜', BUY_TROOP: '🛒', BUY_GAME_CARD: '🂠', BUY_CATAPULT: '🏹', BUILD_ROAD: '🛣', BUILD_WALL: '🧱', USE_SAVED_RESOURCE: '🏛', PLAY_CARD: '🂠', PREVIEW_TARGET: '🔎', END_TURN: '✓', SELL_CARD: '💰', MOVE_GENERAL: '⚑', ROLL: '🎲', DRAW_CARD: '🂠' };
const TITLES = { ATTACK: 'Attack', ALLY: 'Ally', MOVE: 'Move troops' };
function barModel(s, legal) {
  const f = topFrame(s); const c = G.categorize(legal); const free = !f && s.phase === 'turn' && legal.length > 0;
  const rolls = legal.filter(d => d.type === 'ROLL'), draws = legal.filter(d => d.type === 'DRAW_CARD');
  const h = G.handFor(s, data, C.viewer); const more = [...c.scout, ...c.general, ...c.sell, ...c.other];
  const mv = t => ({ k: t.toLowerCase(), ic: ICON[t], t: { ATTACK: 'Attack', ALLY: 'Ally', MOVE: 'Move' }[t], on: free && c.move.some(d => d.type === t), go: () => openMoves(t) });
  let gold;
  if (s.battle && (legal.length || popKind !== 'battle')) gold = { k: 'battle', ic: '⚔', t: rolls.length ? 'Roll' : legal.length ? 'Answer' : 'Battle', on: true, due: legal.length > 0, go: () => { battleOff = null; openBattle(); } };
  else if (rolls.length) gold = { k: 'roll', ic: '🎲', t: rolls.length === 1 ? 'Roll' : 'Roll…', on: !C.busy, due: true, go: () => (rolls.length === 1 ? act(rolls[0]) : openList('Roll', rolls)) };
  else if (draws.length) gold = { k: 'draw', ic: '🂠', t: 'Draw', on: !C.busy, due: true, go: () => (draws.length === 1 ? act(draws[0]) : openList('Draw a card', draws)) };
  else if (f && legal.length) gold = { k: 'answer', ic: '❗', t: 'Answer', on: true, due: true, go: () => openAsk() };
  else gold = { k: 'end', ic: '✓', t: 'End turn', on: free && c.end.length > 0, go: () => act(c.end[0]) };
  return [mv('ATTACK'), mv('ALLY'), mv('MOVE'),
    { k: 'buy', ic: '🛒', t: 'Buy', on: free && c.buy.length > 0, go: () => openList('Buy', c.buy, 'One troop per turn from the bank; a Game Card from the deck.') },
    { k: 'build', ic: '🏛', t: 'Build', on: free && c.build.length > 0, go: () => openList('Build', c.build, 'Roads, Walls and the Catapult; a saved Road or Wall card builds for free.') },
    { k: 'cards', ic: '🂠', t: 'Cards', on: !!h.owner, badge: h.cards.length, go: () => openCards() },
    { k: 'more', ic: '⋯', t: 'More', on: free && more.length > 0, go: () => openList('More actions', more) },
    gold];
}
let bar = [];
function renderActs(s, legal) {
  bar = barModel(s, legal);
  $('#acts').innerHTML = bar.map((b, i) => `<button class="act${i === 7 ? ' gold' : ''}${b.due ? ' due' : ''}" id="act-${b.k}" data-i="${i}" ${b.on && !C.busy ? '' : 'disabled'} aria-label="${attr(b.t)}"><span class="ic">${b.ic}</span>${esc(b.t)}${b.badge ? `<span class="badge">${b.badge}</span>` : ''}</button>`).join('');
  $$('#acts .act').forEach(el => el.onclick = () => { const b = bar[+el.dataset.i]; if (!b?.on || C.busy) { SND.play('error_denied'); return; } SND.play('button_click'); b.go(); });
}
function freezeControls() { $$('#acts .act, #sheet .arow, #sheet .btn.gold, #pop #bCtl .btn, #pop .bccheck, #pop .arow, #gvActs .gvbtn').forEach(b => { b.disabled = true; }); }
function renderLogPeek(s) {
  const l = G.logFor(s, data, 1, C.viewer)[0];
  $('#logLast').innerHTML = l ? `<span class="sw" style="--c:${l.cls === 'sys' ? 'var(--muted)' : `var(--${l.cls})`};margin-right:6px"></span>${esc(l.text)}` : 'The game log';
}

// ------------------------------------------------------------------ bottom sheets
let sheetKind = null, sheetSticky = false;
function openSheet(kind, html, { half = false, side = false, sticky = false } = {}) {
  const sh = $('#sheet'); sheetKind = kind; sheetSticky = sticky;
  sh.className = 'sheet' + (half ? ' half' : '') + (side ? ' side' : ''); sh.dataset.kind = kind;
  sh.innerHTML = '<div class="handle"><i></i></div>' + html;
  $('#scrim').classList.toggle('light', half); $('#scrim').classList.add('on');
  requestAnimationFrame(() => sh.classList.add('on'));
  $$('[data-close]', sh).forEach(b => b.onclick = () => closeSheet());
  document.body.dataset.sheet = kind;
}
function closeSheet(quiet = false) {
  const was = sheetKind; sheetKind = null; sheetSticky = false;
  $('#sheet').classList.remove('on'); $('#scrim').classList.remove('on', 'light'); document.body.dataset.sheet = '';
  if (was === 'province') { selected = null; $$('#tokens .tok.sel').forEach(t => t.classList.remove('sel')); }
  if (!quiet && was && closeHook) { const h = closeHook; closeHook = null; h(); }
}
let closeHook = null;
/** One row per legal descriptor (with a − / + stepper for a number), each a real engine move. */
function rowsHtml(list, off = false) {
  return `<div class="alist">${list.map((d, i) => {
    const def = d.action.cardUid ? st().cards[d.action.cardUid]?.def : null;
    const label = d.range ? d.label.replace(/\s*\(\d+-\d+\)$/, '') : d.label;
    return `<div class="rowwrap" data-i="${i}"><button class="arow" data-i="${i}"${off ? ' disabled' : ''}><span class="ic">${def ? `<img src="${attr(img('card.' + def))}" alt="" style="width:26px;border-radius:3px">` : ICON[d.type] ?? '•'}</span><span class="t"><b>${esc(label)}</b>${d.range ? `<small>${esc(d.range.field)}: <span class="rv">${d.range.max}</span> (${d.range.min}–${d.range.max})</small>` : ''}</span><span class="go">›</span></button>
      ${d.range && d.range.max > d.range.min && !off ? `<div class="stepper" data-i="${i}"><button data-d="-1" aria-label="Fewer">−</button><b class="rv">${d.range.max}</b><button data-d="1" aria-label="More">＋</button></div>` : ''}</div>`;
  }).join('')}</div>`;
}
function wireRows(root, list) {
  const val = {}; list.forEach((d, i) => { if (d.range) val[i] = d.range.max; });
  $$('.stepper', root).forEach(sp => { const i = +sp.dataset.i; const d = list[i];
    $$('[data-d]', sp).forEach(b => b.onclick = () => { val[i] = Math.max(d.range.min, Math.min(d.range.max, val[i] + +b.dataset.d)); $$(`.rowwrap[data-i="${i}"] .rv`, root).forEach(x => { x.textContent = val[i]; }); }); });
  $$('.arow[data-i]', root).forEach(b => b.onclick = () => { const i = +b.dataset.i; const d = list[i]; if (!d || C.busy) return;
    if (d.type === 'ALLY' && sheetKind === 'moves') { openAllyConfirm(d); return; }   // v30.1: the Ally confirm sheet (natives, troops needed)
    if (root.id === 'sheet' || root.closest?.('#sheet')) closeSheet(true); act(d.range ? { ...d, _v: val[i] } : d); });
}
function openList(title, list, note = '') {
  openSheet('list', `<div class="sh-head"><h2>${esc(title)}<small>${list.length} possible now · each costs an action unless it says free</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">${rowsHtml(list)}${note ? `<p class="note">${esc(note)}</p>` : ''}</div>`);
  wireRows($('#sheet'), list);
}
/** Attack / Ally / Move: from where, then to where, then how (the engine's builder tree: only legal origins and targets). */
function openMoves(type, from = null) {
  const tree = G.builderTree(mineNow(), type);
  if (!from) {
    const origins = Object.keys(tree);
    if (origins.length === 1) { openMoves(type, origins[0]); return; }
    openSheet('moves', `<div class="sh-head"><h2>${TITLES[type]}: from where?<small>Tap a province here or on the map</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
      <div class="sh-body"><div class="alist">${origins.map(o => `<button class="arow" data-from="${o}"><span class="ic"><span class="sw" style="--c:${cvar(st().provinces[o].owner)};width:16px;height:16px"></span></span><span class="t"><b>${esc(prov(o))}</b><small>${st().provinces[o].troops} troops · to ${Object.keys(tree[o]).map(prov).map(esc).join(', ')}</small></span><span class="go">›</span></button>`).join('')}</div></div>`, { half: true });
    $$('#sheet [data-from]').forEach(b => b.onclick = () => openMoves(type, b.dataset.from));
    return;
  }
  const list = Object.values(tree[from] ?? {}).flat();
  openSheet('moves', `<div class="sh-head"><h2>${TITLES[type]} from ${esc(prov(from))}<small>${list.length} possible · the engine's legal moves only</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">${rowsHtml(list)}</div>`, { half: true });
  wireRows($('#sheet'), list);
}
function openCards() {
  const s = st(); const h = G.handFor(s, data, C.viewer); const legal = mineNow();
  const p = h.owner ? G.playerById(s, h.owner) : null;
  const row = (c, tag = '') => {
    const pv = G.cardPlayView(s, data, legal, c.uid); const sell = legal.find(d => d.type === 'SELL_CARD' && d.action.cardUid === c.uid);
    const plays = legal.filter(d => (d.type === 'PLAY_CARD' || d.type === 'USE_SAVED_RESOURCE') && d.action.cardUid === c.uid);
    const why = !plays.length ? (G.cardBlockReason(s, data, h.owner, c.uid) ?? (c.battle ? 'A Battle Card: commit it in a battle (18.i).' : pv.reason ?? 'Not playable now.')) : '';
    return `<div class="cardrow" data-uid="${c.uid}"><img src="${attr(img(c.art))}" alt=""><div class="t"><b>${tag}${esc(c.name)}</b>${esc(c.text)}${why ? `<div class="note" style="margin-top:4px">${esc(why)}</div>` : ''}
      <div class="btns">${plays.length ? `<button class="btn gold" data-play="${c.uid}">${plays.length === 1 ? 'Play it' : `Play: choose (${plays.length})`}</button>` : ''}${sell ? `<button class="btn" data-sell="${c.uid}">Sell +${data.rules.sellCard?.gold ?? 2} Gold</button>` : ''}</div></div></div>`;
  };
  openSheet('cards', `<div class="sh-head"><h2>${p ? `${esc(p.name)}'s hand` : 'Hands'}<small>${p ? `Only ${esc(p.name)} may look · ${h.cards.length} card(s)` : 'AI hands are always hidden'}</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">${h.cards.length ? h.cards.map(c => row(c)).join('') : '<p class="note">No cards in hand.</p>'}${h.saved.map(c => row(c, 'saved: ')).join('')}${h.inPlay.map(c => row(c, 'in play: ')).join('')}
    <p class="note">${s.players.filter(x => x.id !== h.owner).map(x => `${esc(x.name)}: ${G.handCount(x)} card(s), hidden`).join(' · ')}</p></div>`);
  $$('#sheet [data-play]').forEach(b => b.onclick = () => { const uid = b.dataset.play; const ds = mineNow().filter(d => (d.type === 'PLAY_CARD' || d.type === 'USE_SAVED_RESOURCE') && d.action.cardUid === uid); if (ds.length === 1) { closeSheet(true); act(ds[0]); } else openCardTargets(uid, ds); });
  $$('#sheet [data-sell]').forEach(b => b.onclick = () => { const d = mineNow().find(x => x.type === 'SELL_CARD' && x.action.cardUid === b.dataset.sell); if (d) { closeSheet(true); SND.play('gold_gain'); act(d); } });
}
function openProvince(id, refresh = false) {
  const s = st(); const p = s.provinces[id]; const def = data.provincesById[id]; const legal = mineNow();
  const m = G.shownMin(s, data, id); const under = p.owner ? isUnderGarrisoned(s, data, id) : false;
  const here = G.forProvince(legal, id).filter(d => d.type !== 'END_TURN');
  const owner = p.owner ? pn(p.owner) : null;
  const nb = [...def.land.map(x => [x, 'land']), ...def.sea.map(x => [x, 'sea'])];
  const gens = s.players.filter(pl => pl.general?.at === id).map(pl => data.generalsById[pl.general.id].name);
  const html = `<div class="sh-head"><span class="sw" style="--c:${p.owner ? cvar(p.owner) : id === 'roma' ? 'var(--roma)' : 'var(--native)'};width:16px;height:16px"></span><h2>${esc(def.name)}<small>${owner ? `${esc(owner)}'s province` : id === 'roma' ? 'Roma · no holder' : 'Unowned · natives'} · number ${p.number ?? '–'} · reward ${esc(p.reward ?? '–')}</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body" id="provBody" data-id="${id}">
      <div class="stats"><div class="stat"><small>Troops</small><b>${p.owner || id === 'roma' ? p.troops : '–'}</b></div><div class="stat"><small>Natives</small><b>${p.native.count === null ? (id === 'roma' ? '–' : '?') : `${p.native.present}/${p.native.count}`}</b></div><div class="stat"><small>Min garrison</small><b class="${under ? 'warn' : 'ok'}">${m ? m.min : '–'}${p.owner ? (under ? ' ✗' : ' ✓') : ''}</b></div></div>
      <div class="chips" style="margin-bottom:4px"><span class="pchip">🧱 ${p.walls?.length ? 'Wall facing ' + p.walls.map(prov).map(esc).join(', ') : 'No wall'}</span><span class="pchip">🛣 ${p.road ? 'Road' : 'No road'}</span><span class="pchip">⚑ ${gens.length ? esc(gens.join(', ')) + ' here' : 'No general'}</span><span class="pchip">${esc(p.status)}</span></div>
      <div class="sec">Borders (⚓ by sea)</div>
      <div class="chips">${nb.map(([x, k]) => { const o = s.provinces[x].owner; return `<span class="pchip"><span class="sw" style="--c:${o ? cvar(o) : x === 'roma' ? 'var(--roma)' : 'var(--native)'}"></span>${esc(prov(x))}${k === 'sea' ? ' ⚓' : ''}</span>`; }).join('')}</div>
      <div class="sec">${here.length ? `What you can do here (${here.length})` : 'Nothing to do here right now'}</div>
      ${here.length ? rowsHtml(here) : `<p class="note">${legal.length ? 'Your possible moves are on the action bar.' : C.busy ? 'Wait a moment…' : 'It is not your move.'}</p>`}
    </div>`;
  if (refresh && sheetKind === 'province') { $('#sheet').innerHTML = '<div class="handle"><i></i></div>' + html; $$('#sheet [data-close]').forEach(b => b.onclick = () => closeSheet()); }
  else openSheet('province', html, { half: true });
  wireRows($('#sheet'), here);
  const [fx, fy] = [def.token.x / data.map.map.tokenSpace.w, def.token.y / data.map.map.tokenSpace.h];
  if (!refresh) requestAnimationFrame(() => MV.reveal(fx, fy, matchMedia('(orientation: portrait)').matches ? $('#sheet').offsetHeight - $('#acts').offsetHeight - 50 : 0));
}
/** The generic prompt sheet: every frame without a sheet of its own (setup choices, battle cards, perks, responses, placements...)
 *  lists its legal moves, so a prompt can never leave the phone stuck. Map-pick frames open it half-height: tap a row or the map. */
function openAsk(auto = false) {
  const s = st(); const f = topFrame(s); const legal = mineNow(); if (!f || !legal.length) return;
  if (s.battle) { battleOff = null; openBattle(); return; }   // v30.1: a battle's prompts are answered inside the battle sheet
  const half = pickFrames.includes(f.kind); const g = gateFor(whoActs(s));
  const kind = f.kind === 'responseWindow' ? f.window : f.kind;
  openSheet('ask', `<div class="sh-head"><h2>${esc(G.frameTitle(s, data))}<small>${esc(pn(whoActs(s)))} · ${esc(G.describePrompt(s, data).replace(/^.*?: /, ''))}</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Hide for now">✕</button></div>
    <div class="sh-body" id="askBody" data-ask="${attr(kind)}">${gateNote(g)}${askBody(s, f, legal, g)}${half ? '<p class="note">You can also tap a glowing province on the map.</p>' : ''}<p class="note">Hidden for now? The gold “Answer” button opens this again.</p></div>`, { half });
  wireRows($('#sheet'), legal);
  $$('#sheet [data-ai]').forEach(b => b.onclick = () => { closeSheet(true); act(legal[+b.dataset.ai]); });
  $$('#sheet [data-ak]').forEach(b => b.onclick = () => { const d = legal.find(x => G.descKey(x) === b.dataset.ak); if (d) { closeSheet(true); act(d); } });
  document.body.dataset.askFrame = f.id;
}
function autoAsk(s, legal) {
  const f = topFrame(s);
  if (!f || !legal.length || C.busy || s.battle || popKind || ['roll', 'draw'].includes(f.kind)) return;
  const key = f.id + '|' + C.viewer; if (askSeen === key) return; askSeen = key;
  if (!sheetKind || sheetKind === 'ask') setTimeout(() => { if (topFrame(st())?.id === f.id && !C.busy) openAsk(true); }, 0);
}
function openLog(refresh = false) {
  const lines = G.logFor(st(), data, 150, C.viewer);
  const html = `<div class="sh-head"><h2>Game log<small>newest first · what everyone may see</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body"><ul class="loglist" id="log">${lines.map(l => `<li class="${l.cls}"><span class="sw" style="--c:${l.cls === 'sys' ? 'var(--muted)' : `var(--${l.cls})`}"></span><span>${esc(l.text)}${l.rule ? ` <small style="width:auto">${esc(l.rule)}</small>` : ''}</span></li>`).join('')}</ul></div>`;
  if (refresh) { const b = $('#sheet .sh-body'); if (b) b.innerHTML = html.slice(html.indexOf('<ul')).replace(/<\/div>$/, ''); return; }
  openSheet('log', html, { side: true });
}
function openMenu() {
  const items = [['save', '💾 Save to a file'], ['load', '📂 Load a file'], ...(C.S && st().phase !== 'finished' ? [['pause', C.aiPaused ? '▶ Resume the AI' : '⏸ Pause the AI']] : []), ['sound', SND.isOn() ? '🔇 Sound off' : '🔊 Sound on'], ['new', '⟲ New game (this game stays in Resume)'], ['desktop', '🖥 Use desktop view'], ['auto', '↺ Automatic view']];
  openSheet('menu', `<div class="sh-head"><h2>Menu<small>${esc(C.uiLabel)}</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body menu"><div class="alist">${items.map(([k, t]) => `<button class="arow" data-m="${k}"><span class="t"><b>${t}</b></span></button>`).join('')}</div><p class="note">The game is saved after every move: switching views or reloading keeps it (Resume).</p></div>`);
  $$('#sheet [data-m]').forEach(b => b.onclick = () => {
    const k = b.dataset.m; closeSheet(true);
    if (k === 'save' && C.S) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(makeSaveNow('file'))], { type: 'application/json' })); a.download = G.saveFileName(st()); document.body.append(a); a.click(); setTimeout(() => a.remove(), 500); toast('Save file exported'); }
    else if (k === 'load') $('#importFile').click();
    else if (k === 'pause') { C.aiPaused = !C.aiPaused; render(); schedule(); }
    else if (k === 'sound') SND.toggle();
    else if (k === 'new') toStart();
    else if (k === 'desktop' || k === 'auto') { autosave(); goView(k); }
  });
}
function displeasedAlert(f) {
  const s = st(); const p = G.playerById(s, f.player); const can = C.displeasedDraw(f);
  SND.play('error_denied');
  return new Promise(res => {
    if (popDone) closePop();
    const el = $('#pop'); popKind = 'displeased'; popSticky = true; el.className = 'sheet pop'; el.dataset.kind = 'displeased'; el.dataset.sticky = '1';
    el.innerHTML = `<div class="handle"><i></i></div>${whoBar(f.player, 'must draw')}<div class="sh-head"><h2>⚠ Rome is displeased<small>${esc(p?.name ?? f.player)} must draw a Rome Is Displeased card</small></h2></div>
      <div class="sh-body"><div class="pophero"><img src="${attr(img('back.displeased'))}" alt=""></div><p class="note" style="text-align:center">${esc(G.displeasedReason(s, data, f.player))}</p></div>
      <div class="sh-foot">${can ? '<button class="btn red wide" id="dispDraw">Draw the card now</button>' : ''}<button class="btn gold wide" id="dispOk">OK, I understand</button></div>`;
    $('#popScrim').classList.add('on'); requestAnimationFrame(() => el.classList.add('on')); document.body.dataset.popup = 'displeased';
    const done = v => { closePop(); res(v); };
    $('#dispOk').onclick = () => done(false); const d = $('#dispDraw'); if (d) d.onclick = () => done(true);
  });
}
function showGameOver() {
  const s = st(); if (s.phase !== 'finished' || overShown) return; overShown = true;
  const w = G.playerById(s, s.winner); SND.play(G.soundsFor({ type: 'gameWon', pub: { player: s.winner } }, s)[0]);
  const rows = [...s.players].sort((a, b) => b.prestige - a.prestige).map(p => `<tr><td><span class="sw" style="--c:var(--${col(p.id)})"></span> ${esc(p.name)}</td><td>${p.prestige}</td><td>${ownedBy(s, p.id).length}</td><td>${totalTroops(s, p.id)}</td><td>${p.gold}</td></tr>`).join('');
  openSheet('over', `<div class="sh-head"><h2>IMPERATOR!<small id="winnerName">${esc(w.name)} wins on turn ${s.turn.number}</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Look at the board">✕</button></div>
    <div class="sh-body over"><table><tr><th>Player</th><th>⭐</th><th>Prov.</th><th>⚔</th><th>💰</th></tr>${rows}</table></div>
    <div class="sh-foot"><button class="btn gold wide" id="ovNew">New game</button><button class="btn wide" data-close>Look at the board</button></div>`);
  document.body.dataset.over = s.winner; $('#ovNew').onclick = () => toStart();
}
/**
 * v30.1: the Assassin as the desktop's step flow (v28 item 4), in a sheet: 1. a province -> 2. how many to kill there -> 3. with 1, the
 * second province -> confirm. Only the engine's legal targets; Back and Cancel on every step; nothing is played until the last button.
 */
function openAssassinFlow(uid, list) {
  const s = st(); const nm = data.cardDefsById.assassin?.name ?? 'Assassin!';
  const acts = list.filter(d => d.action.kills);
  const k = Math.max(...acts.map(d => d.action.kills.reduce((t, x) => t + x.n, 0)));
  const provs = [...new Set(acts.flatMap(d => d.action.kills.map(x => x.province)))];
  const find = kills => acts.find(d => d.action.kills.length === kills.length && kills.every(x => d.action.kills.some(y => y.province === x.province && y.n === x.n)));
  const whose = id => { const p = s.provinces[id]; return p.owner ? `${pn(p.owner)}${p.status === 'allied' ? ' (allied)' : ''}` : 'natives'; };
  const troops = id => { const p = s.provinces[id]; return p.owner ? p.troops : (p.native.present ?? 0); };
  const row = (id, a) => `<button class="arow as-prov" ${a}><span class="ic"><span class="sw" style="--c:${s.provinces[id].owner ? cvar(s.provinces[id].owner) : 'var(--native)'};width:16px;height:16px"></span></span><span class="t"><b>${esc(prov(id))}</b><small>${esc(whose(id))} · ${troops(id)} troops</small></span><span class="go">›</span></button>`;
  let z = { step: 'first', a: null, n: null, b: null };
  const g = gateFor(whoActs(s));
  const draw = () => {
    const { step, a, n, b } = z; let body = '', go = '';
    const of = k === 2 ? 3 : 2;
    if (step === 'first') body = `<p class="note">Step 1 of ${of}: choose a province to strike. ${k === 2 ? 'The Assassin kills 2 troops: 2 in one province, or 1 each in two provinces' : 'The Assassin kills 1 troop (only 1 can be killed now)'}; at least 1 troop always stays (18.e). Only legal targets are shown.</p><div class="alist">${provs.map(id => row(id, `data-as-first="${attr(id)}"`)).join('')}</div>`;
    else if (step === 'count') {
      const opts = [find([{ province: a, n: 2 }]) ? 2 : null, acts.some(d => d.action.kills.length === 2 && d.action.kills.some(x => x.province === a)) ? 1 : null].filter(Boolean);
      body = `<p class="note">Step 2 of 3: how many troops to kill in <b>${esc(prov(a))}</b> (${troops(a)} troops)?</p><div class="alist as-count">${opts.map(m => `<button class="arow" data-as-n="${m}"><span class="ic">🗡</span><span class="t"><b>${m === 2 ? 'Kill 2 here' : 'Kill 1 here'}</b><small>${m === 2 ? 'both kills in this province' : 'then choose a second province'}</small></span><span class="go">›</span></button>`).join('')}</div>`;
    } else if (step === 'second') {
      const partners = provs.filter(id => id !== a && find([{ province: a, n: 1 }, { province: id, n: 1 }]));
      body = `<p class="note">Step 3 of 3: 1 troop dies in <b>${esc(prov(a))}</b>. Choose the province for the second kill.</p><div class="alist">${partners.map(id => row(id, `data-as-second="${attr(id)}"`)).join('')}</div>`;
    } else {
      z.kills = n === 2 || k === 1 ? [{ province: a, n: k === 1 ? 1 : 2 }] : [{ province: a, n: 1 }, { province: b, n: 1 }];
      body = `<p class="as-sum" id="asSum">Kill <b>${z.kills.map(x => `${x.n} in ${esc(prov(x.province))}`).join('</b> and <b>')}</b>.</p><p class="note">The card is spent when you press Play.</p>`;
      go = `<button class="btn gold wide" id="asGo"${g.live ? '' : ' disabled'}>Play ${esc(nm)} ▶</button>`;
    }
    openSheet('assassin', `<div class="sh-head"><img src="${attr(img('card.assassin'))}" alt="" style="width:34px;border-radius:4px"><h2>${esc(nm)}<small>${esc(pn(whoActs(s)))} · choose the targets</small></h2></div>
      <div class="sh-body" id="assassinFlow" data-step="${step}">${gateNote(g)}${body}</div>
      <div class="sh-foot"><button class="btn" id="asBack">◀ Back</button><button class="btn" id="asCancel">Cancel</button>${go}</div>`, { sticky: true });
    $$('#sheet [data-as-first]').forEach(x => x.onclick = () => { SND.play('province_select'); flashToken(x.dataset.asFirst); z = { step: k === 2 ? 'count' : 'confirm', a: x.dataset.asFirst, n: k === 2 ? null : 1, b: null }; draw(); });
    $$('#sheet [data-as-n]').forEach(x => x.onclick = () => { SND.play('province_select'); z = { ...z, n: +x.dataset.asN, step: +x.dataset.asN === 2 ? 'confirm' : 'second' }; draw(); });
    $$('#sheet [data-as-second]').forEach(x => x.onclick = () => { SND.play('province_select'); flashToken(x.dataset.asSecond); z = { ...z, b: x.dataset.asSecond, step: 'confirm' }; draw(); });
    $('#asCancel').onclick = () => closeSheet();
    $('#asBack').onclick = () => {
      if (z.step === 'first') { openCards(); return; }
      if (z.step === 'count') z = { step: 'first', a: null, n: null, b: null };
      else if (z.step === 'second') z = { ...z, step: 'count', n: null };
      else z = k === 1 ? { step: 'first', a: null, n: null, b: null } : z.n === 2 ? { ...z, step: 'count', n: null } : { ...z, step: 'second', b: null };
      draw();
    };
    const gb = $('#asGo'); if (gb) gb.onclick = () => { const d = find(z.kills); if (!d) return; closeSheet(true); act(d); };
  };
  draw();
}
/** v30.1: a card with several targets (Revolt!, Bribe the Ally!, ...): pick one row, then the gold Play button. */
function openCardTargets(uid, list) {
  const s = st(); const def = s.cards[uid].def;
  if (def === 'assassin' && list.some(d => d.action.kills)) { openAssassinFlow(uid, list); return; }
  const nm = data.cardDefsById[def]?.name ?? def; const g = gateFor(whoActs(s)); let pick = null;
  const intro = def === 'revolt' ? "Choose the enemy province to inspire a revolt in: a rival's conquered province with fewer than 10 troops; never a starting or allied province or Roma (17.c, 17.r, 18.m)."
    : def === 'bribe_the_ally' ? 'Bribe a province allied to a rival (pay its native count in Gold), or pay 1 Gold to turn one of YOUR OWN allies into a conquered province (18.v, 19.r).' : 'Choose the target.';
  openSheet('cardTargets', `<div class="sh-head"><img src="${attr(img('card.' + def))}" alt="" style="width:34px;border-radius:4px"><h2>${esc(nm)}<small>${list.length} possible target(s)</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body" id="cardTargets">${gateNote(g)}<p class="note">${esc(intro)}</p><div class="alist">${list.map((d, i) => { const id = G.mainProvince(d); return `<button class="arow tgt" data-ti="${i}"${id ? ` data-prov="${attr(id)}"` : ''}><span class="ic">🎯</span><span class="t"><b>${esc(d.label)}</b></span><span class="go">○</span></button>`; }).join('')}</div></div>
    <div class="sh-foot"><button class="btn" data-close>Cancel</button><button class="btn gold wide" id="cardGo" disabled>Choose a target first</button></div>`, { half: false });
  $$('#sheet [data-ti]').forEach(b => b.onclick = () => { pick = list[+b.dataset.ti]; SND.play('province_select'); if (b.dataset.prov) flashToken(b.dataset.prov);
    $$('#sheet [data-ti]').forEach(x => { x.classList.toggle('on', x === b); $('.go', x).textContent = x === b ? '●' : '○'; });
    const go = $('#cardGo'); go.disabled = !g.live; go.textContent = `Play ${nm} ▶`; });
  $('#cardGo').onclick = () => { if (!pick) return; closeSheet(true); act(pick); };
}

/** v30.1: the General sheet (the desktop's General popup, v29): the general's card and perks, and EVERY button of that seat
 *  (Roll, Draw card, Attack, Ally, Move, Buy, Build, Card, Sell, General, More, End turn), live only when G.seatActsGate says this
 *  seat may act now on this screen; otherwise greyed with the reason. */
function genActs(pid) {
  const s = st(); const g = gateFor(pid); const legal = g.live ? g.legal : []; const f = topFrame(s);
  const c = G.categorize(legal); const free = !f && s.phase === 'turn' && legal.length > 0;
  const rolls = legal.filter(d => d.type === 'ROLL' && !(f?.purpose === 'battleRound')), draws = legal.filter(d => d.type === 'DRAW_CARD');
  const heldCards = G.handCards(G.playerById(s, pid)).length > 0;
  const B = (k, ic, t, on, go, why) => ({ k, ic, t, on: !!on, go, why });
  const no = w => (g.live ? w : g.why);
  return [
    B('roll', '🎲', rolls.length === 1 ? rolls[0].label : 'Roll', rolls.length, () => (rolls.length === 1 ? act(rolls[0]) : openList('Roll', rolls)), no('No roll is due for this player now.')),
    B('draw', '🂠', draws.length === 1 ? draws[0].label : 'Draw card', draws.length, () => (draws.length === 1 ? act(draws[0]) : openList('Draw a card', draws)), no('No draw is due for this player now.')),
    ...(f && legal.length && !rolls.length && !draws.length ? [B('answer', '❗', `${G.frameTitle(s, data)}…`, true, () => (s.battle ? (battleOff = null, openBattle()) : openAsk()), '')] : []),
    ...['ATTACK', 'ALLY', 'MOVE'].map(t => B(t.toLowerCase(), ICON[t], { ATTACK: 'Attack', ALLY: 'Ally', MOVE: 'Move' }[t], free && c.move.some(d => d.type === t), () => openMoves(t), no(f ? 'Finish the current step first.' : `No ${t.toLowerCase()} is possible right now.`))),
    B('buy', '🛒', 'Buy', free && c.buy.length, () => openList('Buy', c.buy), no(f ? 'Finish the current step first.' : 'Nothing to buy now.')),
    B('build', '🏛', 'Build', free && c.build.length, () => openList('Build', c.build), no(f ? 'Finish the current step first.' : 'Nothing to build now.')),
    B('card', '🂠', 'Card', g.live && heldCards && pid === C.viewer, () => openCards(), no('No card to play.')),
    B('sell', '💰', 'Sell', free && c.sell.length, () => openList('Sell a card', c.sell), no('No card to sell.')),
    B('general', '⚑', 'General', free && c.general.length, () => openList('Move your general', c.general), no('The general cannot move now.')),
    B('more', '⋯', 'More', free && (c.scout.length + c.other.length), () => openList('More actions', [...c.scout, ...c.other]), no('No other action now.')),
    B('end', '✓', 'End turn', free && c.end.length, () => act(c.end[0]), no(f ? 'Finish the current step first.' : 'You cannot end the turn now.')),
  ];
}
function openPlayer(pid, refresh = false) {
  const s = st(); const p = G.playerById(s, pid); const g = p.general ? G.generalView(data, p.general.id) : null;
  const gate = gateFor(pid); const btns = s.phase === 'finished' ? [] : genActs(pid);
  const html = `<div class="sh-head"><span class="sw" style="--c:var(--${col(pid)});width:16px;height:16px"></span><h2>${esc(p.name)}<small>${p.controller === 'ai' ? 'AI' : 'Human'} · ${p.gold} Gold · ${p.prestige}/${data.rules.winPrestige} Prestige · ${ownedBy(s, pid).length} provinces · ${totalTroops(s, pid)} troops · ${G.handCount(p)} cards</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body" id="genSheet" data-pid="${attr(pid)}" data-live="${gate.live ? '1' : ''}">
      ${btns.length ? `<div class="sec">Roll, draw and actions${gate.live ? '' : ''}</div>${gateNote(gate)}<div class="gvacts" id="gvActs">${btns.map((b, i) => `<button class="gvbtn${b.on && gate.live ? ' live' : ''}${b.k === 'roll' || b.k === 'draw' || b.k === 'answer' ? ' gold' : ''}" id="gv-${b.k}" data-gi="${i}"${b.on && gate.live ? '' : ` disabled title="${attr(b.why)}"`}><span class="ic">${b.ic}</span><span>${esc(b.t)}</span></button>`).join('')}</div>` : ''}
      ${g ? `<div class="cardrow"><img src="${attr(img('general.' + g.id))}" alt=""><div class="t"><b>${esc(g.name)} · ${esc(g.title)}</b>${esc(g.summary)}${p.general?.at ? `<div class="note">Now in ${esc(prov(p.general.at))}.</div>` : ''}</div></div>
      ${g.perks.map(x => `<div class="gvperk"><h3>${esc(x.name)}</h3><div class="note" style="margin:0 0 4px">When: ${esc(x.when)}</div><ul>${x.detail.map(l => `<li>${esc(l.text)} <small>(${esc(l.rules)})</small></li>`).join('')}</ul></div>`).join('')}` : '<p class="note">No general yet.</p>'}</div>`;
  if (refresh) { $('#sheet').innerHTML = '<div class="handle"><i></i></div>' + html; $$('#sheet [data-close]').forEach(b => b.onclick = () => closeSheet()); }
  else openSheet('player', html);
  $$('#gvActs [data-gi]').forEach(el => el.onclick = () => { const b = btns[+el.dataset.gi]; if (!b?.on || !gateFor(pid).live) { SND.play('error_denied'); toast(b?.why || gateFor(pid).why); return; } SND.play('button_click'); if (!['roll', 'draw', 'end'].includes(b.k)) closeSheet(true); b.go(); });
}

/** v30.1: the dedicated prompt sheets; every other frame falls back to the generic list (openAsk). All rows go through act() (the gate). */
function askBody(s, f, legal, g) {
  const dis = g.live ? '' : ' disabled';
  if (f.kind === 'setupGeneral') return `<div class="genlist" id="askGenerals">${legal.map((d, i) => { const gg = data.generalsById[d.action.general]; return `<button class="genopt" data-ai="${i}"${dis}><img src="${attr(img(gg ? 'general.' + gg.id : 'back.game'))}" alt=""><b>${esc(gg?.name ?? 'Random')}</b><small>${esc(gg ? G.generalCaption(data, gg.id) : 'a random free general')}</small></button>`; }).join('')}</div>`;
  if (f.kind === 'responseWindow' && f.window === 'revoltResponse') {
    const id = f.province ?? G.mainProvince(legal[0]) ?? null; const p = id ? s.provinces[id] : null;
    const kill = legal.filter(d => d.type === 'PLAY_CARD'), pass = legal.filter(d => d.type !== 'PLAY_CARD');
    return `<div class="cardrow" id="revoltAsk"><img src="${attr(img('card.kill_revolt_leader'))}" alt=""><div class="t"><b>${id ? `${esc(prov(id))} is about to revolt!` : 'A province is about to revolt!'}</b>${p ? `${p.troops} troops · ${p.native?.count ?? '?'} natives. ` : ''}Play Kill Revolt leader! to stop it (18.g), or let it revolt.</div></div>
      <div class="alist">${kill.map(d => `<button class="arow" data-ak="${attr(G.descKey(d))}"${dis}><span class="ic">🗡</span><span class="t"><b>${esc(d.label)}</b></span><span class="go">›</span></button>`).join('')}${pass.map(d => `<button class="arow" data-ak="${attr(G.descKey(d))}"${dis}><span class="ic">↷</span><span class="t"><b>${d.type === 'PASS' ? 'Let it revolt' : esc(d.label)}</b></span><span class="go">›</span></button>`).join('')}</div>`;
  }
  if (f.kind === 'responseWindow' && f.window === 'displeasedResponse') {
    const card = f.def ? G.cardView(data, f.def) : null;
    return `${card ? `<div class="cardrow" id="dispAsk"><img src="${attr(img(card.art))}" alt=""><div class="t"><b>${esc(card.name)}</b>${esc(card.text)}</div></div>` : ''}<p class="note">You may answer with Busy Little Bee (18.p), or let it happen.</p>${rowsHtml(legal, !g.live)}`;
  }
  if (f.kind === 'discardCards' || f.kind === 'chooseBattleCards' || legal.every(d => d.action.cardUid)) return rowsHtml(legal, !g.live);
  return rowsHtml(legal, !g.live);
}
/** The Ally confirm (natives, the troops they need, a stepper): opened from the Ally list rows. */
function openAllyConfirm(d) {
  const s = st(); const t = s.provinces[d.action.target]; const g = gateFor(d.playerId);
  openSheet('ally', `<div class="sh-head"><h2>🤝 Ally with ${esc(prov(d.action.target))}<small>from ${esc(prov(d.action.from))} · ${t.native.present ?? '?'} natives · needs ${d.range?.min ?? d.action.troops} troop(s)</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body" id="allyAsk">${gateNote(g)}<p class="note">Your troops join the natives there (17.b); the province becomes your ally. ${esc(pn(d.playerId))} keeps at least the minimum in ${esc(prov(d.action.from))}.</p>${rowsHtml([d], !g.live)}</div>`, { half: true });
  wireRows($('#sheet'), [d]);
}
// The Game Roll draw call (v28 item 1): at one screen with 2+ humans, a public "X draws a Game Card" sheet; only X's Draw is live.
let drawCallHidden = null;
function renderDrawCall(s) {
  const f = topFrame(s); const humans = s.players.filter(p => G.isHuman(s, p.id)).length;
  const on = !!f && f.kind === 'draw' && f.deck === 'game' && f.reason === 'reward' && humans >= 2 && !C.busy && drawCallHidden !== f.id && !popKind;
  if (!on) { if (sheetKind === 'drawcall') closeSheet(true); return; }
  if (sheetKind === 'drawcall' && $('#sheet').dataset.frame === f.id) return;
  const g = gateFor(f.player); const d = g.legal.find(x => x.type === 'DRAW_CARD');
  openSheet('drawcall', `${whoBar(f.player, 'must draw')}<div class="sh-head"><h2 id="dcTitle">${esc(pn(f.player))} draws a Game Card<small>Game Roll reward (16.k, 16.l)</small></h2></div>
    <div class="sh-body"><div class="cardrow"><img src="${attr(img('back.game'))}" alt=""><div class="t">${esc(pn(f.player))}'s province came up in the Game Roll, so ${esc(pn(f.player))} must draw a Game Card now.</div></div>${gateNote(g)}</div>
    <div class="sh-foot">${d ? `<button class="btn gold wide" id="dcDraw"${g.live ? '' : ' disabled'}>🂠 Draw the Game Card</button>` : `<span class="waitnote">Waiting for ${esc(pn(f.player))}…</span>`}<button class="btn" id="dcHide">Hide</button></div>`, { sticky: true });
  $('#sheet').dataset.frame = f.id; document.body.dataset.drawCall = f.player;
  $('#dcHide').onclick = () => { drawCallHidden = f.id; closeSheet(true); };
  const b = $('#dcDraw'); if (b) b.onclick = () => { closeSheet(true); act(d); };
}

// ------------------------------------------------------------------ v30.1: event popups as mobile sheets (a second, modal sheet layer: #pop)
// The same model.js popups as the desktop (gameRollPopup, revoltRollPopup, revoltPopup, displeasedPopup, assassinPopups, battleSummary,
// battleResultPopup, cardPlayPopup) on the same events. Sticky ones (a human at this screen is hit) wait for OK; the rest close themselves.
let popKind = null, popDone = null, popTimer = null, popSticky = false;
function openPop(kind, html, { sticky = true, autoMs = 0 } = {}) {
  if (popDone) closePop();
  const el = $('#pop'); popKind = kind; popSticky = sticky;
  el.className = 'sheet pop'; el.dataset.kind = kind; el.dataset.sticky = sticky ? '1' : '';
  el.innerHTML = '<div class="handle"><i></i></div>' + html;
  $('#popScrim').classList.add('on'); requestAnimationFrame(() => el.classList.add('on'));
  document.body.dataset.popup = kind;
  $$('[data-popok]', el).forEach(b => b.onclick = () => { SND.play('button_click'); closePop(); });
  return new Promise(res => {
    popDone = res;
    if (C.hostHidden()) closePop();
    else if (!sticky) popTimer = setTimeout(() => { if (popKind === kind) closePop(); }, autoMs || spd(2600));
  });
}
function closePop() {
  clearTimeout(popTimer); popTimer = null; const d = popDone; popDone = null; popKind = null; popSticky = false;
  $('#pop').classList.remove('on'); $('#popScrim').classList.remove('on'); document.body.dataset.popup = '';
  if (d) d();
}
const whoBar = (pid, sub) => (pid ? `<div class="whobar" data-who="${attr(pid)}" style="--c:${cvar(pid)}"><b class="wb-name">${esc(pn(pid))}</b>${sub ? `<span class="wb-sub">${esc(sub)}</span>` : ''}</div>` : '');
const BATTLE_DICE = new Set(['battleRound', 'battleAttack', 'battleDefence']);
/** Game Roll / Revolt Roll / revolt / Rome Is Displeased result popups (the desktop's rollPopup). */
async function rollSheet(p) {
  if (!p) return;
  for (const m of p.matched ?? []) flashToken(m.id);
  if (p.province) flashToken(p.province);
  const lines = p.matched ? p.lines.filter(l => !l.startsWith(`Number ${p.value}: `)) : p.lines;
  const hit = p.matched ? `<div class="sec">Province${p.matched.length === 1 ? '' : 's'} with number ${esc(p.value)}</div><div class="chips" id="rollProv">${p.matched.length ? p.matched.map(m => `<span class="pchip" data-prov="${m.id}"><span class="sw" style="--c:${m.owner ? cvar(m.owner) : 'var(--native)'}"></span><b>${esc(m.name)}</b>&nbsp;<small>${esc(m.holder)}</small></span>`).join('') : '<span class="pchip">none</span>'}</div>` : '';
  const html = `${p.kind === 'displeased' && p.player ? whoBar(p.player, 'drew Rome Is Displeased') : ''}<div class="sh-head"><h2 id="popTitle">${esc(p.title)}</h2></div>
    <div class="sh-body"><div class="pophero">${p.value !== undefined ? `<div class="d10"><b>${esc(p.value)}</b></div>` : ''}<img src="${attr(img(p.art))}" alt=""></div>${hit}
    <ul class="poplines">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>
    <div class="sh-foot">${p.sticky ? '<span class="waitnote">Tap OK to continue.</span>' : ''}<button class="btn gold wide" data-popok id="popOk">OK</button></div>`;
  await openPop(p.kind, html, { sticky: !!p.sticky });
}
/** Hot-seat (as on the desktop): a popup for a human who is not at the screen now waits as "While you were away". */
const news = {};
const NEWS_KINDS = new Set(['revolt', 'battle', 'displeased']);
function queueNews(p) { if (!p || !NEWS_KINDS.has(p.kind) || !G.isHuman(st(), p.player)) return false; if (p.player !== G.viewerFor(st(), C.viewer)) { (news[p.player] ??= []).push(p); return true; } return false; }
async function deliver(p) { if (!p) return; if (queueNews(p)) await rollSheet({ ...p, sticky: false }); else await rollSheet(p); }
async function showNews() {
  const list = C.viewer && news[C.viewer]; if (!list?.length || C.busy) return;
  delete news[C.viewer]; C.busy = true; document.body.dataset.busy = '1';
  for (const p of list) await rollSheet({ ...p, title: `While you were away: ${p.title}`, sticky: true });
  C.busy = false; document.body.dataset.busy = ''; render(); schedule();
}
async function assassinSheet(p) {
  for (const x of p.strikes) flashToken(x.province);
  SND.play('error_denied');
  await openPop('assassin', `<div class="banner red">🗡 ASSASSINS STRIKE! 🗡</div><div class="sh-head"><h2 id="assAlert"><span style="color:${cvar(p.attacker)}">${esc(p.attackerName)}</span>'s assassins strike <span style="color:${cvar(p.victim)}">${esc(p.victimName)}</span>!</h2></div>
    <div class="sh-body"><div class="pophero"><img src="${attr(img('card.assassin'))}" alt=""></div><ul class="poplines">${p.strikes.map(x => `<li data-prov="${x.province}"><b>${esc(x.name)}</b>: ${x.killed} killed · ${x.left} left</li>`).join('')}</ul>${p.lines.map(l => `<p class="note">${esc(l)}</p>`).join('')}</div>
    <div class="sh-foot"><button class="btn gold wide" data-popok id="assOk">OK, I understand</button></div>`, { sticky: true });
}
/** A card drawn by a human (or any public draw): the card, big, for a moment (the desktop's flip). */
async function drawSheet(deck, def, who, caption) {
  const c = G.cardView(data, def);
  await openPop('draw', `${whoBar(who, caption)}<div class="sh-head"><h2 id="drawName">${esc(c.name)}<small>${esc(G.DECK_TITLES[deck]?.[0] ?? deck)}</small></h2></div>
    <div class="sh-body"><div class="pophero"><img class="bigcard" src="${attr(img(c.art))}" alt=""></div><p class="note" style="text-align:center">${esc(c.text)}</p></div>
    <div class="sh-foot"><button class="btn gold wide" data-popok>OK</button></div>`, { sticky: false, autoMs: spd(2200) });
}
/** v27: the "card played" popup, non-blocking: a card at the top that says whose it is and what it did; closes after 8 s or on Close. */
let cpSeq = 0;
const CARD_VIEW_MS = 8000;
function showCardPlay(p) {
  if (!p || C.hostHidden()) return;
  const box = $('#cardPlays');
  const el = document.createElement('div'); el.className = 'cplay'; el.id = 'cp' + (++cpSeq); el.dataset.def = p.def; el.dataset.who = p.player;
  el.innerHTML = `${whoBar(p.player, `${p.verb} ${p.name}`)}<div class="cp-body"><img src="${attr(img('card.' + p.def))}" alt=""><div class="cp-txt"><b>${esc(p.name)}</b><ul>${p.outcome.slice(0, 4).map(l => `<li>${esc(l)}</li>`).join('')}</ul></div><button class="iconbtn" data-cpclose aria-label="Close">✕</button></div>`;
  box.prepend(el); while (box.children.length > 2) box.lastElementChild.remove();
  el.querySelector('[data-cpclose]').onclick = () => el.remove();
  setTimeout(() => el.remove(), CARD_VIEW_MS);
}
function flashToken(id) { const t = $(`#tokens .tok[data-id="${id}"]`); if (!t) return; t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }

// ------------------------------------------------------------------ v30.1: the battle sheet (the desktop's battle popup): sides, perks, cards, every round's dice
let bv = null, battleOff = null;
const gname = pid => { const g = G.playerById(st(), pid)?.general; return g ? data.generalsById[g.id]?.name ?? '' : ''; };
function bvFromState(s) {
  const b = s.battle; if (!b) return null;
  const perks = () => ({ a: new Map(), d: new Map() });
  if (b.mode === 'decree') return { id: b.id, title: 'SENATE DECREE', sub: `${b.att.own} legion(s) attack Carthage (16.n)`, att: 'Senate legions', attCls: 'p1', def: 'Carthage', defCls: 'nat', aCount: b.att.own, dCount: s.provinces.carthage.native.present, borrowed: 0, attId: null, defId: null, aGen: 'no general (16.n)', dGen: 'natives', perks: perks(), rounds: [], cards: { a: [], d: [] }, decree: true };
  const t = s.provinces[b.target];
  return { id: b.id, title: `BATTLE for ${prov(b.target)}`, sub: `${prov(b.att.from)} → ${prov(b.target)}${b.sea ? ' by sea ⚓' : ''}`, att: pn(b.att.player), attCls: col(b.att.player),
    def: b.def.player ? pn(b.def.player) : b.target === 'roma' ? 'Roma' : `${prov(b.target)} natives`, defCls: b.def.player ? col(b.def.player) : 'nat',
    aCount: b.att.own + (b.att.borrowed ?? 0), dCount: b.def.player || b.target === 'roma' ? t.troops : (t.native.present ?? 0), borrowed: b.att.borrowed ?? 0, attId: b.att.player, defId: b.def.player,
    aGen: b.att.general ? `General ${gname(b.att.player)} leads the army` : 'no general', dGen: b.def.general ? `General ${gname(b.def.player)} defends` : b.def.player ? 'no general here' : 'no general', perks: perks(), rounds: [], cards: { a: [], d: [] } };
}
const sideCol = cls => (cls === 'nat' ? 'var(--native)' : `var(--${cls})`);
function battleHtml() {
  const side = (k, name, cls, count, gen) => `<div class="bside ${k}" style="--c:${sideCol(cls)}"><b class="bname" id="${k}Name">${esc(name)}</b><small>${k === 'a' ? 'attacker' : 'defender'}</small>
    <span class="bcount" id="${k}Count">${count ?? '–'}</span><small id="${k}Gen">${esc(gen)}</small><ul class="bperks" id="${k}Perks"></ul><div class="bcards" id="${k}Cards"></div></div>`;
  return `<div class="sh-head"><h2 id="bTitle">⚔ ${esc(bv.title)}<small>${esc(bv.sub ?? '')}</small></h2><div class="spacer"></div><button class="iconbtn" id="bHide" aria-label="Look at the map">▾</button></div>
    <div class="sh-body bbody"><div class="bsides">${side('a', bv.att, bv.attCls, bv.aCount, bv.aGen)}<div class="bvs">VS</div>${side('d', bv.def, bv.defCls, bv.dCount, bv.dGen)}</div>
    <div class="brounds" id="bRounds">${bv.rounds.length ? '' : '<p class="note" id="bNone">No round rolled yet.</p>'}</div><div class="bask" id="bAsk"></div><div class="bres" id="bRes"></div></div>
    <div class="sh-foot" id="bCtl"></div>`;
}
function openBattle() {
  if (!bv) bv = bvFromState(st()); if (!bv) return;
  if (popKind === 'battle') return;
  if (popDone) closePop();
  battleOff = null;
  const el = $('#pop'); popKind = 'battle'; popSticky = true; el.className = 'sheet pop battle'; el.dataset.kind = 'battle'; el.dataset.sticky = '1';
  el.innerHTML = '<div class="handle"><i></i></div>' + battleHtml();
  $('#popScrim').classList.add('on'); requestAnimationFrame(() => el.classList.add('on'));
  document.body.dataset.popup = 'battle';
  $('#bHide').onclick = () => { battleOff = st().battle?.id ?? 'x'; $('#pop').classList.remove('on'); $('#popScrim').classList.remove('on'); popKind = null; document.body.dataset.popup = ''; render(); };
  renderPerks(); for (const k of ['a', 'd']) $(`#${k}Cards`).innerHTML = bv.cards[k].map(c => `<span class="pchip bc">${esc(c)}</span>`).join('');
  for (const r of bv.rounds) $('#bRounds').insertAdjacentHTML('beforeend', r.html);
  renderBattleCtl();
}
function addPerk(side, text, key = text, replace = false) { if (!bv || !text) return; if (replace || !bv.perks[side].has(key)) bv.perks[side].set(key, text); renderPerks(); }
function renderPerks() { if (!bv || popKind !== 'battle') return; for (const k of ['a', 'd']) { const m = bv.perks[k]; $(`#${k}Perks`).innerHTML = m.size ? [...m.values()].map(x => `<li>${esc(x)}</li>`).join('') : ''; } }
function setCount(k, n) { if (!bv) return; bv[k + 'Count'] = n; const el = popKind === 'battle' && $(`#${k}Count`); if (el) { if (el.textContent !== String(n)) { el.textContent = n; el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); } } }
const dieSpans = (arr, cls) => arr.map(v => `<span class="d ${cls}">${v}</span>`).join('');
async function animRound(e) {
  if (!bv) bv = bvFromState(st()) ?? { title: 'Battle', att: pn(e.pub.attacker.player), attCls: col(e.pub.attacker.player), def: 'Defender', defCls: 'nat', perks: { a: new Map(), d: new Map() }, rounds: [], cards: { a: [], d: [] } };
  openBattle(); $('#bNone')?.remove();
  const plain = /^(land attack: |defender: \d dice|only \d+ )/;
  for (const r of e.pub.attacker.reasons ?? []) if (!plain.test(r)) addPerk('a', r);
  for (const r of e.pub.defender.reasons ?? []) if (!plain.test(r)) addPerk('d', r);
  const a = e.pub.attacker.dice, d = e.pub.defender.dice;
  const row = document.createElement('div'); row.className = 'bround'; row.dataset.r = e.pub.round;
  row.innerHTML = `<span class="rn">R${e.pub.round}</span><span class="dice ca">${dieSpans(a.map(() => '?'), 'a rolling')}</span><span class="vs">v</span><span class="dice cd">${dieSpans(d.map(() => '?'), 'n rolling')}</span><span class="cl"></span>`;
  $('#bRounds').append(row); row.scrollIntoView({ block: 'nearest' });
  SND.play('dice_roll_d6', { vol: 0.6 });
  const ds = $$('.d', row); const t0 = Date.now();
  while (Date.now() - t0 < spd(600)) { ds.forEach(x => { x.textContent = 1 + Math.floor(Math.random() * 6); }); await sleep(60); }
  $$('.ca .d', row).forEach((x, i) => { x.classList.remove('rolling'); x.textContent = a[i]; });
  $$('.cd .d', row).forEach((x, i) => { x.classList.remove('rolling'); x.textContent = d[i]; });
  SND.play('dice_land'); await sleep(spd(250));
}
async function animResolved(e) {
  const p = e.pub; const row = $(`#bRounds .bround[data-r="${p.round}"]`);
  if (row) {
    const dA = $$('.ca .d', row), dD = $$('.cd .d', row);
    dA.forEach((x, i) => { x.textContent = p.attackerFinal[i] ?? x.textContent; }); dD.forEach((x, i) => { x.textContent = p.defenderFinal[i] ?? x.textContent; });
    p.pairs.forEach((q, i) => { const aw = q.winner === 'attacker'; dA[i]?.classList.add(aw ? 'win' : 'lose'); dD[i]?.classList.add(aw ? 'lose' : 'win'); });
    dA.slice(p.pairs.length).forEach(x => x.classList.add('unused')); dD.slice(p.pairs.length).forEach(x => x.classList.add('unused'));
    $('.cl', row).innerHTML = `<b class="loss">−${p.attackerLoss}</b>/<b class="loss">−${p.defenderLoss}</b> → ${p.attackerTroopsAfter}:${p.defenderTroopsAfter}`;
    if (bv) bv.rounds.push({ html: row.outerHTML });
  }
  if (p.defenderLoss > p.attackerLoss) SND.play('battle_attacker_win_round'); else if (p.attackerLoss > p.defenderLoss) SND.play('battle_defender_win_round');
  setCount('a', p.attackerTroopsAfter); setCount('d', p.defenderTroopsAfter);
  await sleep(spd(550));
}
/** The result at the foot of the battle sheet: waits for OK when a human at this screen fought, otherwise closes itself. */
async function battleResult(sum, sticky) {
  if (popKind !== 'battle') openBattle(); if (popKind !== 'battle') return;
  $('#bAsk').innerHTML = '';
  $('#bRes').innerHTML = sum ? `<h3 id="bResTitle">${esc(sum.title)}</h3><ul class="poplines">${sum.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  $('#bCtl').innerHTML = `${sticky ? '<span class="waitnote">Tap OK to continue.</span>' : ''}<button class="btn gold wide" id="bpOk">OK</button>`;
  $('#bRes').scrollIntoView({ block: 'nearest' });
  await new Promise(res => {
    popDone = res; popSticky = sticky;
    $('#bpOk').onclick = () => { SND.play('button_click'); closePop(); };
    if (C.hostHidden()) closePop(); else if (!sticky) popTimer = setTimeout(() => { if (popKind === 'battle') closePop(); }, spd(3500));
  });
  bv = null;
}
/** The battle's prompts inside the battle sheet (battle cards, borrow, the Horn, Roll a round, continue or retreat, perks), gated. */
function renderBattleCtl() {
  if (popKind !== 'battle' || popDone) return;
  const s = st(); const f = topFrame(s); const ask = $('#bAsk'), ctl = $('#bCtl'); if (!ask || !ctl) return;
  const w = whoActs(s); const g = w ? gateFor(w) : { live: false, why: 'Nobody can act right now.', legal: [] }; const legal = g.legal;
  ask.innerHTML = ''; ctl.innerHTML = '';
  if (!f || !s.battle) { ctl.innerHTML = '<span class="waitnote">…</span>'; return; }
  const title = `<div class="sec">${esc(G.frameTitle(s, data))} · <b style="color:${cvar(w)}">${esc(pn(w))}</b></div>`;
  if (!legal.length) { ask.innerHTML = title + gateNote(g); ctl.innerHTML = `<span class="waitnote" id="bWait">${G.isHuman(s, w) ? `Waiting for ${esc(pn(w))}…` : `${esc(pn(w))} (AI) is deciding…`}</span>`; return; }
  const dis = g.live ? '' : ' disabled';
  if (f.kind === 'roll' || f.kind === 'battleContinue') {
    ask.innerHTML = title + gateNote(g);
    ctl.innerHTML = legal.map((d, i) => `<button class="btn ${d.type === 'BATTLE_RETREAT' ? '' : 'gold'} wide" data-bi="${i}" id="${d.type === 'BATTLE_RETREAT' ? 'bRetreat' : d.type === 'BATTLE_CONTINUE' ? 'bContinue' : 'bRoll'}"${dis}>${d.type === 'ROLL' ? '🎲 ' : ''}${esc(d.type === 'BATTLE_CONTINUE' ? 'Continue' : d.type === 'BATTLE_RETREAT' ? 'Retreat' : d.label)}</button>`).join('');
    $$('[data-bi]', ctl).forEach(b => b.onclick = () => act(legal[+b.dataset.bi]));
    return;
  }
  if (f.kind === 'chooseBattleCards') {
    const items = G.battleCardChecklist(data, f.held);
    ask.innerHTML = title + gateNote(g) + `<div class="bcchecks" id="bcChecks">${items.map(c => `<button class="bccheck" data-bc="${attr(c.def)}" aria-pressed="false"${dis}><img src="${attr(img(c.art))}" alt=""><span><b>${esc(c.name)}</b><small>${esc(c.text)}</small></span><i class="tick">✓</i></button>`).join('')}</div>
      <p class="note" id="bcSum"></p>${G.battleCardsHint(data, f.role) ? `<p class="note" id="bcHint">${esc(G.battleCardsHint(data, f.role))}</p>` : ''}`;
    ctl.innerHTML = `<button class="btn gold wide" id="bcConfirm"${dis}>Fight without battle cards ▶</button>`;
    const sync = () => { const t = $$('.bccheck.on', ask).map(b => b.dataset.bc); $('#bcSum').textContent = t.length ? `${t.length} card(s) ticked: ${t.map(d => data.cardDefsById[d]?.name ?? d).join(', ')}.` : 'No card ticked: you fight without battle cards.'; $('#bcConfirm').textContent = t.length ? `Use ${t.length} card(s) ▶` : 'Fight without battle cards ▶'; };
    $$('.bccheck', ask).forEach(b => b.onclick = () => { b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on')); SND.play('button_click'); sync(); });
    $('#bcConfirm').onclick = () => { const d = G.battleCardsChoice(legal, $$('.bccheck.on', ask).map(b => b.dataset.bc)); if (!d) { SND.play('error_denied'); toast('That combination cannot be played'); return; } act(d); };
    sync(); return;
  }
  const horn = f.kind === 'responseWindow' && f.window === 'defenceAnnounced' ? `<p class="note" id="hornNote">Horn of Titus Pullus: bring any number of troops from ONE bordering province of yours (allied ones too); at least 1 stays there. One Horn per battle (18.y).</p>` : '';
  ask.innerHTML = title + gateNote(g) + horn + rowsHtml(legal, !g.live);
  wireRows(ask, legal);
  ctl.innerHTML = `<span class="waitnote">Choose above · ▾ to look at the map</span>`;
}

// ------------------------------------------------------------------ events -> sheets, animations and sounds (the desktop's playEvents, on a phone)
async function playEvents(events, before = null) {
  const s = st(); const plan = G.soundPlan(events, s); const shownRevolts = new Set();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    for (const n of plan[i]) SND.play(n, { vol: e.type === 'diceRolled' ? 0.7 : 1 });
    switch (e.type) {
      case 'diceRolled': {
        lastRoll = { die: e.pub.die, value: e.pub.value, purpose: e.pub.purpose };
        if (BATTLE_DICE.has(e.pub.purpose)) break;
        const chip = $('#dieChip'), v = $('#dieVal'); chip.classList.add('rolling'); const t0 = Date.now(); const n = parseInt(String(e.pub.die).slice(1), 10) || 6;
        while (Date.now() - t0 < spd(420)) { v.textContent = 1 + Math.floor(Math.random() * n); await sleep(60); }
        chip.classList.remove('rolling'); v.textContent = e.pub.value; break;
      }
      case 'gameRollResolved': await rollSheet(G.gameRollPopup(events, i, s, data)); break;
      case 'revoltRoll': {
        const p = G.revoltRollPopup(events, i, s, data);
        for (let k = i + 1; k < events.length && events[k].type !== 'revoltRoll'; k++) if (events[k].type === 'provinceRevolted') { shownRevolts.add(k); flashToken(events[k].pub.province); queueNews(G.revoltPopup(events, k, s, data)); }
        await rollSheet(p); break;
      }
      case 'provinceRevolted': if (!shownRevolts.has(i)) await deliver(G.revoltPopup(events, i, s, data)); break;
      case 'attackDeclared': bv = null; bv = bvFromState(s) ?? bvFromState(before ?? s); if (bv) openBattle(); break;
      case 'decreeBattle': bv = bvFromState(s); if (!bv) bv = { title: 'SENATE DECREE', sub: `${e.pub.legions} legion(s) attack Carthage`, att: 'Senate legions', attCls: 'p1', def: 'Carthage', defCls: 'nat', aCount: e.pub.legions, dCount: e.pub.carthage, perks: { a: new Map(), d: new Map() }, rounds: [], cards: { a: [], d: [] }, decree: true }; openBattle(); break;
      case 'decreeResolved': if (bv?.decree) { const r = e.pub; await battleResult({ title: r.result === 'destroyed' ? 'CARTHAGE DESTROYED' : r.result === 'held' ? 'CARTHAGE HOLDS' : 'NO BATTLE', lines: [r.result === 'destroyed' ? `${r.survivors} legion(s) return to Roma.` : r.result === 'held' ? `Carthage has ${r.carthage} troop(s) left.` : 'No legion was sent.'] }, false); } break;
      case 'battleStarted': if (!bv) bv = bvFromState(s) ?? bvFromState(before ?? s); openBattle();
        setCount('a', e.pub.attacker); setCount('d', e.pub.defender);
        if (e.pub.perk === 'extraDie') addPerk('a', 'Scipio: an extra die (15.c)', 'scipio');
        if (e.pub.wallRollsIgnored) addPerk('a', `Wall bonus ignored for the first ${e.pub.wallRollsIgnored} roll(s)`, 'wallIgnored');
        await sleep(spd(400)); break;
      case 'enemyFled': addPerk(e.pub.side === 'defender' ? 'a' : 'd', 'Caesar: one enemy troop flees before the battle (15.b)'); break;
      case 'generalPerkTriggered': addPerk(bv && e.actor === bv.defId && bv.defId ? 'd' : 'a', `${data.generalsById[e.pub.general]?.name ?? e.pub.general}: ${e.pub.reason ?? e.pub.effect} (${e.rule})`); break;
      case 'cardPlayed': {
        if (bv && data.cardDefsById[e.pub.def]?.type === 'battle') { const k = s.battle && s.battle.def.player === e.pub.player ? 'd' : 'a'; const nm = data.cardDefsById[e.pub.def].name; bv.cards[k].push(nm); const box = popKind === 'battle' && $(`#${k}Cards`); if (box) box.insertAdjacentHTML('beforeend', `<span class="pchip bc">${esc(nm)}</span>`); }
        showCardPlay(G.cardPlayPopup(events, i, s, data)); break;
      }
      case 'resourceApplied': case 'resourceCardUsed': showCardPlay(G.cardPlayPopup(events, i, s, data)); break;
      case 'battleRoundRolled': await animRound(e); break;
      case 'battleDiceAdjusted': for (const x of e.pub.adjustments ?? []) addPerk(x.side === 'defender' ? 'd' : 'a', G.adjustmentLabel(x, data), x.source, true); break;
      case 'battleRoundResolved': await animResolved(e); break;
      case 'battleEnded': {
        await sleep(spd(300));
        const p = G.battleResultPopup(events, i, s, data); const away = p ? queueNews(p) : false;
        const sum = G.battleSummary(events, i, s, data);
        const look = [e.actor, e.pub.defender].filter(x => x && G.isHuman(s, x) && x === G.viewerFor(s, C.viewer));
        await battleResult(p && !away && p.player === G.viewerFor(s, C.viewer) ? { ...sum, title: p.title, lines: p.lines } : sum, look.length > 0);
        break;
      }
      case 'displeasedDrawn': await drawSheet('displeased', e.pub.def, e.pub.player, 'draws from Rome Is Displeased'); break;
      case 'cardDrawn': {
        const def = e.pub.def ?? (e.priv && e.pub.player === C.viewer ? e.priv.def : null);
        if (def && (G.isHuman(s, e.pub.player) || e.pub.deck !== 'game')) await drawSheet(e.pub.deck, def, e.pub.player, `draws a ${e.pub.deck === 'game' ? 'Game' : 'Resource'} card`);
        else toast(`${pn(e.pub.player)} draws a ${e.pub.deck === 'game' ? 'Game Card (hidden)' : e.pub.deck + ' card'}`);
        break;
      }
      case 'troopsAssassinated': {
        const prev = events[i - 1];
        if (!(prev?.type === 'troopsAssassinated' && prev.pub.player === e.pub.player)) for (const p of G.assassinPopups(events, i, s, data)) await assassinSheet(p);
        break;
      }
      case 'provinceAllied': flashToken(e.pub.province); await rollSheet({ kind: 'ally', title: `${prov(e.pub.province)} is now allied`, art: 'back.game', lines: [`${pn(e.pub.player)} allies with ${prov(e.pub.province)}: its natives join ${pn(e.pub.player)}'s side.`], sticky: false }); break;
      case 'revoltBlocked': toast(`Kill Revolt leader!: ${prov(e.pub.province)} does not revolt`); break;
      case 'revoltRollSkipped': toast(`${pn(e.pub.player)}: no Revolt Roll (fewer than 2 conquered provinces, 17.c)`); break;
      case 'provinceConquered': flashToken(e.pub.province); toast(`${pn(e.pub.player)} conquers ${prov(e.pub.province)}!`); break;
      case 'turnStarted': toast(`Turn ${e.pub.number}: ${pn(e.pub.player)}`); break;
      case 'playerEliminated': toast(`${pn(e.pub.player)} is out of the game`); break;
      default: if (G.isDispleasedResult(e)) await deliver(G.displeasedPopup(events, i, s, data)); break;
    }
  }
}

// ------------------------------------------------------------------ test hook (the same shape as the desktop page's)
window.__imperator = {
  state: () => (C.S ? st() : null), busy: () => C.busy || C.autoRoll, viewer: () => C.viewer, legal: () => (C.S ? mineNow() : []),
  suggest: () => G.aiMove(C.S), play: a => C.apply(a), sounds: () => SND.played.slice(-80), label: () => C.uiLabel, ui: 'mobile',
  map: () => ({ ...MV.V }), steps: () => C.S?.steps.length ?? null,
  popup: () => popKind, sheet: () => sheetKind, gate: pid => (C.S ? gateFor(pid) : null), battleOpen: () => popKind === 'battle',
  setSpeed: v => { C.speed = v; },
};
$('#popScrim').onclick = () => { if (popKind && !popSticky) closePop(); };
boot();
