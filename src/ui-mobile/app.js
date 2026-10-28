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
  applied: ({ fromAi }) => { if (!fromAi && ['ask', 'list', 'moves', 'cards'].includes(sheetKind)) closeSheet(true); },
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
  if (sheetKind === 'ask' && (!topFrame(s) || !legal.length || document.body.dataset.askFrame !== topFrame(s).id)) closeSheet(true);
  if (sheetKind === 'province' && selected) openProvince(selected, true);
  else if (sheetKind === 'log') openLog(true);
  autoAsk(s, legal);
}
function renderPlayers(s) {
  const act = s.phase === 'turn' ? s.turn.activePlayerId : whoActs(s);
  $('#players').classList.toggle('n2', s.players.length === 2);
  $('#players').innerHTML = s.players.map(p => { const g = p.general ? data.generalsById[p.general.id] : null; const on = p.id === act;
    return `<button class="pl${on ? ' active' : ''}${p.out ? ' out' : ''}" style="--c:var(--${col(p.id)})" data-pid="${p.id}" aria-label="${attr(p.name)}${g ? ', ' + attr(g.name) : ''}: open the General">
    <span class="tag ${on ? '' : p.controller === 'ai' ? 'ai' : ''}" ${!on && p.controller !== 'ai' ? 'hidden' : ''}>${on ? '▶ TURN' : 'AI'}</span>
    <span class="r1"><span class="av" style="background-image:url('${attr(img(g ? 'general.' + g.id : 'back.game'))}');background-position:center 15%"></span><span class="nm">${esc(p.name)}<small>${esc(g?.name ?? 'no general yet')}</small></span></span>
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
  if (rolls.length) gold = { k: 'roll', ic: '🎲', t: rolls.length === 1 ? 'Roll' : 'Roll…', on: !C.busy, due: true, go: () => (rolls.length === 1 ? human(rolls[0]) : openList('Roll', rolls)) };
  else if (draws.length) gold = { k: 'draw', ic: '🂠', t: 'Draw', on: !C.busy, due: true, go: () => (draws.length === 1 ? human(draws[0]) : openList('Draw a card', draws)) };
  else if (f && legal.length) gold = { k: 'answer', ic: '❗', t: 'Answer', on: true, due: true, go: () => openAsk() };
  else gold = { k: 'end', ic: '✓', t: 'End turn', on: free && c.end.length > 0, go: () => human(c.end[0]) };
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
function freezeControls() { $$('#acts .act, #sheet .arow').forEach(b => { b.disabled = true; }); }
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
function rowsHtml(list) {
  return `<div class="alist">${list.map((d, i) => {
    const def = d.action.cardUid ? st().cards[d.action.cardUid]?.def : null;
    const label = d.range ? d.label.replace(/\s*\(\d+-\d+\)$/, '') : d.label;
    return `<div class="rowwrap" data-i="${i}"><button class="arow" data-i="${i}"><span class="ic">${def ? `<img src="${attr(img('card.' + def))}" alt="" style="width:26px;border-radius:3px">` : ICON[d.type] ?? '•'}</span><span class="t"><b>${esc(label)}</b>${d.range ? `<small>${esc(d.range.field)}: <span class="rv">${d.range.max}</span> (${d.range.min}–${d.range.max})</small>` : ''}</span><span class="go">›</span></button>
      ${d.range && d.range.max > d.range.min ? `<div class="stepper" data-i="${i}"><button data-d="-1" aria-label="Fewer">−</button><b class="rv">${d.range.max}</b><button data-d="1" aria-label="More">＋</button></div>` : ''}</div>`;
  }).join('')}</div>`;
}
function wireRows(root, list) {
  const val = {}; list.forEach((d, i) => { if (d.range) val[i] = d.range.max; });
  $$('.stepper', root).forEach(sp => { const i = +sp.dataset.i; const d = list[i];
    $$('[data-d]', sp).forEach(b => b.onclick = () => { val[i] = Math.max(d.range.min, Math.min(d.range.max, val[i] + +b.dataset.d)); $$(`.rowwrap[data-i="${i}"] .rv`, root).forEach(x => { x.textContent = val[i]; }); }); });
  $$('.arow[data-i]', root).forEach(b => b.onclick = () => { const i = +b.dataset.i; const d = list[i]; if (!d || C.busy) return; closeSheet(true); human(d.range ? { ...d, _v: val[i] } : d); });
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
  $$('#sheet [data-play]').forEach(b => b.onclick = () => { const uid = b.dataset.play; const ds = mineNow().filter(d => (d.type === 'PLAY_CARD' || d.type === 'USE_SAVED_RESOURCE') && d.action.cardUid === uid); if (ds.length === 1) { closeSheet(true); human(ds[0]); } else openList('Play ' + (data.cardDefsById[s.cards[uid].def]?.name ?? 'the card'), ds); });
  $$('#sheet [data-sell]').forEach(b => b.onclick = () => { const d = mineNow().find(x => x.type === 'SELL_CARD' && x.action.cardUid === b.dataset.sell); if (d) { closeSheet(true); SND.play('gold_gain'); human(d); } });
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
  const half = pickFrames.includes(f.kind);
  openSheet('ask', `<div class="sh-head"><h2>${esc(G.frameTitle(s, data))}<small>${esc(pn(whoActs(s)))} · ${esc(G.describePrompt(s, data).replace(/^.*?: /, ''))}</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Hide for now">✕</button></div>
    <div class="sh-body">${rowsHtml(legal)}${half ? '<p class="note">You can also tap a glowing province on the map.</p>' : ''}<p class="note">Hidden for now? The gold “Answer” button opens this again.</p></div>`, { half });
  wireRows($('#sheet'), legal);
  document.body.dataset.askFrame = f.id;
}
function autoAsk(s, legal) {
  const f = topFrame(s);
  if (!f || !legal.length || C.busy || ['roll', 'draw'].includes(f.kind)) return;
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
function openPlayer(pid) {
  const s = st(); const p = G.playerById(s, pid); const g = p.general ? G.generalView(data, p.general.id) : null;
  openSheet('player', `<div class="sh-head"><span class="sw" style="--c:var(--${col(pid)});width:16px;height:16px"></span><h2>${esc(p.name)}<small>${p.controller === 'ai' ? 'AI' : 'Human'} · ${p.gold} Gold · ${p.prestige}/${data.rules.winPrestige} Prestige · ${ownedBy(s, pid).length} provinces · ${totalTroops(s, pid)} troops · ${G.handCount(p)} cards</small></h2><div class="spacer"></div><button class="iconbtn" data-close aria-label="Close">✕</button></div>
    <div class="sh-body">${g ? `<div class="cardrow"><img src="${attr(img('general.' + g.id))}" alt=""><div class="t"><b>${esc(g.name)} · ${esc(g.title)}</b>${esc(g.summary)}${p.general?.at ? `<div class="note">Now in ${esc(prov(p.general.at))}.</div>` : ''}</div></div>
      ${g.perks.map(x => `<div class="gvperk"><h3>${esc(x.name)}</h3><div class="note" style="margin:0 0 4px">When: ${esc(x.when)}</div><ul>${x.detail.map(l => `<li>${esc(l.text)} <small>(${esc(l.rules)})</small></li>`).join('')}</ul></div>`).join('')}` : '<p class="note">No general yet.</p>'}</div>`);
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
    openSheet('displeased', `<div class="sh-head"><h2>⚠ Rome is displeased<small>${esc(p?.name ?? f.player)} must draw a Rome Is Displeased card</small></h2></div>
      <div class="sh-body"><div class="cardrow"><img src="${attr(img('back.displeased'))}" alt=""><div class="t">${esc(G.displeasedReason(s, data, f.player))}</div></div></div>
      <div class="sh-foot">${can ? '<button class="btn red wide" id="dispDraw">Draw the card now</button>' : ''}<button class="btn gold wide" id="dispOk">OK, I understand</button></div>`, { sticky: true });
    const done = v => { closeSheet(true); res(v); };
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
async function playEvents(events) {
  const s = st(); const plan = G.soundPlan(events, s);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    for (const n of plan[i]) SND.play(n, { vol: e.type === 'diceRolled' ? 0.7 : 1 });
    switch (e.type) {
      case 'diceRolled': lastRoll = { die: e.pub.die, value: e.pub.value, purpose: e.pub.purpose }; $('#dieVal').textContent = e.pub.value; break;
      case 'gameRollResolved': { const p = G.gameRollPopup(events, i, s, data); if (p) { toast(p.title); await sleep(spd(700)); } break; }
      case 'battleEnded': { const p = G.battleSummary(events, i, s, data); if (p?.title) { toast(p.title); await sleep(spd(700)); } break; }
      case 'provinceConquered': toast(`${pn(e.pub.player)} conquers ${prov(e.pub.province)}!`); break;
      case 'provinceAllied': toast(`${pn(e.pub.player)} allies with ${prov(e.pub.province)}`); break;
      case 'provinceRevolted': toast(`${prov(e.pub.province)} revolts!`); await sleep(spd(500)); break;
      case 'turnStarted': toast(`Turn ${e.pub.number}: ${pn(e.pub.player)}`); break;
      case 'cardDrawn': { const def = e.pub.def ?? (e.priv && e.pub.player === C.viewer ? e.priv.def : null); toast(def && G.isHuman(s, e.pub.player) ? `${pn(e.pub.player)} draws ${data.cardDefsById[def]?.name ?? 'a card'}` : `${pn(e.pub.player)} draws a card`); break; }
      case 'playerEliminated': toast(`${pn(e.pub.player)} is out of the game`); break;
    }
  }
}

// ------------------------------------------------------------------ test hook (the same shape as the desktop page's)
window.__imperator = {
  state: () => (C.S ? st() : null), busy: () => C.busy || C.autoRoll, viewer: () => C.viewer, legal: () => (C.S ? mineNow() : []),
  suggest: () => G.aiMove(C.S), play: a => C.apply(a), sounds: () => SND.played.slice(-80), label: () => C.uiLabel, ui: 'mobile',
  map: () => ({ ...MV.V }), steps: () => C.S?.steps.length ?? null,
};
boot();
