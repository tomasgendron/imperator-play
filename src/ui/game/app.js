// Imperator game page (M5): the approved mockup v12 look wired to the engine. State lives in a console session (pure, src/ui/consoleModel.js);
// every click is a legal descriptor from legalActions (so the page can never send an illegal move); AI seats move after a short,
// speed-scaled delay; events drive the dice, battle and card animations, sounds and the log. Hot-seat privacy: model.js viewerFor/handFor.
import { loadGameData } from '../loadData.js';
import { resolveAsset } from '../assets.js';
import { setupChoices, checkSetup, current } from '../consoleModel.js';
import { topFrame, whoActs, minGarrison, isUnderGarrisoned, totalTroops, provincesOf as ownedBy, viewFor, eventsFor } from '../../engine/index.js';
import * as G from './model.js';
import { createSound } from './sound.js';
import { HostRoom, PING_MS } from '../../net/host.js';
import { GuestClient, HOST_AWAY_MS } from '../../net/guest.js';
import { createPeerTransport, createBroadcastTransport } from '../../net/transport.js';
import { roomCode, normCode } from '../../net/protocol.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = s => esc(s).replace(/'/g, '&#39;');

let data, assets, SND;
let S = null;                    // the session (history of states)
let viewer = null, hidden = false;
let busy = false, aiTimer = null, aiPaused = false;
let ab = null;                   // builder {type, from, to, n, key}
let selected = null, tab = 'table';
let lastRoll = {};               // pid -> {die, value, purpose}
let bv = null;                   // battle view built from events
let overShown = false, askPeek = false, uiLabel = 'v17';
let speed = 1;
try { speed = Number(localStorage.getItem('imperator.speed')) || 1; } catch { /* */ }
const spd = ms => Math.max(10, ms * speed);

// M12 (online step c): an online host's own screen shows the host's seat view too (viewFor: no peeking at the guests' hands or
// prompts); the engine, the AI, saves and the guests' updates use the full state (full()). Offline hot-seat: unchanged.
const full = () => G.stateOf(S);
let seatViewCache = { s: null, me: null, v: null };
const st = () => {
  const s = G.stateOf(S);
  if (NET?.role !== 'host' || !NET.me || !s) return s;
  if (seatViewCache.s !== s || seatViewCache.me !== NET.me) seatViewCache = { s, me: NET.me, v: viewFor(s, data, NET.me) };
  return seatViewCache.v;
};
const img = (id, o = {}) => { const r = resolveAsset(assets, id, o); return r.path ?? r.fallback ?? r.placeholder; };
const prov = id => data.provincesById[id]?.name ?? id;
const pn = id => G.nameOf(st(), id);
const col = id => G.colorClass(st(), id);
const genLetter = gid => (data.generalsById[gid]?.name ?? gid ?? '?')[0];

// ------------------------------------------------------------------ toast / modal helpers
let toastT;
function toast(m) { if (SND.since() > 250) SND.play('toast_notice', { vol: 0.5 }); const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), Math.max(1200, spd(2200))); }
let modalDone = null;
function openModal(html, { autoMs = 0, cls = '' } = {}) {
  const box = $('#modalBox'); box.className = 'modal ' + cls; box.innerHTML = html; $('#ovModal').classList.add('on');
  return new Promise(res => {
    modalDone = res;
    $$('[data-close]', box).forEach(b => b.onclick = closeModal);
    if (autoMs) setTimeout(() => { if (modalDone === res) closeModal(); }, autoMs);
  });
}
// batch 6 item 2 (Vidi 2026-10-25): the three decks on the start / host / join screens; a click lists every card type in the deck
// (art, name, text, copies). From the card data only: nothing about the current order of a deck or anyone's hand.
function renderSetupDecks() {
  const box = $('#setupDecks'); if (!box || !data) return;
  box.innerHTML = `<div class="small sdhead"><b>The decks</b> <span class="sdsub">click one to see its cards</span></div><div class="sdrow">`
    + G.deckCatalog(data).map(d => `<div class="deck sdeck" data-cat="${attr(d.key)}" role="button" tabindex="0" title="${attr(d.title)}: ${d.total} cards. Click to see them all."><img src="${img('deck.' + d.key)}" alt="${attr(d.title)}"><span>${esc(d.short)} · <b>${d.total}</b></span></div>`).join('') + '</div>';
  $$('.sdeck', box).forEach(el => {
    const open = () => { SND.play('button_click'); openDeckList(el.dataset.cat); };
    el.onclick = open; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}
function openDeckList(key) {
  const d = G.deckCatalog(data).find(x => x.key === key); if (!d) return;
  return openModal(`<div class="dl-head"><img src="${img('deck.' + key)}" alt=""><div><h2>${esc(d.title)}</h2><p class="small">${d.total} cards of ${d.cards.length} kinds. This list shows what the deck holds, never its order or anyone's hand.</p></div><button class="btn" data-close id="dlClose">Close</button></div>`
    + `<div class="dl-grid" id="dlGrid">${d.cards.map(c => `<div class="dl-card" data-def="${attr(c.def)}"><div class="cf art"><img src="${img(c.art)}" alt="${attr(c.name)}" loading="lazy"></div><div class="dl-txt"><b>${esc(c.name)}</b> <span class="dl-n">x${c.copies}</span>${c.battle ? ` <span class="bclabel" style="display:inline">${G.BATTLE_LABEL}</span>` : ''}<div class="small">${esc(c.text)}</div></div></div>`).join('')}</div>`, { cls: 'decklist' });
}
function closeModal() { $('#ovModal').classList.remove('on'); const f = modalDone; modalDone = null; if (f) f(); }
const mustAck = () => ['displeased-alert', 'assassin-alert'].some(c => $('#modalBox').classList.contains(c));   // batch 5 item 8 / v22: only their button closes them
$('#ovModal').addEventListener('click', e => { if (e.target.id === 'ovModal' && !mustAck()) closeModal(); });

// ------------------------------------------------------------------ boot
async function boot() {
  try { ({ data, assets } = await loadGameData()); } catch (e) { document.body.innerHTML = `<pre style="padding:20px;color:#b02a1c">Imperator could not load its data:\n${esc(e.message)}</pre>`; return; }
  SND = createSound(assets); SND.ui();
  $$('[data-img]').forEach(e => { e.src = img(e.dataset.img); });
  renderSetupDecks();
  $('#mapImg').src = img('map');
  try { const b = await (await fetch('BUILD.json', { cache: 'no-store' })).json(); uiLabel = b.uiLabel ?? `v23 · ${b.stamp}`; } catch { uiLabel = 'v23 · (no BUILD.json)'; }
  $('#tbVer').textContent = uiLabel;
  $('#speed').value = String(speed); if (!$('#speed').value) { $('#speed').value = '1'; speed = 1; }
  wireStatic();
  const jc = new URLSearchParams(location.search).get('join');
  if (jc) { playWhere = 'join'; $('#joinCode').value = normCode(jc); }
  joinWas = normCode(new URLSearchParams(location.search).get('was') || '');   // M14: the host resumed under a new code (the old one was taken)
  renderSetup();
  document.body.dataset.ready = '1';
}

// ------------------------------------------------------------------ setup screen (M4 setup flow)
const GEN_DEFAULT = 'random';
let seats = [{ name: 'Vidi', controller: 'human', general: GEN_DEFAULT, start: '' }, { name: 'Marcus (AI)', controller: 'ai', general: GEN_DEFAULT, start: '' }];
const SEAT_COLORS = ['#c0392b', '#2471a3', '#2e8b57'], SEAT_COLOR_NAMES = ['red', 'blue', 'green'];
let pickSeat = 0;   // which seat picks its start on the map (Selected starts)
let rollOff = null; // Q110: Selected starts roll off first: {seed, n, order: seat indexes in turn order, rolls} (G.rollOffPreview), null = not rolled
// M12: an online game's seed gets a secret 128-bit salt, so a guest cannot find it by trying seeds against the public dice
// (the seed field holds a short number; the room code is known to every guest).
const seedNow = () => ($('#seed').value.trim() || 'game') + (NET?.role === 'host' && NET.salt ? '#' + NET.salt : '');
/** Q110: the pick order, reverse turn order (the last to move picks first); [] before the roll-off. */
const pickOrder = () => (rollOff && rollOff.n === seats.length && rollOff.seed === seedNow() ? [...rollOff.order].reverse() : []);
const decided = x => !!x.start || !!x.skip;
/** May seat i pick now? Only once the roll-off is done and every seat before it in the pick order has picked (or left it Random). */
const mayPick = i => { const o = pickOrder(); const k = o.indexOf(i); return k >= 0 && o.slice(0, k).every(j => decided(seats[j])); };
const nextPicker = () => pickOrder().find(j => !decided(seats[j])) ?? null;
/** Q110: the roll-off is for this seed and seat count only; changing either rolls again (and clears the picks made in the old order). */
function resetRollOff() { if (!rollOff) return; rollOff = null; seats.forEach(x => { x.start = ''; x.skip = false; }); }
let genSeat = 0;    // which seat a click on a general card gives the general to (M8.1)
const setSeatCount = n => { if (n !== seats.length) resetRollOff(); while (seats.length < n) seats.push({ name: 'Livia (AI)', controller: 'ai', general: GEN_DEFAULT, start: '' }); while (seats.length > n) seats.pop(); pickSeat = Math.min(pickSeat, n - 1); genSeat = Math.min(genSeat, n - 1); renderSetup(); };
/** Why `id` cannot be seat i's start, with the picks of the seats before it in the pick order (Q110; the engine's validateSetup decides): null when it can. */
function startWhy(i, id) {
  const o = pickOrder(); const before = o.length ? o.slice(0, o.indexOf(i)) : seats.map((_, j) => j).filter(j => j !== i);
  // the earlier picks first and seat i last, so a clash is reported against seat i (validateSetup checks the seats in this order)
  const list = [...before, i, ...seats.map((_, j) => j).filter(j => j !== i && !before.includes(j))];
  const r = checkSetup(data, list.map(j => ({ name: 'x', controller: seats[j].controller === 'remote' ? 'human' : seats[j].controller, general: 'random', startProvince: j === i ? id : before.includes(j) ? seats[j].start : '' })), 'selected');
  const me = list.indexOf(i);
  const e = r.errors.find(x => x.seat === me && x.field === 'startProvince') ?? r.errors.find(x => x.seat === null && x.field === 'startProvince');
  return e ? e.message : null;
}
function renderSetup() {
  document.body.className = 'screen-setup'; document.body.dataset.screen = 'setup'; applyTabsHidden(); renderNetBanner();
  const ch = setupChoices(data); const mode = $('#startMode').value; const sel = mode === 'selected';
  const toggle = (i, v, label) => `<button type="button" class="segb ctl${seats[i].controller === v ? ' on' : ''}" data-seat="${i}" data-ctl="${v}" aria-pressed="${seats[i].controller === v}">${label}</button>`;
  const hosting = playWhere === 'host';
  if (!hosting) seats.forEach(x => { if (x.controller === 'remote') x.controller = 'human'; });
  renderOnline();
  const genOpts = i => `<option value="random" ${seats[i].general === 'random' ? 'selected' : ''}>Random general</option>` + ch.generals.map(g => {
    const by = seats.findIndex((x, j) => j !== i && x.general === g.id);
    return `<option value="${g.id}" ${seats[i].general === g.id ? 'selected' : ''} ${by >= 0 ? 'disabled' : ''}>${esc(g.name)}${by >= 0 ? ` (taken by ${esc(seats[by].name)})` : ''}</option>`;
  }).join('');
  const po = pickOrder();
  const startCell = i => { const may = mayPick(i); const k = po.indexOf(i);
    return `<td class="st"><button type="button" class="btn sm pickbtn${pickSeat === i && may ? ' on' : ''}" data-pick="${i}" ${may ? '' : 'disabled'} title="${!po.length ? 'Roll for turn order first (Q110)' : may ? `Pick this seat's start on the map (pick ${k + 1} of ${po.length})` : `Waits for the seats before it in the pick order`}">${po.length ? `<span class="pk">${k + 1}.</span> ` : ''}${seats[i].start ? '📍 ' + esc(prov(seats[i].start)) : '🎲 Random'}</button>
      <select name="start${i}" title="Fallback: choose from a list" ${may ? '' : 'disabled'}><option value="">Random for this seat</option>${ch.starts.map(x => { const why = x.id === seats[i].start ? null : startWhy(i, x.id); return `<option value="${x.id}" ${seats[i].start === x.id ? 'selected' : ''} ${why ? 'disabled' : ''}>${esc(x.name)}${why ? ' (not possible)' : ''}</option>`; }).join('')}</select></td>`; };
  $('#seats').innerHTML = `<tr><th></th><th>Name</th><th>Played by</th><th>General</th>${sel ? '<th>Start province</th>' : ''}</tr>` + seats.map((x, i) => `<tr class="seat" data-seat="${i}">
    <td><span class="sw" style="background:${SEAT_COLORS[i]}" title="${SEAT_COLOR_NAMES[i]}"></span></td>
    <td>${x.controller === 'remote' ? `<input name="name${i}" value="${attr(remoteName(i))}" size="12" readonly class="remote${remoteName(i) ? ' joined' : ''}" placeholder="waiting for a player…" aria-label="Seat ${i + 1}: online player">` : `<input name="name${i}" value="${attr(x.name)}" size="12" aria-label="Seat ${i + 1} name">`}</td>
    <td><span class="seg">${hosting ? toggle(i, 'human', 'You') + toggle(i, 'remote', 'Online') : toggle(i, 'human', 'Human')}${toggle(i, 'ai', 'AI')}</span></td>
    <td class="gcell"><select name="gen${i}" aria-label="Seat ${i + 1} general">${genOpts(i)}</select><button type="button" class="btn sm genseat${genSeat === i ? ' on' : ''}" data-genseat="${i}" title="Choose ${attr(x.name)}'s general from the cards below" aria-pressed="${genSeat === i}">🂠 cards</button></td>
    ${sel ? startCell(i) : ''}</tr>`).join('');
  $$('#seats input:not([readonly]), #seats select').forEach(el => el.oninput = el.onchange = () => {
    const i = +el.name.replace(/\D/g, ''); const k = el.name.replace(/\d/g, '');
    if (k === 'start') { setStart(i, el.value); return; }
    seats[i][{ name: 'name', gen: 'general' }[k]] = el.value;
    if (k === 'name') { validate(); if (sel) renderStartPick(); } else renderSetup();
  });
  $$('#seats .ctl').forEach(b => b.onclick = () => {
    const i = +b.dataset.seat; seats[i].controller = b.dataset.ctl;
    if (hosting && b.dataset.ctl === 'human') seats.forEach((y, j) => { if (j !== i && y.controller === 'human') y.controller = 'remote'; });   // one seat is You
    renderSetup();
  });
  $$('#seats .pickbtn').forEach(b => b.onclick = () => { if (!mayPick(+b.dataset.pick)) return; pickSeat = +b.dataset.pick; renderSetup(); });
  $$('#seats .genseat').forEach(b => b.onclick = () => { genSeat = +b.dataset.genseat; renderSetup(); });
  $$('#seats select[name^=gen]').forEach(el => el.addEventListener('focus', () => { const i = +el.name.slice(3); if (genSeat !== i) { genSeat = i; renderGenRow(); $$('#seats .genseat').forEach(b => { const on = +b.dataset.genseat === i; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); } }));
  renderGenRow();
  $('#pCountTxt').textContent = `Players: ${seats.length}`;
  $$('#pCount .segb').forEach(b => { const on = +b.dataset.n === seats.length; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  $('#addSeat').hidden = seats.length >= 3; $('#delSeat').hidden = seats.length <= 2;
  $('#startPick').hidden = !sel; $('.setupcard').classList.toggle('wide', sel);
  if (sel) renderStartPick();
  if (!$('#seed').value) $('#seed').value = 'g' + Math.floor(Math.random() * 1e6);
  let auto = null; try { auto = localStorage.getItem('imperator.autosave'); } catch { /* */ }
  $('#resumeAuto').hidden = !auto;
  const on = onlineSave(auto);   // M14: the autosave of an online game this browser hosted
  $('#resumeOnline').hidden = !on || playWhere === 'join';
  if (on) $('#resumeOnline').textContent = `🌐 Resume online game (room ${on.online.code}, turn ${on.snapshot?.turn?.number ?? 0})`;
  validate();
}
/** M8.1 (Vidi 2026-10-22): the four General cards on the setup screen. A click gives the general to the seat marked "🂠 cards" (any seat,
 * Human or AI); ⓘ opens the full card and every perk in detail (text from data/generals.json via G.generalView). */
function renderGenRow() {
  const i = genSeat; const x = seats[i];
  $('#genHead').innerHTML = `<b>Generals</b> · click a card to give it to <span class="sw" style="background:${SEAT_COLORS[i]}"></span> <b>${esc(x.name || 'Seat ' + (i + 1))}</b> · ⓘ shows every perk in detail`;
  $('#genThumbs').innerHTML = data.generals.map(g => {
    const by = seats.findIndex(y => y.general === g.id);
    const why = by >= 0 && by !== i ? `${g.name} is taken by ${seats[by].name}` : null;
    return `<div class="gthumb${by === i ? ' mine' : ''}${why ? ' taken' : ''}" data-gen="${g.id}" style="${by >= 0 ? `--sc:${SEAT_COLORS[by]}` : ''}">
      <button type="button" class="gpick" data-gen="${g.id}" title="${attr(why ?? `Give ${g.name} to ${x.name}: ${g.text}`)}"><img src="${img('general.' + g.id)}" alt="${attr(g.name)} card"><b>${esc(g.name)}</b><small>${esc(G.generalCaption(data, g.id))}</small></button>
      ${by >= 0 ? `<span class="gby">${esc(seats[by].name)}</span>` : ''}<button type="button" class="gview" data-view="${g.id}" title="${attr(g.name)}: the full card and every perk" aria-label="View ${attr(g.name)}">ⓘ</button></div>`;
  }).join('');
  $$('#genThumbs .gpick').forEach(b => b.onclick = () => pickGeneral(genSeat, b.dataset.gen));
  $$('#genThumbs .gpick').forEach(b => b.onmouseenter = () => { const g = data.generalsById[b.dataset.gen]; $('#genHint').textContent = `${g.name}: ${g.text}`; });
  $$('#genThumbs .gview').forEach(b => b.onclick = () => openGeneralView(b.dataset.view, { setup: true }));
}
function pickGeneral(i, id) {
  const by = seats.findIndex((y, j) => j !== i && y.general === id);
  if (by >= 0) { SND.play('error_denied'); toast(`${data.generalsById[id].name} is taken by ${seats[by].name}: choose another or change ${seats[by].name}'s first`); return false; }
  seats[i].general = id; SND.play('card_flip');
  const next = seats.findIndex((y, j) => j > i && y.general === 'random'); if (next >= 0) genSeat = next;
  renderSetup(); return true;
}
/** The general view: the full card art and every perk (what it does, when, the numbers and the rules.md labels). Leaves the text column open for a footer. */
function generalViewHtml(id) {
  const v = G.generalView(data, id); const ln = l => `<li>${esc(l.text)} <span class="rref">(${esc(l.rules)})</span></li>`;
  return `<div class="cardbig"><img src="${img('general.' + id)}" alt="${attr(v.name)} card"></div><div class="txt gvtxt" id="genView" data-gen="${id}">
    <h2>${esc(v.name)} <small>· ${esc(v.title)}</small></h2><p class="quote">“${esc(v.quote)}” <span class="rref">(${esc(v.rules)})</span></p>
    ${v.intro.length ? `<ul class="gvintro">${v.intro.map(ln).join('')}</ul>` : ''}
    ${v.perks.map(p => `<section class="gvperk" data-perk="${p.id}"><h3>${esc(p.name)}</h3><p class="when">When: ${esc(p.when)}</p><ul>${p.detail.map(ln).join('')}</ul></section>`).join('')}
    <details class="gvcommon"><summary>Rules for every general</summary><ul>${v.common.map(ln).join('')}</ul></details>
    <p class="small artnote">The text printed on the card art can be older than the rules; the text here is the current rules (rules.md, Q51).</p>`;
}
function openGeneralView(id, { setup = false, player = null } = {}) {
  SND.play('card_flip');
  let foot = '';
  if (setup) foot = `<div class="gvfoot">${seats.map((x, i) => { const by = seats.findIndex((y, j) => j !== i && y.general === id); const mine = x.general === id;
    return `<button type="button" class="btn sm ${mine ? 'gold' : ''}" data-give="${i}" ${by >= 0 ? `disabled title="taken by ${attr(seats[by].name)}"` : ''}><span class="sw" style="background:${SEAT_COLORS[i]}"></span> ${mine ? '✓ ' : ''}${esc(x.name)}${x.controller === 'ai' && !/\(AI\)/.test(x.name) ? ' (AI)' : ''}</button>`; }).join('')}</div>`;
  else if (player) foot = `<p class="small">${esc(player.name)}'s general${player.general?.at ? ', now in ' + esc(prov(player.general.at)) : ''}.</p>`;
  openModal(generalViewHtml(id) + `${setup ? '<p class="small">Give this general to:</p>' : ''}${foot}<button class="btn gold" data-close>Close</button></div>`, { cls: 'genview' });
  $$('#modalBox [data-give]').forEach(b => b.onclick = () => { if (pickGeneral(+b.dataset.give, id)) closeModal(); });
}
/**
 * The start-province map picker (M8 item 6, Q110): first the roll-off (the engine's, shown with every die), then each seat clicks its start in
 * REVERSE turn order (the last to move picks first); impossible provinces are greyed with the rule's reason.
 */
function setStart(i, id) {
  seats[i].start = id; seats[i].skip = !id;
  const o = pickOrder(); for (const j of o.slice(o.indexOf(i) + 1)) if (seats[j].start && startWhy(j, seats[j].start)) { seats[j].start = ''; seats[j].skip = false; }   // a later pick this one rules out
  const nx = nextPicker(); if (nx !== null) pickSeat = nx;
  renderSetup();
}
function rollOffHtml() {
  if (!rollOff) return '';
  const nm = j => esc(seats[j].name || 'Seat ' + (j + 1)); const sw = j => `<span class="sw" style="background:${SEAT_COLORS[j]}"></span>`;
  return `<b>Roll-off</b> (one d10 each, highest goes first, ties roll again, 4.b): ${seats.map((x, j) => `${sw(j)} ${nm(j)} <span class="ro-die" data-seat="${j}">${rollOff.rolls[j].join(' → ')}</span>`).join(' · ')}<br>
    <b>Turn order:</b> <span id="roOrder">${rollOff.order.map((j, k) => `${k + 1}. ${sw(j)} ${nm(j)}`).join(' &nbsp;')}</span> · <b>Picks</b> in reverse: <span id="roPicks">${pickOrder().map(nm).join(' → ')}</span>`;
}
function renderStartPick() {
  const sp = data.map.map.tokenSpace; const po = pickOrder();
  if (rollOff && !po.length) resetRollOff();   // seed or seat count changed
  $('#spRollRes').innerHTML = rollOffHtml(); $('#spRollRes').hidden = !rollOff;
  if (!rollOff) {
    $('#spHead').innerHTML = `<b>Step 1:</b> roll for turn order. The last to move picks first. <button type="button" class="btn sm gold" id="spRoll">🎲 Roll for turn order</button>`;
    $('#spTokens').innerHTML = data.provinceIds.map(id => { const t = data.provincesById[id].token; const why = 'Roll for turn order first: the seats pick in reverse turn order (Q110).';
      return `<button type="button" class="sptok bad wait" data-id="${id}" data-why="${attr(why)}" title="${attr(why)}" style="left:${t.x / sp.w * 100}%;top:${t.y / sp.h * 100}%">${esc(prov(id))}</button>`; }).join('');
    $('#spRoll').onclick = () => { rollOff = G.rollOffPreview(data, { seed: seedNow(), n: seats.length }); seats.forEach(x => { x.start = ''; x.skip = false; }); pickSeat = nextPicker() ?? 0; SND.play('dice_land'); renderSetup(); };
    $$('#spTokens .sptok').forEach(b => b.onclick = () => { $('#spWhy').textContent = b.dataset.why; $('#spWhy').classList.add('bad'); SND.play('error_denied'); });
    return;
  }
  if (!mayPick(pickSeat)) pickSeat = nextPicker() ?? po[po.length - 1];
  const i = pickSeat; const x = seats[i]; const k = po.indexOf(i);
  $('#spHead').innerHTML = `<span class="sw" style="background:${SEAT_COLORS[i]}"></span> <b>${esc(x.name || 'Seat ' + (i + 1))}</b> (${SEAT_COLOR_NAMES[i]}, pick ${k + 1} of ${po.length}), click your start province · <button type="button" class="btn sm" id="spRandom">🎲 Random for this seat</button>`;
  const owner = id => seats.findIndex(y => y.start === id);
  $('#spTokens').innerHTML = data.provinceIds.map(id => {
    const t = data.provincesById[id].token; const o = owner(id); const why = !data.provincesById[id].startingEligible ? startWhy(i, id) : o >= 0 && o !== i ? `${prov(id)} is already ${seats[o].name}'s start.` : o === i ? null : startWhy(i, id);
    const cls = o >= 0 ? ' taken' : why ? ' bad' : ' ok';
    return `<button type="button" class="sptok${cls}" data-id="${id}" data-why="${attr(why ?? '')}" title="${attr(why ?? `Start ${x.name} in ${prov(id)}`)}" style="left:${t.x / sp.w * 100}%;top:${t.y / sp.h * 100}%;${o >= 0 ? `--sc:${SEAT_COLORS[o]}` : ''}">${esc(prov(id))}${o >= 0 ? `<small>${esc(seats[o].name)}</small>` : ''}</button>`;
  }).join('');
  $$('#spTokens .sptok').forEach(b => b.onclick = () => {
    const id = b.dataset.id;
    if (b.dataset.why) { $('#spWhy').textContent = b.dataset.why; $('#spWhy').classList.add('bad'); SND.play('error_denied'); return; }
    SND.play('province_select');
    $('#spWhy').textContent = 'Greyed provinces cannot be this seat\'s start (hover or click one to see why).'; $('#spWhy').classList.remove('bad');
    setStart(i, seats[i].start === id ? '' : id);
  });
  $$('#spTokens .sptok.bad').forEach(b => b.onmouseenter = () => { $('#spWhy').textContent = b.dataset.why; });
  $('#spRandom').onclick = () => setStart(i, '');
}
function validate() {
  const mode = $('#startMode').value;
  const r = checkSetup(data, engineSeats().map(x => ({ ...x, startProvince: mode === 'selected' ? x.startProvince : undefined })), mode);
  $('#setupErrors').textContent = r.ok ? '' : r.errors.map(e => (e.seat !== null ? `Seat ${e.seat + 1}: ` : '') + e.message).join('\n');
  if (playWhere === 'host') syncRoom();
  const net = playWhere === 'host' ? hostReadiness() : null;
  if (net) $('#hostWhy').textContent = net.why ?? '';
  const ok = r.ok && (!net || net.ok) && playWhere !== 'join';
  $('#startGame').disabled = !ok; return ok;
}
/** The seats as the engine gets them: an Online seat is a 'human' controller named after its guest (M11). */
const remoteName = i => NET?.role === 'host' ? NET.room.seats[i]?.name ?? '' : '';
const engineSeats = () => seats.map((x, i) => ({ name: x.controller === 'remote' ? (remoteName(i) || `Guest ${i + 1}`) : x.name.trim(), controller: x.controller === 'remote' ? 'human' : x.controller, general: x.general, startProvince: x.start || undefined }));
function startGame() {
  if (!validate()) return;
  const mode = $('#startMode').value;
  try {
    S = G.newSession(data, { seed: seedNow(), mode, seats: engineSeats().map(x => ({ ...x, startProvince: mode === 'selected' ? x.startProvince : undefined })) });
    if (mode === 'selected' && pickOrder().length) S = G.playRollOff(S);   // Q110: already rolled on the setup screen (same seed, same dice): not asked again
  } catch (e) { $('#setupErrors').textContent = e.message; return; }
  if (NET?.role === 'host') { NET.me = G.stateOf(S).players[seats.findIndex(x => x.controller === 'human')].id; NET.room.start(G.stateOf(S).players.map(p => p.id)); }
  SND.play('deck_shuffle'); enterGame();
}
function enterGame() {
  $('#toast').classList.remove('on');
  document.body.className = 'screen-game'; document.body.dataset.screen = 'game'; applyTabsHidden();
  closeBattlePop(); closeModal();
  viewer = null; for (const k of Object.keys(news)) delete news[k]; ab = null; bv = null; lastRoll = {}; overShown = false; aiPaused = false; selected = null; busy = false;
  $('#ovOver').classList.remove('on'); clearBattle(); setTab('table');
  document.body.dataset.online = NET ? NET.role : '';
  if (NET?.role === 'host') netPush();
  autosave(); render(); schedule();
}

// ------------------------------------------------------------------ M11: online play (host and join by room code; src/net/*)
// The host's page runs the engine and is the only one that rolls dice; guests send moves and render the views the host sends.
let NET = null;            // host: {role, code, transport, room, me, inbox}; guest: {role, code, transport, client, me, q, pending}
let playWhere = 'local';   // setup screen: 'local' (this computer) | 'host' | 'join'
const netMode = () => new URLSearchParams(location.search).get('net');   // 'local' = BroadcastChannel between tabs (tests, no network)
let peerLib = null;
function loadPeer() {
  if (window.peerjs?.Peer) return Promise.resolve(window.peerjs.Peer);
  return peerLib ??= new Promise((res, rej) => {
    let u = 'src/vendor/peerjs.min.js'; try { u = import.meta.resolve('../../vendor/peerjs.min.js'); } catch { /* */ }
    const sc = document.createElement('script'); sc.src = u;
    sc.onload = () => (window.peerjs?.Peer ? res(window.peerjs.Peer) : rej(new Error('The online module did not load.')));
    sc.onerror = () => { peerLib = null; rej(new Error('Could not load the online module (src/vendor/peerjs.min.js).')); };
    document.head.append(sc);
  });
}
async function makeTransport() { return netMode() === 'local' ? createBroadcastTransport() : createPeerTransport(await loadPeer()); }
const joinLink = (code, was = null) => `${location.origin}${location.pathname}?join=${code}${was ? '&was=' + was : ''}${netMode() ? '&net=' + netMode() : ''}`;
const SEAT_TOKEN_KEY = 'imperator.online.seat';
let joinWas = '';   // M14: ?was=OLD in a join link: the host resumed the game under a new code
const newSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

function setPlayWhere(w) {
  if (w === playWhere) return;
  SND.play('button_click');
  if (playWhere === 'host' || playWhere === 'join') netLeave();
  playWhere = w;
  if (w === 'host') {
    if (!seats.some(x => x.controller === 'human')) seats[0].controller = 'human';
    let you = false; seats.forEach(x => { if (x.controller === 'human') { if (you) x.controller = 'remote'; you = true; } });
    if (!seats.some(x => x.controller === 'remote')) { const j = seats.findIndex(x => x.controller !== 'human'); seats[j >= 0 ? j : 1].controller = 'remote'; }
    openHost();
  }
  renderSetup();
}
function renderOnline() {
  $$('#playWhere .segb').forEach(b => { const on = b.dataset.where === playWhere; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const card = $('.setupcard'); card.classList.toggle('joining', playWhere === 'join'); card.classList.toggle('hosting', playWhere === 'host');
  $('#hostBox').hidden = playWhere !== 'host'; $('#joinBox').hidden = playWhere !== 'join';
  $('#startGame').hidden = playWhere === 'join';
  document.body.dataset.joining = playWhere === 'join' ? '1' : '';   // M14: no Save / Load in the top bar while joining (a guest has nothing to save)
  if (playWhere === 'host') {
    seats.forEach((x, i) => { if (x.controller === 'remote') x.name = remoteName(i) || `Online ${i + 1}`; });
    const code = NET?.role === 'host' ? NET.code : null;
    $('#hostCode').textContent = code ?? '…'; $('#hostLink').value = code ? joinLink(code) : ''; $('#hostCopy').disabled = !code;
    syncRoom();
  }
}
const syncRoom = () => { if (NET?.role === 'host' && document.body.dataset.screen === 'setup') NET.room.configure(seats.map(x => ({ kind: x.controller === 'remote' ? 'remote' : x.controller === 'ai' ? 'ai' : 'local', name: x.name.trim() || 'Host' }))); };
/** Can the host start? Every Online seat needs its player (connected), and exactly one seat is the host's own. */
function hostReadiness() {
  if (NET?.role !== 'host') return { ok: false, why: $('#hostStatus').dataset.err ? '' : 'Opening the room…' };
  if (seats.filter(x => x.controller === 'human').length !== 1) return { ok: false, why: 'Mark exactly one seat as You (this computer).' };
  if (!seats.some(x => x.controller === 'remote')) return { ok: false, why: 'Mark at least one seat as Online, or play on this computer instead.' };
  const wait = NET.room.seats.filter(x => x.kind === 'remote' && !(x.token && x.connected)).length;
  return wait ? { ok: false, why: `Waiting for ${wait} player${wait > 1 ? 's' : ''} to join: send them the code ${NET.code} or the link.` } : { ok: true, why: 'Everyone is here: press Start game.' };
}
async function openHost() {
  const st0 = $('#hostStatus'); st0.textContent = 'Opening a room…'; st0.dataset.err = '';
  let lastErr = null;
  for (let k = 0; k < 4 && playWhere === 'host' && !NET; k++) {
    const code = roomCode();
    let t; try { t = await makeTransport(); await t.open({ role: 'host', code }); }
    catch (e) { lastErr = e; try { t?.close(); } catch { /* */ } if (e.code === 'ROOM_TAKEN') continue; break; }
    if (playWhere !== 'host') { t.close(); return; }
    hostNet(t, code, newSalt());
    st0.textContent = 'Room open. Send the code or the link to the other players; they choose "Join with a code".';
    renderSetup(); return;
  }
  if (!NET && playWhere === 'host') { st0.textContent = lastErr?.message ?? 'Could not open a room.'; st0.dataset.err = '1'; validate(); }
}
function hostNet(t, code, salt) {
  NET = { role: 'host', code, transport: t, me: null, inbox: [], salt };
  NET.room = new HostRoom({ transport: t, build: uiLabel, code, seats: [], data, hooks: {
    onSeat: () => queueMicrotask(() => { if (!NET) return; if (document.body.dataset.screen === 'setup') renderSetup(); else if (S) { render(); autosave(); } }),
    onAct: (i, action, reply) => { NET.inbox.push({ action, reply }); if (!busy) hostDrain(); },
  } });
  NET.ping = setInterval(() => { if (!NET?.quiet) NET?.room?.tick(); }, PING_MS);   // quiet: tests only (a host that stops answering)
  return NET;
}
/** M14: an autosave (or save file) of an online game this browser hosted: it has the room (code, seats, guest tokens). */
function onlineSave(text) { try { const o = typeof text === 'string' ? JSON.parse(text) : text; return o?.online?.room?.seats && o.snapshot?.phase !== 'finished' ? o : null; } catch { return null; } }
/** M14: "Resume online game": the host reopens its room from a save, under the same code if it is free (else a new one, with a link),
 *  restores the seats and their tokens, and the guests' pages reconnect to their seats by themselves. */
async function resumeOnline(obj) {
  const show = m => { const el = $('#ldErr') ?? $('#setupErrors'); if (el) el.textContent = m; else toast(m); };
  let ns; try { ns = G.readSave(obj, data); } catch (e) { show(e.message); return false; }
  const on = obj.online; netLeave(); clearTimeout(aiTimer);
  playWhere = 'host'; show('Reopening the room…');
  let t = null, code = null, err = null;
  for (let k = 0; k < 5 && !t; k++) {
    const c = k === 0 ? on.code : roomCode();
    let x; try { x = await makeTransport(); await x.open({ role: 'host', code: c }); t = x; code = c; }
    catch (e) { err = e; try { x?.close(); } catch { /* */ } if (e.code !== 'ROOM_TAKEN') break; }
  }
  if (!t) { playWhere = 'local'; show('Could not reopen the room: ' + (err?.message ?? 'no network')); renderSetup(); return false; }
  hostNet(t, code, on.salt ?? newSalt());
  NET.room.restore({ ...on.room, code }); NET.me = on.me;
  S = ns; closeModal(); enterGame();
  if (code === on.code) toast(`Online game resumed: room ${code}. Your friends' pages reconnect by themselves.`);
  else openModal(`<div class="ask" id="resumedNew"><h2>Resumed under a new code</h2><p>The old room code <b>${esc(on.code)}</b> is taken, so the game is open under <b class="roomcode" id="resumedCode">${esc(code)}</b>.</p>
    <p>Send this link to your friends (their seats are kept; a page still trying the old code can also type the new one):</p><p><input id="resumedLink" readonly size="52" value="${attr(joinLink(code, on.code))}"> <button class="btn sm" id="resumedCopy">Copy link</button></p><button class="btn gold" data-close>OK</button></div>`);
  if ($('#resumedCopy')) $('#resumedCopy').onclick = () => navigator.clipboard?.writeText($('#resumedLink').value).then(() => toast('Link copied'), () => $('#resumedLink').select());
  return true;
}
/** One guest move at a time, when the host's page is not busy animating (they queue meanwhile). */
async function hostDrain() {
  if (NET?.role !== 'host' || busy || !S || !NET.inbox.length) return;
  const { action, reply } = NET.inbox.shift();
  await apply(action, { remote: reply });
  if (NET?.inbox.length && !busy) hostDrain();
}
/** After each step on the host: every guest gets its view and its legal moves. */
function netPush() {
  if (NET?.role !== 'host' || !S) return;
  const c = current(S); NET.room.update({ seq: S.steps.length, state: c.state, events: c.events ?? [], by: c.action?.playerId ?? null });
}
/** The host's "→ AI" button: a dropped or away player's seat is played by the AI from now on. */
function seatToAI(i) {
  if (NET?.role !== 'host' || !S) return;
  const s = st(); const pid = s.players[i]?.id; const nm = s.players[i]?.name;
  if (!window.confirm(`Give ${nm}'s seat to the AI? (You can give it back when ${nm} is connected again.)`)) return;
  if (!NET.room.seatToAI(i)) return;
  const c = current(S);
  S = { ...S, steps: [...S.steps.slice(0, -1), { ...c, state: { ...c.state, players: c.state.players.map(p => (p.id === pid ? { ...p, controller: 'ai' } : p)) } }] };
  NET.room.update({ seq: S.steps.length, state: full(), events: [], by: null });
  toast(`${nm} is now played by the AI`); autosave(); render(); schedule();
}
/** M14: the reverse: a seat the AI took over goes back to its friend, who is connected again. */
function seatBack(i) {
  if (NET?.role !== 'host' || !S) return;
  const s = st(); const pid = s.players[i]?.id; const nm = s.players[i]?.name;
  if (!NET.room.seatBack(i)) { toast(`${nm} is not connected: the seat stays with the AI`); return; }
  const c = current(S);
  S = { ...S, steps: [...S.steps.slice(0, -1), { ...c, state: { ...c.state, players: c.state.players.map(p => (p.id === pid ? { ...p, controller: 'human' } : p)) } }] };
  NET.room.update({ seq: S.steps.length, state: full(), events: [], by: null });
  toast(`${nm} plays their seat again`); autosave(); render(); schedule();
}
function netBadge(pid) {
  if (!NET || !S) return '';
  const i = st().players.findIndex(p => p.id === pid);
  if (pid === NET.me) return '<span class="netst you" title="This computer">you</span>';
  const seat = NET.role === 'host' ? NET.room.seats[i] : NET.client.lobby?.seats?.[i];
  if (seat?.kind === 'ai' && (seat.token || seat.returnable)) {   // M14: a guest's seat the AI plays for now
    const on = NET.role === 'host' ? !!(seat.connected && seat.peer) : !!seat.guestConnected;
    return `<span class="netst ${on ? 'on' : 'away'}" title="The AI plays this seat for now; its player is ${on ? 'connected' : 'not connected'}">AI · ${on ? 'player online' : 'player away'}</span>`
      + (NET.role === 'host' && st().phase !== 'finished' && on ? `<button type="button" class="btn sm toai back" data-seatback="${i}" title="Give the seat back to its player">← back</button>` : '');
  }
  if (!seat || seat.kind !== 'remote') return seat?.kind === 'local' ? '<span class="netst host" title="The host plays this seat">host</span>' : '';
  const on = seat.connected;
  return `<span class="netst ${on ? 'on' : 'away'}" title="${on ? 'Connected' : 'Not connected (or not answering)'}">● ${on ? 'online' : 'away'}</span>`
    + (NET.role === 'host' && st().phase !== 'finished' ? `<button type="button" class="btn sm toai" data-toai="${i}" title="Let the AI play this seat (you can give it back later)">→ AI</button>` : '');
}
function netLeave() {
  if (!NET) return;
  const n = NET; NET = null; clearInterval(n.ping); renderNetBanner();
  // M14: HOST_LEFT lets the guests wait and reconnect (the host may resume from its save); a finished game says GAME_OVER (final)
  try { if (n.role === 'host') n.room.close(S && G.stateOf(S).phase === 'finished' ? 'GAME_OVER' : 'HOST_LEFT'); else n.client.leave(); } catch (e) { console.warn('leave', e); }
  document.body.dataset.online = '';
}

// guest side
async function joinGame() {
  const code = normCode($('#joinCode').value); const name = $('#joinName').value.trim().slice(0, 20);
  const say = (m, bad = false) => { $('#joinStatus').textContent = m; $('#joinStatus').classList.toggle('bad', bad); };
  if (code.length < 4) { say('Type the room code the host sent you (6 letters/digits).', true); return; }
  if (!name) { say('Type your name first.', true); $('#joinName').focus(); return; }
  try { localStorage.setItem('imperator.online.name', name); } catch { /* */ }
  netLeave(); say('Connecting…'); $('#joinGo').disabled = true;
  let saved = null; try { saved = JSON.parse(localStorage.getItem(SEAT_TOKEN_KEY) || 'null'); } catch { /* */ }
  const mine = saved && (saved.code === code || (joinWas && saved.code === joinWas));   // M14: ?was=OLD: the same game under a new code
  let t; try { t = await makeTransport(); } catch (e) { say(e.message, true); $('#joinGo').disabled = false; return; }
  const n = { role: 'guest', code, transport: t, me: null, q: [], pending: false };
  const inGame = () => S && document.body.dataset.screen === 'game';
  n.client = new GuestClient({ transport: t, makeTransport, build: uiLabel, name, token: mine ? saved.token : null, data, hooks: {
    onWelcome: (c, m) => { n.code = c.code; n.pending = false; try { localStorage.setItem(SEAT_TOKEN_KEY, JSON.stringify({ code: c.code, token: m.token, seat: m.seat, at: Date.now() })); } catch { /* */ }
      if (!inGame()) say(`Joined room ${c.code} as ${m.name} (seat ${m.seat + 1}, ${SEAT_COLOR_NAMES[m.seat]}). Waiting for the host to start…`); },
    onLobby: (c, m) => { if (NET === n) renderGuestLobby(m); if (S && NET === n) render(); },
    onUpdate: (c, u) => { if (NET !== n) return; n.me = u.you.playerId; n.q.push(u); if (!inGame()) { guestEnter(); } else guestDrain(); },
    onReject: (c, m) => { if (NET !== n) return;
      if (!inGame()) { say(m.message, true); return; }
      n.pending = false; if (m.code !== 'STALE') { SND.play('error_denied'); toast(m.message); } render(); },
    onBye: (c, r) => { if (NET !== n) return;
      if (r === 'HOST_LEFT' && !c.ended) return;   // M14: not final: the host may resume the game; the client reconnects (onStatus)
      if (r === 'BUILD_MISMATCH' || r === 'FULL' || r === 'STARTED') { $('#joinGo').disabled = false; netLeave(); return; }
      if (r === 'GAME_OVER' && inGame()) { n.lost = 'The game is over; the host closed the room.'; renderNetBanner(); return; }
      netLost(r === 'SEAT_REMOVED' ? 'The host removed your seat.' : r === 'REPLACED' ? 'You joined this game from another tab; this tab is disconnected.' : 'The host ended the connection.'); },
    onHostGone: () => { if (NET === n) netLost('Lost the connection to the host.'); },
    onStatus: (c, status, info) => { if (NET !== n) return;
      n.status = status; n.info = info; (n.statuses ??= []).push(status + (info.why ? ':' + info.why : ''));
      if (status === 'reconnecting' || status === 'lost') n.pending = false;
      if (status === 'connected' && info.rejoined) { if (inGame()) toast('Reconnected: you are back in your seat'); else say(`Reconnected to room ${c.code}.`); }
      if (!inGame() && status === 'reconnecting') say(`Lost the host (${whyText(info.why)}). Reconnecting… (try ${info.attempt} of ${info.of})`, true);
      if (!inGame() && status === 'lost') { say('Could not reach the host. Press Join to try again.', true); $('#joinGo').disabled = false; netLeave(); return; }
      renderNetBanner(); if (inGame()) render(); },
  } });
  NET = n;
  n.ping = setInterval(() => n.client.tick(), 2000);
  try { await n.client.join(code); } catch (e) { if (NET === n) netLeave(); say(e.message, true); $('#joinGo').disabled = false; return; }
}
const whyText = w => ({ LINK_LOST: 'the link dropped', HOST_LEFT: 'the host left the game', NO_ROOM: 'the room is not open', NETWORK: 'network error', TIMEOUT: 'no answer', RETRY: 'retrying' })[w] ?? String(w ?? 'no link').toLowerCase().replace(/_/g, ' ');
/** M14: the online strip in the game: for the host, the room code and its link; for a guest, the link to the host (reconnecting,
 *  the host away, given up, or the seat played by the AI for now). body[data-net-status] is for tests. */
function renderNetBanner() {
  const el = $('#netBanner'); if (!el) return;
  const game = S && document.body.dataset.screen === 'game';
  if (!NET || !game) { el.hidden = true; el.innerHTML = ''; document.body.dataset.netStatus = ''; return; }
  if (NET.role === 'host') {
    const away = NET.room.seats.filter(x => x.token && !x.connected).map(x => x.name || 'a guest');
    document.body.dataset.netStatus = 'host';
    el.className = 'netbanner host'; el.hidden = false;
    el.innerHTML = `🌐 Room <b class="roomcode" id="nbRoom">${esc(NET.code)}</b> <button type="button" class="btn sm" id="nbCopy" title="${attr(joinLink(NET.code))}">Copy link</button>${away.length ? ` <span class="nbaway">${esc(away.join(', '))} ${away.length > 1 ? 'are' : 'is'} away</span>` : ''}`;
    $('#nbCopy').onclick = () => navigator.clipboard?.writeText(joinLink(NET.code)).then(() => toast('Link copied'), () => toast(joinLink(NET.code)));
    return;
  }
  const c = NET.client; const status = NET.lost ? 'ended' : c.status === 'connected' && c.hostAway ? 'hostAway' : c.status === 'connected' && c.ai ? 'ai' : c.status;
  document.body.dataset.netStatus = status;
  const i = NET.info ?? {};
  let html = '';
  if (status === 'reconnecting') html = `<span class="spin">⟳</span> <b>Reconnecting…</b> Lost the host (${esc(whyText(i.why))}). Try ${i.attempt} of ${i.of}, next in ${Math.max(1, Math.round((i.inMs ?? 0) / 1000))} s. Your seat is kept. <button type="button" class="btn sm" id="nbNow">Try now</button> <span class="small">new code?</span> <input id="nbCode" size="7" maxlength="16" placeholder="${attr(c.code)}" spellcheck="false" aria-label="A new room code from the host"> <button type="button" class="btn sm" id="nbLeave">Leave</button>`;
  else if (status === 'lost') html = `<b>Could not reach the host.</b> Your seat is kept: if the host resumed under a new code, type it: <input id="nbCode" size="8" maxlength="16" placeholder="${attr(c.code)}" spellcheck="false"> <button type="button" class="btn sm gold" id="nbNow">Try again</button> <button type="button" class="btn sm" id="nbLeave">Leave</button>`;
  else if (status === 'hostAway') html = `<b>The host is not answering</b> (away, or their tab is in the background) for ${Math.round(HOST_AWAY_MS / 1000)}+ s. Waiting… your seat is kept.`;
  else if (status === 'ai') html = `The host gave your seat to the <b>AI</b> for now. Stay on this page: the host can give it back to you.`;
  const typed = $('#nbCode')?.value ?? '', focused = document.activeElement?.id === 'nbCode';   // a re-render keeps a half-typed code
  el.hidden = !html; el.className = 'netbanner ' + status; el.innerHTML = html;
  if ($('#nbCode') && typed) { $('#nbCode').value = typed; if (focused) $('#nbCode').focus(); }
  if ($('#nbCode')) $('#nbCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nbNow')?.click(); });
  if ($('#nbNow')) $('#nbNow').onclick = () => { const v = normCode($('#nbCode')?.value || ''); c.retryNow(v.length >= 4 ? v : null); };
  if ($('#nbLeave')) $('#nbLeave').onclick = () => { if (window.confirm('Leave this online game?')) toSetup(); };
}
function renderGuestLobby(m) {
  const rows = (m.seats ?? []).map(x => `<li><span class="sw" style="background:${SEAT_COLORS[x.i]}"></span> <b>${esc(x.kind === 'remote' ? x.name || 'waiting for a player…' : x.name)}</b> <span class="small">${x.kind === 'local' ? '(host)' : x.kind === 'ai' ? '(AI)' : x.taken ? (x.connected ? '(online)' : '(away)') : ''}${NET?.client?.seat === x.i ? ' ← you' : ''}</span></li>`).join('');
  $('#guestLobby').innerHTML = rows ? `<b>Players</b><ul>${rows}</ul><p class="small">The host chooses the generals and the start provinces, then starts the game.</p>` : '';
}
function netLost(msg) {
  const n = NET; if (!n) return;
  if (!S || document.body.dataset.screen !== 'game') { $('#joinStatus').textContent = msg; $('#joinStatus').classList.add('bad'); $('#joinGo').disabled = false; NET = null; try { n.transport.close(); } catch { /* */ } return; }
  n.lost = msg; document.body.dataset.netLost = '1'; render();
  openModal(`<div class="ask" id="netLostBox"><h2>Disconnected</h2><p>${esc(msg)}</p><button class="btn gold" data-close>OK</button></div>`);
}
function guestEnter() {
  const u = NET.q.shift(); if (!u) return;
  S = { data, seed: 'room ' + NET.code, steps: [{ state: u.state, events: [], action: null, error: null, legal: u.legal }] };
  $('#joinGo').disabled = false; SND.play('deck_shuffle'); enterGame();
  if (NET.q.length) guestDrain();
}
/** Plays the host's updates in order, animating each like a local move (several waiting at once: only the last is animated). */
async function guestDrain() {
  if (NET?.role !== 'guest' || busy || !S || !NET.q.length || document.body.dataset.screen !== 'game') return;
  const u = NET.q.shift(); const before = st();
  S = { ...S, steps: [...S.steps.slice(-2), { state: u.state, events: u.anim ?? [], action: null, error: null, legal: u.legal }] };
  if (u.by === NET.me) { NET.pending = false; ab = null; }
  if (NET.q.length) { render(); return guestDrain(); }
  busy = true; document.body.dataset.busy = '1'; freezeControls(); $('#ovAsk').classList.remove('on');
  try { await playEvents(u.anim ?? [], before); } catch (e) { console.warn('animation', e); }
  busy = false; document.body.dataset.busy = '';
  render(); schedule(); guestDrain();
}
function guestSend(action) {
  if (NET.pending || NET.lost) { if (NET.lost) toast(NET.lost); return false; }
  if (NET.client.status !== 'connected') { toast('Reconnecting to the host: wait a moment'); return false; }   // M14
  NET.pending = true; NET.client.act(action);
  freezeControls(); $('#ovAsk').classList.remove('on'); return true;
}

// ------------------------------------------------------------------ the loop: apply an action, animate its events, schedule the AI
async function apply(action, { fromAi = false, remote = null } = {}) {
  if (busy || !S) return false;
  if (NET?.role === 'guest') return guestSend(action);
  const before = st();
  const r = G.play(S, action);
  if (remote) remote(r.error);   // M11: a guest's move; the engine's checks decide, its error goes back to that guest only
  if (r.error) { if (!remote) { SND.play('error_denied'); toast(r.error.message + (r.error.rule ? ` (${r.error.rule})` : '')); } return false; }
  S = r.session; busy = true; document.body.dataset.busy = '1';
  if (NET?.role === 'host') netPush();
  freezeControls();
  if (!fromAi) ab = null;
  $('#ovAsk').classList.remove('on');
  const evs = NET?.role === 'host' && NET.me ? eventsFor(current(S).events, NET.me) : current(S).events;   // M12: the host sees its seat's events
  try { await playEvents(evs, before); } catch (e) { console.warn('animation', e); }
  busy = false; document.body.dataset.busy = '';
  autosave(); render(); schedule();
  return true;
}
/** Batch 4 item 1: the buttons on screen were drawn for the state before this move. While its events animate (a battle's last
 *  round, the VICTORY result waiting for OK, ...) they must not stay up: the battle popup's roll/continue buttons go, the panel's go grey. */
function freezeControls() {
  $('#bCtl').innerHTML = '';
  $$('#players button, #phActions button:not(#bPause)').forEach(b => { b.disabled = true; });
}
function schedule() {
  clearTimeout(aiTimer); aiTimer = null; autoRoll = false;
  if (!S || document.body.dataset.screen !== 'game') return;
  const s = st();
  if (s.phase === 'finished') { showGameOver(); return; }
  if (NET?.role === 'guest') { if (!busy) humanAuto(s); return; }   // M11: a guest runs no AI and no automatic rolls: the host does
  if (NET?.role === 'host' && !busy && NET.inbox.length) { setTimeout(hostDrain, 0); return; }
  if (!busy && humanAuto(s)) return;
  if (aiPaused || busy || !G.aiToMove(S)) return;
  const f = topFrame(s); const auto = f && f.kind === 'roll' && !f.player;
  $$('.player').forEach(el => el.classList.toggle('thinking', el.dataset.pid === whoActs(s)));
  aiTimer = setTimeout(async () => { aiTimer = null; if (busy || !G.aiToMove(S) || aiPaused) return; await apply(G.aiMove(S), { fromAi: true }); }, spd(auto ? 300 : 650));
}
/** Batch 5 items 1 and 8: what happens by itself for a human. Scouting rolls the natives at once (no Roll click, 17.h); a Rome Is
 *  Displeased draw that falls on a human is announced first by a big banner that waits for OK (16.m). */
let displeasedSeen = null, autoRoll = false;
function humanAuto(s) {
  const f = topFrame(s); if (!f) return false;
  if (f.kind === 'roll' && f.purpose === 'nativeRoll' && G.isHuman(s, f.player) && NET?.role !== 'guest') {
    autoRoll = true; document.body.dataset.humanTurn = '';
    aiTimer = setTimeout(() => { aiTimer = null; autoRoll = false; if (!busy && topFrame(st())?.purpose === 'nativeRoll') apply({ type: 'ROLL', playerId: f.player }); else render(); }, spd(200));
    return true;
  }
  if (f.kind === 'draw' && f.deck === 'displeased' && G.isHuman(s, f.player) && (!NET || f.player === viewer) && displeasedSeen !== f.id) {
    displeasedSeen = f.id; busy = true; document.body.dataset.busy = '1';
    displeasedAlert(f).then(() => { busy = false; document.body.dataset.busy = ''; render(); schedule(); });
    return true;
  }
  return false;
}
async function displeasedAlert(f) {
  const s = st(); const p = G.playerById(s, f.player);
  const why = G.displeasedReason(s, data, f.player);
  document.body.dataset.popup = 'displeasedAlert'; SND.play('error_denied');
  await openModal(`<div class="dispbanner" id="dispAlert"><div class="db-top">⚠ ROME IS DISPLEASED ⚠</div><div class="db-art"><img src="${img('back.displeased')}" alt=""></div>`
    + `<div class="db-txt"><h2><span style="color:var(--${col(f.player)})">${esc(p?.name ?? f.player)}</span>, you must draw a Rome Is Displeased card!</h2><p>${esc(why)}</p><p class="small">Draw it from the Rome Is Displeased deck (the red DRAW button in your panel). Its effect is shown once it is drawn.</p>`
    + `<button class="btn gold big" data-close id="dispOk">OK, I understand</button></div></div>`, { cls: 'displeased-alert' });
  document.body.dataset.popup = '';
}
async function assassinAlert(p) {
  for (const x of p.strikes) flashToken(x.province);
  document.body.dataset.popup = 'assassinAlert'; SND.play('error_denied');
  const rows = p.strikes.map(x => `<li data-prov="${x.province}"><b>${esc(x.name)}</b>: <span class="aa-k">${x.killed} killed</span> · <span class="aa-l">${x.left} left</span></li>`).join('');
  await openModal(`<div class="assbanner" id="assAlert"><div class="ab-top">🗡 ASSASSINS STRIKE! 🗡</div><div class="ab-art"><img src="${img('card.assassin')}" alt=""></div>`
    + `<div class="ab-txt"><h2><span style="color:var(--${col(p.attacker)})">${esc(p.attackerName)}</span>'s assassins strike <span style="color:var(--${col(p.victim)})">${esc(p.victimName)}</span>!</h2>`
    + `<ul class="ab-rows">${rows}</ul>${p.lines.map(l => `<p class="small">${esc(l)}</p>`).join('')}`
    + `<button class="btn gold big" data-close id="assOk">OK, I understand</button></div></div>`, { cls: 'assassin-alert' });
  document.body.dataset.popup = '';
}
const human = d => { if (busy) return; SND.play('button_click'); return apply(d.range ? G.withValue(d, d._v ?? d.range.max) : d.action); };

// ------------------------------------------------------------------ events -> animations, modals, sounds
async function playEvents(events, before = null) {
  const s = st();
  const plan = G.soundPlan(events, s);              // item 4: one dice sound per roll
  const shownRevolts = new Set();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    for (const n of plan[i]) SND.play(n, { vol: e.type === 'diceRolled' ? 0.7 : 1 });
    switch (e.type) {
      case 'gameRollResolved': await rollPopup(G.gameRollPopup(events, i, s, data)); break;
      case 'revoltRoll': {
        const p = G.revoltRollPopup(events, i, s, data);
        for (let k = i + 1; k < events.length && events[k].type !== 'revoltRoll'; k++) if (events[k].type === 'provinceRevolted') { shownRevolts.add(k); flashToken(events[k].pub.province); queueNews(G.revoltPopup(events, k, s, data)); }
        await rollPopup(p); break;
      }
      case 'diceRolled': {
        lastRoll[e.actor ?? 'none'] = { die: e.pub.die, value: e.pub.value, purpose: e.pub.purpose };
        if (BATTLE_DICE.has(e.pub.purpose)) break; // combat dice animate in the Battle tab
        renderPlayers(); const box = $(`.player[data-pid="${e.actor}"] .tray .diebox`);
        if (box) { box.classList.add('rolling'); const n = $('.n', box); const t0 = Date.now(); while (Date.now() - t0 < spd(520)) { n.textContent = 1 + Math.floor(Math.random() * (e.pub.die === 'd10' ? 10 : 6)); await sleep(60); } box.classList.remove('rolling'); n.textContent = e.pub.value; SND.play('dice_land'); await sleep(spd(250)); }
        break;
      }
      case 'attackDeclared': startBattleView(e, s, before); drawArrow(e.pub.from, e.pub.target, '#ffdf7a'); break;
      case 'decreeBattle': clearBattle(); bv = { title: `SENATE DECREE · ${e.pub.legions} legion(s) attack Carthage`, att: 'Senate legions', attCls: 'p1', def: 'Carthage', defCls: 'nat', rounds: [], aCount: e.pub.legions, dCount: e.pub.carthage, borrowed: 0, attId: null, defId: null, aGen: 'no general (Senate legions, 16.n)', dGen: 'natives: no general', perks: { a: new Map(), d: new Map() }, decree: true }; renderBattleHead(); openBattlePop(); break;
      case 'decreeResolved': if (bv?.decree && $('#ovBattle').classList.contains('on')) { const r = e.pub; $('#bSum').className = 'b-sum on'; $('#bSum').innerHTML = `<b>${r.result === 'destroyed' ? 'CARTHAGE DESTROYED' : r.result === 'held' ? 'CARTHAGE HOLDS' : 'NO BATTLE'}</b>${r.result === 'destroyed' ? ` · ${r.survivors} legion(s) return to Roma` : r.result === 'held' ? ` · Carthage has ${r.carthage} troop(s) left` : ''}`; await battleResult(null, false); } break;
      case 'battleStarted': if (!bv) startBattleView({ pub: { player: s.battle?.att.player, from: s.battle?.att.from, target: e.pub.target, general: s.battle?.att.general } }, s, before);
        Object.assign(bv, { aCount: e.pub.attacker, dCount: e.pub.defender, borrowed: e.pub.borrowed });
        if (e.pub.perk === 'extraDie') addPerk('a', 'Scipio: an extra die (15.c)', 'scipio');   // batch 5: his only perk (the +1 is gone)
        if (e.pub.wallRollsIgnored) addPerk('a', `Wall bonus ignored for the first ${e.pub.wallRollsIgnored} roll(s)`, 'wallIgnored');
        renderBattleHead(true); openBattlePop(); await sleep(spd(500)); break;
      case 'enemyFled': if (bv) addPerk(e.pub.side === 'defender' ? 'a' : 'd', `Caesar: one enemy troop flees before the battle (15.b)`); break;
      case 'generalPerkTriggered': if (bv) addPerk(e.actor === bv.defId && bv.defId ? 'd' : 'a', `${data.generalsById[e.pub.general]?.name ?? e.pub.general}: ${e.pub.reason ?? e.pub.effect} (${e.rule})`); break;
      case 'cardPlayed': if (bv && data.cardDefsById[e.pub.def]?.type === 'battle') addBattleCard(e); toast(`${pn(e.pub.player)} plays ${data.cardDefsById[e.pub.def]?.name ?? e.pub.def}`); break;
      case 'battleRoundRolled': await animRoundRolled(e); break;
      case 'battleDiceAdjusted': adjustRound(e); for (const x of e.pub.adjustments ?? []) addPerk(x.side === 'defender' ? 'd' : 'a', G.adjustmentLabel(x, data), x.source, true); break;
      case 'battleRoundResolved': await animRoundResolved(e); break;
      case 'battleEnded': {
        endBattleView(e); await sleep(spd(400));
        // M7 item 1: the result is told inside the battle popup. A human defender who is not at the screen gets it later as "While you were away".
        const p = G.battleResultPopup(events, i, s, data); const away = p ? queueNews(p) : false;
        const sum = G.battleSummary(events, i, s, data, viewer);
        const look = [e.actor, e.pub.defender].filter(x => x && G.isHuman(s, x) && x === viewer);
        await battleResult(p && !away && p.player === viewer ? { ...sum, title: p.title, lines: p.lines } : sum, look.length > 0);
        break;
      }
      // romeRoll / senateDecree: told by the Game Roll popup (gameRollResolved, item 1)
      case 'displeasedDrawn': await flipCard('displeased', e.pub.def, `${pn(e.pub.player)} draws Rome Is Displeased`, G.isHuman(s, e.pub.player)); break;
      case 'cardDrawn': {
        const def = e.pub.def ?? (e.priv && e.pub.player === viewer ? e.priv.def : null);
        if (def && (G.isHuman(s, e.pub.player) || e.pub.deck !== 'game')) await flipCard(e.pub.deck, def, `${pn(e.pub.player)} draws a ${e.pub.deck === 'game' ? 'Game' : 'Resource'} card`, G.isHuman(s, e.pub.player));
        else toast(`${pn(e.pub.player)} draws a ${e.pub.deck === 'game' ? 'Game Card (hidden)' : e.pub.deck + ' card'}`);
        break;
      }
      case 'troopsAssassinated': {   // v22: a human victim must see and acknowledge it (never for AI victims or natives)
        const prev = events[i - 1];
        if (!(prev?.type === 'troopsAssassinated' && prev.pub.player === e.pub.player)) for (const p of G.assassinPopups(events, i, s, data)) if (!NET || p.victim === viewer) await assassinAlert(p);
        break;
      }
      case 'provinceRevolted': if (!shownRevolts.has(i)) { flashToken(e.pub.province); await deliver(G.revoltPopup(events, i, s, data)); } break;
      default: if (G.isDispleasedResult(e)) await deliver(G.displeasedPopup(events, i, s, data)); break;
      case 'revoltBlocked': toast(`Kill Revolt leader!: ${prov(e.pub.province)} does not revolt`); break;
      case 'revoltRollSkipped': toast(`${pn(e.pub.player)}: no Revolt Roll (fewer than 2 conquered provinces, 17.c)`); break;
      case 'provinceConquered': toast(`${pn(e.pub.player)} conquers ${prov(e.pub.province)}!`); break;
      case 'provinceAllied': toast(`${pn(e.pub.player)} allies with ${prov(e.pub.province)}`); break;
      case 'turnStarted': toast(`Turn ${e.pub.number}: ${pn(e.pub.player)}`); $('#arrows').innerHTML = ''; break;
      case 'playerEliminated': toast(`${pn(e.pub.player)} is out of the game`); break;
    }
  }
}
async function eventModal(artId, title, body) {
  await openModal(`<div class="cardbig"><img src="${img(artId)}" alt=""></div><div class="txt"><h2>${esc(title)}</h2>${body}<button class="btn gold" data-close>OK</button></div>`, { autoMs: spd(2600), cls: 'event' });
}
/** Game Roll / Revolt Roll / revolt popups (M6 items 1 and 7). Sticky ones (a human lost a province) wait for OK; the rest close themselves. */
async function rollPopup(p) {
  if (!p) return;
  const num = p.value !== undefined ? `<div class="rollnum">${esc(p.value)}</div>` : '';
  const hit = p.matched ? `<div class="rollprov" id="rollProv"><span class="small">Province${p.matched.length === 1 ? '' : 's'} with number ${esc(p.value)}:</span>${p.matched.length ? p.matched.map(m => `<span class="rp ${m.owner ? col(m.owner) : 'nat'}" data-prov="${m.id}"><b>${esc(m.name)}</b> <i>${esc(m.holder)}</i></span>`).join('') : '<span class="rp none">none</span>'}</div>` : '';
  for (const m of p.matched ?? []) flashToken(m.id);
  const html = `<div class="cardbig"><img src="${img(p.art)}" alt="">${num}</div><div class="txt"><h2>${esc(p.title)}</h2>${hit}<ul class="rolllines">${(p.matched ? p.lines.filter(l => !l.startsWith(`Number ${p.value}: `)) : p.lines).map(l => `<li>${esc(l)}</li>`).join('')}</ul>${p.sticky ? '<p class="small"><b>Click OK to continue.</b></p>' : ''}<button class="btn gold" data-close id="popOk">OK</button></div>`;
  document.body.dataset.popup = p.kind;
  await openModal(html, { autoMs: p.sticky ? 0 : spd(4500), cls: 'event roll-pop ' + p.kind + (p.revolt || p.kind === 'revolt' ? ' revolt-pop' : '') });
  document.body.dataset.popup = '';
}
/** Hot-seat (item 7): a revolt that hits a human who is not looking right now is shown again when that human's context comes up. */
const news = {};
const NEWS_KINDS = new Set(['revolt', 'battle', 'displeased']);
function queueNews(p) { if (!p || !NEWS_KINDS.has(p.kind) || !G.isHuman(st(), p.player)) return false; if (p.player !== (NET ? NET.me : G.viewerFor(st(), viewer))) { if (!NET) (news[p.player] ??= []).push(p); return true; } return false; }   // M11: online, each player's own screen shows it
/** Q100 (Vidi 2026-10-22): a popup that affects a human waits for OK. If that human is looking now they get it at once; in hot-seat,
 *  when someone else is at the screen, that player sees a short self-closing version and the affected human gets it as "While you were away". */
async function deliver(p) { if (!p) return; if (queueNews(p)) await rollPopup({ ...p, sticky: false }); else await rollPopup(p); }
async function showNews() {
  const list = viewer && news[viewer]; if (!list?.length || busy) return;
  delete news[viewer]; busy = true; document.body.dataset.busy = '1';
  for (const p of list) await rollPopup({ ...p, title: `While you were away: ${p.title}`, sticky: true });
  busy = false; document.body.dataset.busy = ''; render(); schedule();
}
const CARD_VIEW_MS = 8000;   // batch 5 item 7: real seconds, not scaled by the animation speed (it is reading time)
async function flipCard(deck, def, caption, mine = true) {
  const c = G.cardView(data, def);
  const ov = $('#ovDraw'), dc = $('#drawCard'), ch = Math.min(window.innerHeight * 0.66, 620), cw = ch / 2;
  dc.style.setProperty('--cw', cw + 'px'); dc.classList.remove('flipped');
  dc.innerHTML = `<div class="fc-inner"><div class="fc-back"><img src="${img('back.' + deck)}" alt=""></div><div class="fc-front"><div class="cf art"><img src="${img(c.art)}" alt="${attr(c.name)}"></div></div></div>`;
  $('#drawBtns').innerHTML = `<div>${esc(caption)}: <b>${esc(c.name)}</b>${c.battle ? ' <span class="bclabel" style="display:inline;color:#ffd9a8">' + G.BATTLE_LABEL + '</span>' : ''}</div><div class="row"><button class="btn gold" id="dOk">Close</button></div><div class="small dtimer">${mine ? 'Closes by itself in 8 s, or click anywhere.' : 'Click anywhere to close.'}</div>`;
  ov.classList.add('on'); document.body.dataset.drawView = '1';
  // batch 5 item 7 (Vidi 2026-10-24): a card being looked at stays up 8 seconds, or until Close or a click anywhere else
  let done; const p = new Promise(r => { done = r; }); $('#dOk').onclick = () => done(); ov.onclick = () => done();
  await sleep(spd(350)); SND.play('card_flip'); dc.classList.add('flipped');
  await Promise.race([p, sleep(mine ? CARD_VIEW_MS : spd(1900))]);   // an AI's draw keeps its old short look
  ov.onclick = null; ov.classList.remove('on'); document.body.dataset.drawView = '';
}
function flashToken(id) { const t = $(`.tok[data-id="${id}"]`); if (t) { t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit'); } }

// ------------------------------------------------------------------ battle panel (animated from events)
function clearBattle() { bv = null; $('#bTitle').textContent = 'No battle yet'; $('#bChips').innerHTML = ''; $('#rt tbody').innerHTML = ''; $('#bSum').className = 'b-sum'; $('#bSum').innerHTML = ''; ['#aCount', '#dCount'].forEach(x => { $(x).textContent = '-'; }); ['#aTok', '#dTok', '#aCards', '#dCards'].forEach(x => { $(x).innerHTML = ''; }); $('#aNote').innerHTML = '&nbsp;'; $('#dNote').innerHTML = '&nbsp;'; ['#aGen', '#dGen', '#aPerks', '#dPerks'].forEach(x => { $(x).innerHTML = ''; }); $('#bDot').style.display = 'none'; }
function startBattleView(e, s, before = null) {
  clearBattle();
  const t = e.pub.target, defP = e.pub.defender ?? s.provinces[t]?.owner ?? null;
  const pre = before ?? s; const genName = pid => { const g = G.playerById(pre, pid)?.general; return g ? data.generalsById[g.id]?.name ?? g.id : null; };
  const dGenHere = defP && G.playerById(pre, defP)?.general?.at === t ? genName(defP) : null;
  bv = { title: `BATTLE · ${pn(e.pub.player)} attacks ${prov(t)} from ${prov(e.pub.from)}${e.pub.sea ? ' (by sea)' : ''}`, att: pn(e.pub.player), attCls: col(e.pub.player), def: defP ? pn(defP) : t === 'roma' ? 'Roma' : `${prov(t)} natives`, defCls: defP ? col(defP) : 'nat', rounds: [], aCount: e.pub.troops, dCount: null, borrowed: 0,
    attId: e.pub.player, defId: defP, aGen: e.pub.general ? `General ${genName(e.pub.player) ?? ''} leads the army` : `no general (${genName(e.pub.player) ? genName(e.pub.player) + ' stays behind' : 'none'})`,
    dGen: dGenHere ? `General ${dGenHere} defends` : defP ? 'no general here' : 'natives: no general', perks: { a: new Map(), d: new Map() } };
  renderBattleHead();
}
/** Batch 4 item 2: one line per perk. The engine tells a perk in several events and in different words (battleStarted's choice,
 *  every round's dice reasons, the per-round dice adjustments), so the list is keyed by the perk, not by its wording. */
const perkKey = t => (/^Scipio\b/.test(t) ? 'scipio' : /^Wall bonus (ignored|cancelled)/.test(t) ? 'wallIgnored' : /^Pompey\b/.test(t) ? 'pompey' : /^Fight to the Death/.test(t) ? 'germanicus' : t);
function addPerk(side, text, key = perkKey(text), replace = false) {
  if (!bv || !text) return; bv.perks ??= { a: new Map(), d: new Map() };
  if (replace || !bv.perks[side].has(key)) bv.perks[side].set(key, text);   // replace: a dice adjustment keeps its latest size (a 2nd Elephants!)
  renderPerks();
}
function renderPerks() {
  if (!bv) return;
  const ul = m => (m?.size ? [...m.values()].map(x => `<li>${esc(x)}</li>`).join('') : '<li class="none">no perks or modifiers</li>');
  $('#aGen').textContent = bv.aGen ?? ''; $('#dGen').textContent = bv.dGen ?? '';
  $('#aPerks').innerHTML = ul(bv.perks?.a); $('#dPerks').innerHTML = ul(bv.perks?.d);
}
// ------------------------------------------------------------------ M7 item 1: the battle popup, front and centre (the Battle tab keeps the record)
let bpDone = null;
function openBattlePop() {
  const ov = $('#ovBattle'); if (ov.classList.contains('on')) return;
  $('#bpBox').append($('#pane-battle .battle')); $('#bpRes').innerHTML = ''; ov.classList.add('on'); document.body.classList.add('battlepop');
}
function closeBattlePop() {
  const ov = $('#ovBattle'); if (!ov) return;
  const b = $('#bpBox .battle'); if (b) $('#pane-battle').append(b);
  ov.classList.remove('on'); document.body.classList.remove('battlepop'); $('#bpRes').innerHTML = '';
  if (document.body.dataset.popup === 'battle' && bpDone) document.body.dataset.popup = '';
  const f = bpDone; bpDone = null; if (f) f();
}
/** The result at the foot of the battle popup; sticky (waits for OK) when a human at the screen fought, otherwise it closes itself. */
async function battleResult(sum, sticky) {
  if (!$('#ovBattle').classList.contains('on')) return;
  const res = $('#bpRes');
  res.innerHTML = `${sum ? `<h3>${esc(sum.title)}</h3><ul class="rolllines">${sum.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}${sticky ? '<p class="small"><b>Click OK to continue.</b></p>' : ''}<button class="btn gold" id="bpOk">OK</button>`;
  if (sticky) document.body.dataset.popup = 'battle';
  const p = new Promise(r => { bpDone = r; });
  $('#bpOk').onclick = () => { SND.play('button_click'); closeBattlePop(); };
  if (!sticky) setTimeout(() => { if (bpDone) closeBattlePop(); }, spd(3500));
  await p;
  if (document.body.dataset.popup === 'battle') document.body.dataset.popup = '';
}
function renderBattleHead(tokens = false) {
  if (!bv) return;
  $('#bDot').style.display = 'inline-block';
  $('#bTitle').textContent = bv.title;
  $('#aName').textContent = bv.att + ' (attacker)'; $('#aName').style.color = `var(--${bv.attCls})`;
  $('#dName').textContent = bv.def; $('#dName').style.color = bv.defCls === 'nat' ? 'var(--native)' : `var(--${bv.defCls})`;
  $('#aCount').textContent = bv.aCount ?? '-'; $('#dCount').textContent = bv.dCount ?? '-';
  renderPerks();
  $('#aNote').textContent = bv.borrowed ? `${bv.aCount - bv.borrowed} own + ${bv.borrowed} borrowed (die first)` : ' ';
  if (tokens) {
    const mk = (cls, n) => [...Array(Math.max(0, n))].map(() => `<div class="${cls}"></div>`).join('');
    $('#aTok').innerHTML = mk('bt', (bv.aCount ?? 0) - bv.borrowed) + mk('bt borrowed', bv.borrowed);
    $('#dTok').innerHTML = mk(bv.defCls === 'nat' ? 'bt nat' : 'bt', bv.dCount ?? 0);
    $$('#aTok .bt:not(.borrowed)').forEach(t => { t.style.background = `var(--${bv.attCls})`; });
    if (bv.defCls !== 'nat') $$('#dTok .bt').forEach(t => { t.style.background = `var(--${bv.defCls})`; });
  }
}
function addBattleCard(e) {
  const side = st().battle && st().battle.def.player === e.pub.player ? '#dCards' : '#aCards';
  $(side).insertAdjacentHTML('beforeend', `<span class="cbadge ${e.pub.def === 'moral_boost' ? 'moral' : ''}">${esc(data.cardDefsById[e.pub.def].name)}<span class="bclabel">${G.BATTLE_LABEL}</span></span>`);
}
const diceHtml = (arr, cls, roll) => `<span class="dice">${arr.map(v => `<span class="d ${cls}${roll ? ' rolling' : ''}">${v}</span>`).join('')}</span>`;
async function animRoundRolled(e) {
  if (!bv) bv = { title: 'Battle', att: pn(e.pub.attacker.player), attCls: col(e.pub.attacker.player), def: 'Defender', defCls: 'nat', rounds: [], borrowed: 0, attId: e.pub.attacker.player, defId: e.pub.defender.player };
  openBattlePop();
  // dice modifiers and perks, side by side (M7 item 1)
  const plain = /^(land attack: |defender: \d dice|only \d+ )/;
  for (const r of e.pub.attacker.reasons ?? []) if (!plain.test(r)) addPerk('a', r);
  for (const r of e.pub.defender.reasons ?? []) if (!plain.test(r)) addPerk('d', r);
  const a = e.pub.attacker.dice, d = e.pub.defender.dice;
  const tr = document.createElement('tr'); tr.dataset.r = e.pub.round;
  tr.innerHTML = `<td><b>${e.pub.round}</b><small>${a.length}d6 v ${d.length}d6</small></td><td class="ca">${diceHtml(a.map(() => '?'), 'a', 1)}</td><td class="cp">-</td><td class="cd">${diceHtml(d.map(() => '?'), 'n', 1)}</td><td class="cl"></td><td class="ct"></td>`;
  $('#rt tbody').append(tr); tr.scrollIntoView({ block: 'nearest' });
  SND.later('dice_roll_d6', 120, { vol: 0.6 });
  const ds = $$('.d', tr); const t0 = Date.now();
  while (Date.now() - t0 < spd(650)) { ds.forEach(x => { x.textContent = 1 + Math.floor(Math.random() * 6); }); await sleep(60); }
  $$('.ca .d', tr).forEach((x, i) => { x.classList.remove('rolling'); x.textContent = a[i]; });
  $$('.cd .d', tr).forEach((x, i) => { x.classList.remove('rolling'); x.textContent = d[i]; });
  SND.play('dice_land'); await sleep(spd(300));
}
function adjustRound(e) {
  const tr = $(`#rt tbody tr[data-r="${e.pub.round}"]`); if (!tr) return;
  $$('.ca .d', tr).forEach((x, i) => { if (e.pub.attackerFinal[i] !== undefined) x.classList.add('boost'); });
  $$('.cd .d', tr).forEach((x, i) => { if (e.pub.defenderFinal[i] !== undefined) x.classList.add('boost'); });
}
async function animRoundResolved(e) {
  const p = e.pub, tr = $(`#rt tbody tr[data-r="${p.round}"]`); if (!tr) return;
  const dA = $$('.ca .d', tr), dD = $$('.cd .d', tr);
  // the engine pairs the sorted final dice: show those so the pairs line up
  dA.forEach((x, i) => { x.textContent = p.attackerFinal[i] ?? x.textContent; }); dD.forEach((x, i) => { x.textContent = p.defenderFinal[i] ?? x.textContent; });
  p.pairs.forEach((q, i) => { const aw = q.winner === 'attacker'; dA[i]?.classList.add(aw ? 'win' : 'lose'); dD[i]?.classList.add(aw ? 'lose' : 'win'); });
  dA.slice(p.pairs.length).forEach(x => x.classList.add('unused')); dD.slice(p.pairs.length).forEach(x => x.classList.add('unused'));
  $('.cp', tr).innerHTML = '<span class="pairs">' + p.pairs.map(q => `<span class="${q.winner === 'attacker' ? 'A' : 'D'}">${q.a} v ${q.d}</span>`).join('') + '</span>';
  await sleep(spd(450));
  $('.cl', tr).innerHTML = `<span class="loss">${p.attackerLoss ? '-' + p.attackerLoss : '0'}</span> / <span class="loss">${p.defenderLoss ? '-' + p.defenderLoss : '0'}</span>`;
  $('.ct', tr).innerHTML = `<b>${p.attackerTroopsAfter}</b> / <b>${p.defenderTroopsAfter}</b>`;
  if (p.defenderLoss > p.attackerLoss) SND.play('battle_attacker_win_round'); else if (p.attackerLoss > p.defenderLoss) SND.play('battle_defender_win_round');
  for (let i = 0; i < Math.min(p.defenderLoss, 3); i++) SND.later('battle_hit', i * 220 + 60);
  for (let i = 0; i < Math.min(p.attackerLoss, 3); i++) SND.later('troop_lost', i * 220 + 120);
  const kill = (sel, n) => { const alive = $$(sel + ' .bt:not(.dead)'); const order = [...alive.filter(t => t.classList.contains('borrowed')), ...alive.filter(t => !t.classList.contains('borrowed')).reverse()]; order.slice(0, n).forEach((t, i) => setTimeout(() => t.classList.add('dead'), i * 160)); };
  kill('#aTok', p.attackerLoss); kill('#dTok', p.defenderLoss);
  const ac = $('#aCount'), dc = $('#dCount'); ac.textContent = p.attackerTroopsAfter; dc.textContent = p.defenderTroopsAfter;
  if (p.attackerLoss) { ac.classList.remove('hit'); void ac.offsetWidth; ac.classList.add('hit'); }
  if (p.defenderLoss) { dc.classList.remove('hit'); void dc.offsetWidth; dc.classList.add('hit'); }
  if (bv) { bv.aCount = p.attackerTroopsAfter; bv.dCount = p.defenderTroopsAfter; }
  await sleep(spd(650));
}
function endBattleView(e) {
  const p = e.pub; const sum = $('#bSum'); sum.className = 'b-sum on';
  const win = p.outcome === 'conquered';
  sum.innerHTML = `<b>${win ? 'VICTORY' : p.outcome === 'retreat' ? 'RETREAT' : 'DEFEAT'} after ${p.rounds} round(s)</b> · ${esc(p.winner && p.winner !== 'defender' ? pn(p.winner) + ' wins' : win ? '' : 'the defender holds')}${p.borrowedDead ? ` · ${p.borrowedDead} borrowed native(s) died` : ''}`;
  $('#bDot').style.display = 'none';
}
function drawArrow(from, to, color) {
  const A = data.provincesById[from]?.token, B = data.provincesById[to]?.token; if (!A || !B) { $('#arrows').innerHTML = ''; return; }
  const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  $('#arrows').innerHTML = `<defs><marker id="ah" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${color}"/></marker></defs><line x1="${A.x + ux * 17}" y1="${A.y + uy * 17}" x2="${B.x - ux * 19}" y2="${B.y - uy * 19}" stroke="${color}" stroke-width="3" stroke-dasharray="7 4" marker-end="url(#ah)"/>`;
}

// ------------------------------------------------------------------ render
function render() {
  if (!S) return;
  const s = st();
  const nv = NET ? NET.me : G.viewerFor(s, viewer);   // M11: online, the screen always belongs to this page's own seat
  viewer = nv;
  document.body.dataset.whoActs = whoActs(s) ?? '';
  document.body.dataset.frame = topFrame(s)?.kind ?? (s.phase === 'turn' ? 'free' : s.phase);
  document.body.dataset.viewer = viewer ?? '';
  const legal = mineNow();
  document.body.dataset.humanTurn = legal.length ? '1' : '';
  renderTop(); renderPhase(legal); renderPlayers(); renderMap(legal); renderTable(); renderDecks(legal); renderHand(legal); renderLog(); renderBuilder(legal); renderBattleCtl(legal); renderAsk(legal);
  document.body.classList.toggle('p3mode', s.players.length >= 3);
  if (!busy && !bpDone && !s.battle && $('#ovBattle').classList.contains('on')) closeBattlePop();
  if (viewer && news[viewer]?.length && !busy) setTimeout(showNews, 0);
}
/** The human who decides now and their legal moves (none for AI seats). Hot-seat (Q95, Vidi 2026-10-21): no curtain; the board
 *  switches to the next player's context at End Turn, and the optional hide-hand toggle covers the hand. */
function mineNow() {
  if (NET?.role === 'guest') return NET.pending ? [] : current(S).legal ?? [];   // M11: the host sends each guest its legal moves
  const s = full(); const w = whoActs(s);   // the full state: legal moves need the own hand and the decks
  if (!G.isHuman(s, w) || w !== viewer) return [];
  return G.humanLegal(s, data, w);
}
function renderTop() {
  const s = st();
  $('#tbInfo').textContent = s.phase === 'setup' ? `Setup · seed ${S.seed.split('#')[0]}` : `Turn ${s.turn.number} · round ${s.turn.round} · seed ${S.seed.split('#')[0]}`;
}
function renderPhase(legal) {
  const s = st(); const f = topFrame(s); const a = s.phase === 'turn' ? s.turn.activePlayerId : whoActs(s);
  $('#phasebar').style.setProperty('--pc', `var(--${col(a)})`);
  $('#phWho').innerHTML = s.phase === 'setup' ? 'Setup' : s.phase === 'finished' ? `Game over: ${esc(pn(s.winner))} wins` : `${esc(pn(a))}'s turn<span class="turnflag" style="background:var(--${col(a)})">turn ${s.turn.number}</span>`;
  const si = G.stepIndex(s);
  $('#phChips').innerHTML = s.phase === 'setup' ? '<span class="chip cur"><b>0</b>Setup</span>' : G.STEP_CHIPS.map(([, n], i) => `<span class="chip ${i < si ? 'done' : i === si ? 'cur' : ''}"><b>${i < si ? '✓' : i + 1}</b>${n}</span>`).join('<span class="arrow">▸</span>');
  const w = whoActs(s); let html = ''; let prompt = esc(G.describePrompt(s, data));
  if (s.phase === 'finished') html = '<button class="btn gold" id="bOver">Results</button>';
  else if (!legal.length) {
    html = `<span class="small">${G.isHuman(s, w) ? 'Waiting for ' + esc(pn(w)) : esc(pn(w)) + ' (AI) is thinking…'}</span> ${NET?.role === 'guest' ? '' : `<button class="btn sm" id="bPause">${aiPaused ? 'Resume AI ▶' : 'Pause AI ⏸'}</button>`}`;
  } else if (!f) {
    // batch 4 item 4: the turn's action buttons sit in the active player's panel; the phase bar only hints
    html = `<span class="small phhint">◂ Your actions: in ${esc(pn(w))}'s panel, on the left</span>`;
    prompt = `<b class="you">${esc(pn(w))}</b>: actions ${s.turn.actionsUsed}/2 used. Attack, Ally or Move, buy or build, play a card, or click a province. ${ab ? '<em>Builder open: see the Builder tab.</em>' : ''}`;
  } else {
    // M7 item 10: the roll and draw buttons sit in the active player's panel, next to the die
    if (f.kind === 'roll' && (f.purpose === 'battleRound' || f.purpose === 'loyalty')) html = `<span class="small phhint">▸ in the battle window</span>`;
    else if (f.kind === 'roll' || f.kind === 'draw') html = `<span class="small phhint">◂ ${f.kind === 'roll' ? 'Roll' : 'Draw'} in ${esc(pn(w))}'s panel, on the left</span>`;
    else html = `<span class="small phhint">◂ ${esc(G.frameTitle(s, data))}: in ${esc(pn(w))}'s panel</span>`;
    prompt = `<b class="you">${esc(pn(w))}</b>: ${esc(G.frameTitle(s, data))} · ${esc(G.describePrompt(s, data).replace(/^.*?: /, ''))}`;
  }
  $('#phActions').innerHTML = html; $('#phPrompt').innerHTML = prompt;
  const pz = $('#bPause'); if (pz) pz.onclick = () => { aiPaused = !aiPaused; render(); schedule(); };
  const bo = $('#bOver'); if (bo) bo.onclick = () => { overShown = false; showGameOver(); };
}
function openMenu(k, legal) {
  if (k === 'build') { openBuild(); return; }
  if (k === 'card') { openCardMenu(legal); return; }
  if (k === 'buy') { openBuy(); return; }
  if (k === 'sell') { openSell(); return; }
  const c = G.categorize(legal)[k];
  const title = { buy: 'Buy', build: 'Build', card: 'Play a card', scout: 'Scout a target (roll its natives)', other: 'More actions' }[k];
  openModal(`<div class="ask menu" style="display:flex;flex-direction:column;gap:8px;min-width:380px"><h2>${title}</h2><div class="opts">${optionsHtml(c)}</div><div class="foot"><span class="small">An action costs 1 of your 2 actions unless it says free.</span><button class="btn" data-close>Cancel</button></div></div>`);
  wireOptions($('#modalBox'), c, () => closeModal());
}
// ------------------------------------------------------------------ the step-by-step Build screen (M6 item 9): what -> where (-> border) -> pay or use the saved card
let bs = null;   // {piece, province, facing}
function openBuild(piece = null, fromCard = null) { bs = { piece, province: null, facing: null, fromCard }; openModal('<div id="buildBox"></div>', { cls: 'buildmodal' }).then(() => { bs = null; }); renderBuild(); }
function buildHtml(model, inFrame) {
  const P = model.pieces; const pc = bs.piece ? P.find(x => x.piece === bs.piece) : null;
  const pv = pc && bs.province ? pc.provinces.find(x => x.id === bs.province) : null;
  const fc = pv && bs.facing ? pv.facings.find(x => x.id === bs.facing) : null;
  const stepNo = !pc ? 1 : pc.piece === 'catapult' ? 3 : !pv || (pc.piece === 'wall' && !fc) ? 2 : 3;
  const chips = ['What', 'Where', inFrame ? 'Build' : 'Pay or use a card'].map((n, i) => `<span class="bd-step ${i + 1 === stepNo ? 'cur' : i + 1 < stepNo ? 'done' : ''}">${i + 1} ${n}</span>`).join('');
  const back = stepNo > 1 && !(inFrame && stepNo === 2 && !bs.province) ? '<button class="btn sm" id="bsBack">◀ Back</button>' : '';
  let body = '';
  if (!pc) {
    body = `<div class="bs-pieces">${P.map(x => `<button class="bs-piece ${x.enabled ? '' : 'off'}" data-piece="${x.piece}" ${x.enabled ? '' : 'disabled'}><img src="${img(x.piece === 'catapult' ? 'item.catapult' : 'card.' + x.piece)}" alt=""><b>${x.name}</b><span>${x.piece === 'catapult' ? `${x.cost} Gold · 1 action · you own ${x.owned}` : `${x.cost} Gold · 1 action`}</span>${x.saved ? `<span class="bs-saved">you hold ${x.saved} saved ${x.name} card${x.saved > 1 ? 's' : ''} (free)</span>` : ''}${x.reason ? `<span class="bs-why">${esc(x.reason)}</span>` : ''}</button>`).join('')}</div>`;
  } else if (pc.piece === 'catapult') {
    body = `<p>A Catapult is permanent: in every attack, each Catapult cancels the defender's Wall bonus for the first 2 rolls (19.u). You own ${pc.owned}.</p><div class="bs-go"><button class="btn gold" data-key="${attr(G.descKey(pc.paid))}">Buy a Catapult for ${pc.cost} Gold (1 action)</button></div>`;
  } else if (!pv) {
    body = `${bs.fromCard ? `<p id="bsFromCard"><b>Using your saved ${pc.name} card: free, no Gold, no action.</b> Pick the province.</p>` : ''}<p class="small">Which province gets the ${pc.name}?${pc.reason ? ' <i>' + esc(pc.reason) + '</i>' : ''}</p><div class="bs-grid">${pc.provinces.map(x => { const p = st().provinces[x.id]; const n = pc.piece === 'wall' ? x.facings.length : 0; return `<button class="btn" data-prov="${x.id}"><b>${esc(x.name)}</b><span class="small">${p.troops} troops${pc.piece === 'wall' ? ` · ${n} open border${n === 1 ? '' : 's'}${p.walls.length ? ' · Walls: ' + p.walls.map(prov).join(', ') : ''}` : ''}</span></button>`; }).join('')}</div>`;
  } else if (pc.piece === 'wall' && !fc) {
    body = `<p class="small">${esc(pv.name)}: which border does the Wall face? It gives a 3rd defence die against attacks from that province (19.k).</p><div class="bs-grid">${pv.facings.map(x => `<button class="btn" data-facing="${x.id}"><b>${esc(x.name)}</b><span class="small">${data.provincesById[pv.id].sea.includes(x.id) ? 'sea' : 'land'}${st().provinces[x.id].owner ? ' · ' + esc(pn(st().provinces[x.id].owner)) : ''}</span></button>`).join('')}</div>`;
  } else {
    const o = fc ?? pv; const where = `${pc.name} in ${pv.name}${fc ? ' facing ' + fc.name : ''}`;
    const btns = [];
    if (o.free) btns.push(`<button class="btn gold" data-key="${attr(G.descKey(o.free))}">${inFrame ? `Build the ${esc(where)} (free)` : `Use your saved ${pc.name} card: free, no action`}</button>`);
    if (o.paid) btns.push(`<button class="btn ${o.free ? '' : 'gold'}" data-key="${attr(G.descKey(o.paid))}">Pay ${pc.cost} Gold (1 action)</button>`);
    body = `<p><b>${esc(where)}</b></p>${o.free && o.paid ? `<p class="small">You hold a saved ${pc.name} card. Use it for free (no Gold, no action, 19.p, 20.f), or pay and keep the card?</p>` : o.free && !inFrame ? `<p class="small">Your saved ${pc.name} card builds it for free (no Gold, no action).${pc.reason ? ' Paying is not possible: ' + esc(pc.reason) + '.' : ''}</p>` : ''}<div class="bs-go">${btns.join('')}</div>`;
  }
  const foot = inFrame ? (model.save ? `<button class="btn" data-key="${attr(G.descKey(model.save))}">Save the card for later</button>` : '') : '<button class="btn" data-close>Cancel</button>';
  const head = inFrame ? `Free ${P[0].name} card: build it now or save it` : `Build · ${model.gold} Gold · ${model.actionsLeft} action${model.actionsLeft === 1 ? '' : 's'} left`;
  return `<div class="ask build" id="buildScreen" data-step="${stepNo}"><h2>${esc(head)}</h2><div class="bd-steps">${chips}</div><div class="bs-body">${body}</div><div class="foot">${back}<span class="spacer"></span>${foot}</div></div>`;
}
function wireBuild(root, legal, rerender, done) {
  $$('[data-piece]', root).forEach(b => b.onclick = () => { SND.play('button_click'); bs.piece = b.dataset.piece; bs.province = null; bs.facing = null; rerender(); });
  $$('[data-prov]', root).forEach(b => b.onclick = () => { SND.play('province_select'); bs.province = b.dataset.prov; bs.facing = null; rerender(); });
  $$('[data-facing]', root).forEach(b => b.onclick = () => { SND.play('province_select'); bs.facing = b.dataset.facing; rerender(); });
  const bk = $('#bsBack', root); if (bk) bk.onclick = () => { if (bs.facing) bs.facing = null; else if (bs.province) bs.province = null; else bs.piece = null; rerender(); };
  $$('[data-key]', root).forEach(b => b.onclick = () => { const d = legal.find(x => G.descKey(x) === b.dataset.key); if (!d) { SND.play('error_denied'); return; } done(); human(d); });
  $$('[data-close]', root).forEach(b => b.onclick = closeModal);
}
function renderBuild() {
  const root = $('#buildBox'); if (!root || !bs) return;
  const legal = mineNow(); const m = G.buildSteps(st(), data, legal);
  root.innerHTML = buildHtml(m, false);
  wireBuild(root, legal, renderBuild, () => closeModal());
}

// ------------------------------------------------------------------ M7 item 4: the step-by-step Buy screen: what -> where -> pay
let bys = null;   // {item, province}
function openBuy() { bys = { item: null, province: null }; openModal('<div id="buyBox"></div>', { cls: 'buildmodal' }).then(() => { bys = null; }); renderBuy(); }
function buyHtml(m) {
  const it = bys.item ? m.items.find(x => x.item === bys.item) : null;
  const pv = it && bys.province ? it.provinces.find(x => x.id === bys.province) : null;
  const stepNo = !it ? 1 : !pv ? 2 : 3;
  const chips = ['What', 'Where', 'How to pay'].map((n, i) => `<span class="bd-step ${i + 1 === stepNo ? 'cur' : i + 1 < stepNo ? 'done' : ''}">${i + 1} ${n}</span>`).join('');
  const back = stepNo > 1 ? '<button class="btn sm" id="bsBack">◀ Back</button>' : '';
  const sellHint = m.sellable ? `<button class="btn sm" id="buySell">Short of Gold? Sell a card (+${data.rules.sellCard?.gold ?? 2} Gold, free)…</button>` : '';
  let body;
  if (!it) {
    body = `<div class="bs-pieces">${m.items.map(x => `<button class="bs-piece ${x.enabled ? '' : 'off'}" data-item="${x.item}" ${x.enabled ? '' : 'disabled'}><img src="${img(x.item === 'troop' ? 'card.troop_1' : 'back.game')}" alt=""><b>${x.name}</b><span>${esc(x.costText)}</span>${x.reason ? `<span class="bs-why">${esc(x.reason)}</span>` : ''}</button>`).join('')}</div>`;
  } else if (!pv) {
    const q = it.item === 'troop' ? 'Which province gets the new troop?' : `Which province pays the troop? At least 1 must stay there (17.s, 17.f).`;
    body = `<p class="small">${q}</p><div class="bs-grid">${it.provinces.map(x => `<button class="btn ${x.enabled ? '' : 'off'}" data-prov="${x.id}" ${x.enabled ? '' : 'disabled'}><b>${esc(x.name)}</b><span class="small">${x.troops} troop${x.troops === 1 ? '' : 's'}${x.reason ? ' · ' + esc(x.reason) : it.item === 'gameCard' ? ` → ${x.troops - 1}` : ` → ${x.troops + 1}`}</span></button>`).join('')}</div>`;
  } else {
    const what = it.item === 'troop' ? `1 troop in ${pv.name}` : `1 Game Card, paying a troop from ${pv.name}`;
    body = `<p><b>${esc(what)}</b></p><p class="small">No card makes this free, so it is paid in Gold. It uses 1 of your ${data.rules.actionsPerTurn} actions.</p><div class="bs-go"><button class="btn gold" data-key="${attr(G.descKey(pv.paid))}">Pay ${it.cost} Gold${it.item === 'gameCard' ? ' + 1 troop' : ''} (1 action) ▶</button></div><p class="small">You have ${m.gold} Gold; ${m.gold - it.cost} left after.</p>`;
  }
  return `<div class="ask build" id="buyScreen" data-step="${stepNo}"><h2>Buy · ${m.gold} Gold · ${m.actionsLeft} action${m.actionsLeft === 1 ? '' : 's'} left</h2><div class="bd-steps">${chips}</div><div class="bs-body">${body}</div><div class="foot">${back}${stepNo === 1 ? sellHint : ''}<span class="spacer"></span><button class="btn" data-close>Cancel</button></div></div>`;
}
function renderBuy() {
  const root = $('#buyBox'); if (!root || !bys) return;
  const legal = mineNow(); const m = G.buySteps(st(), data, legal);
  root.innerHTML = buyHtml(m);
  $$('[data-item]', root).forEach(b => b.onclick = () => { SND.play('button_click'); bys.item = b.dataset.item; bys.province = null; renderBuy(); });
  $$('[data-prov]', root).forEach(b => b.onclick = () => { SND.play('province_select'); bys.province = b.dataset.prov; renderBuy(); });
  const bk = $('#bsBack', root); if (bk) bk.onclick = () => { if (bys.province) bys.province = null; else bys.item = null; renderBuy(); };
  const sh = $('#buySell', root); if (sh) sh.onclick = () => openSell();
  $$('[data-key]', root).forEach(b => b.onclick = () => { const d = legal.find(x => G.descKey(x) === b.dataset.key); if (!d) { SND.play('error_denied'); return; } closeModal(); human(d); });
  $$('[data-close]', root).forEach(b => b.onclick = closeModal);
}
// ------------------------------------------------------------------ M7 item 6: selling cards (20.p): free, +2 Gold each, in hand or saved
function openSell() {
  const list = mineNow().filter(d => d.type === 'SELL_CARD');
  const g = data.rules.sellCard?.gold ?? 2;
  const rows = list.map(d => { const c = st().cards[d.action.cardUid]; const def = data.cardDefsById[c.def]; const saved = G.playerById(st(), whoActs(st()))?.savedResources.some(x => x.uid === d.action.cardUid);
    return `<button class="btn sellrow" data-key="${attr(G.descKey(d))}" data-uid="${d.action.cardUid}"><img src="${img('card.' + c.def)}" alt="">${esc(def?.name ?? c.def)}${saved ? ' <span class="small">(saved)</span>' : ''} <span class="spacer"></span><b>+${g} Gold</b></button>`; }).join('');
  openModal(`<div class="ask menu" id="sellScreen" style="display:flex;flex-direction:column;gap:8px;min-width:400px"><h2>Sell a card · +${g} Gold each</h2><p class="small">Selling is free (not an action). The card goes to its discard pile (20.p).</p><div class="opts bs-list">${rows || '<span class="small">Nothing to sell.</span>'}</div><div class="foot"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`);
  $$('#sellScreen [data-key]').forEach(b => b.onclick = () => { const d = list.find(x => G.descKey(x) === b.dataset.key); if (!d) return; closeModal(); SND.play('gold_gain'); human(d); });
}
// ------------------------------------------------------------------ M7 item 8: free general move (15.j): once per turn, along your own chain
function openGenMove() {
  const s = st(); const pid = whoActs(s); const list = mineNow().filter(d => d.type === 'MOVE_GENERAL');
  const g = G.playerById(s, pid)?.general; const gen = g ? data.generalsById[g.id] : null;
  const rows = list.map(d => { const p = s.provinces[d.action.to]; return `<button class="btn tgt" data-key="${attr(G.descKey(d))}" data-prov="${d.action.to}"><b>${esc(prov(d.action.to))}</b> <span class="small">${p.troops} troop${p.troops === 1 ? '' : 's'}${p.status === 'allied' ? ' · allied' : ''}</span></button>`; }).join('');
  openModal(`<div class="ask menu" id="genTargets" style="display:flex;flex-direction:column;gap:8px;min-width:420px"><h2>Move ${esc(gen?.name ?? 'your general')} (free)</h2><p class="small">Now in <b>${esc(g?.at ? prov(g.at) : '?')}</b>. Once per turn, any time after the Revolt Roll, along a chain of your own provinces. It is not an action (15.j).</p><div class="opts bs-list">${rows}</div><div class="foot"><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></div>`);
  $$('#genTargets [data-prov]').forEach(b => { b.onmouseenter = () => flashToken(b.dataset.prov); });
  $$('#genTargets [data-key]').forEach(b => b.onclick = () => { const d = list.find(x => G.descKey(x) === b.dataset.key); if (!d) return; closeModal(); human(d); });
}

// ------------------------------------------------------------------ Play a card: pick the card, then (Revolt!, Assassin!, Bribe) pick the enemy province yourself (M6 item 8)
function openCardMenu(legal) {
  const c = G.categorize(legal).card; const byUid = {};
  for (const d of c) (byUid[d.action.cardUid] ??= []).push(d);
  const s = st(); const me = s.turn.activePlayerId; const hand = G.handCards(s.players.find(p => p.id === me));
  const rows = Object.entries(byUid).map(([uid, ds]) => { const def = s.cards[uid].def; return `<button class="btn" data-card="${uid}"><img src="${img('card.' + def)}" alt="" style="height:64px;border-radius:4px;vertical-align:middle;margin-right:6px">${esc(data.cardDefsById[def]?.name ?? def)} <span class="small">(${ds.length} target${ds.length === 1 ? '' : 's'})</span></button>`; }).join('')
    + hand.filter(c => !byUid[c.uid] && data.cardDefsById[s.cards[c.uid].def]?.type !== 'battle').filter((c, i, a) => a.findIndex(x => s.cards[x.uid].def === s.cards[c.uid].def) === i).map(c => { const def = s.cards[c.uid].def; const why = G.cardBlockReason(s, data, me, c.uid); if (!why || Object.keys(byUid).some(u => s.cards[u].def === def)) return ''; return `<div class="btn off cardoff" data-off="${c.uid}"><img src="${img('card.' + def)}" alt="" style="height:64px;border-radius:4px;vertical-align:middle;margin-right:6px;filter:grayscale(1)">${esc(data.cardDefsById[def]?.name ?? def)} <span class="small whynot">${esc(why)}</span></div>`; }).join('');
  openModal(`<div class="ask menu" style="display:flex;flex-direction:column;gap:8px;min-width:380px"><h2>Play a card</h2><div class="opts">${rows || '<p class="small">No card in your hand.</p>'}</div><div class="foot"><span class="small">Playing a card is not an action; one such card per turn (18.h).</span><button class="btn" data-close>Cancel</button></div></div>`);
  $$('#modalBox [data-card]').forEach(b => b.onclick = () => { SND.play('card_flip'); openCardTargets(b.dataset.card); });
}
function targetRow(d) {
  const s = st(); const a = d.action; const def = s.cards[a.cardUid].def;
  if (def === 'revolt') { const p = s.provinces[a.target]; const m = minGarrison(s, data, a.target).min; return { id: a.target, html: `<b>${esc(prov(a.target))}</b> <span class="small">${esc(pn(p.owner))} · ${p.troops} troops · minimum ${m} · the revolt would kill ${Math.min(p.troops, Math.floor(m / 2) + 1)}</span>` }; }
  return { id: G.mainProvince(d), html: esc(d.label) };
}
let cardPick = null;
function openCardTargets(uid) {
  const s = st(); const def = s.cards[uid].def; const list = mineNow().filter(d => d.type === 'PLAY_CARD' && d.action.cardUid === uid);
  cardPick = null;
  const intro = def === 'revolt' ? 'Choose the enemy province to inspire a revolt in. Valid targets: a rival\'s conquered province with fewer than 10 troops; never a starting province, an allied province or Roma (17.c, 17.r, 18.m).' : 'Choose the target.';
  openModal(`<div class="ask menu" id="cardTargets" style="display:flex;flex-direction:column;gap:8px;min-width:420px"><h2>${esc(data.cardDefsById[def]?.name ?? def)}</h2><p class="small">${esc(intro)}</p><div class="opts bs-list">${list.map(d => { const r = targetRow(d); return `<button class="btn tgt" data-pick="${attr(G.descKey(d))}" data-prov="${attr(r.id ?? '')}">${r.html}</button>`; }).join('')}</div><div class="foot"><button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn gold" id="cardGo" disabled>Choose a target first</button></div></div>`);
  $$('#modalBox [data-pick]').forEach(b => b.onclick = () => {
    cardPick = b.dataset.pick; SND.play('province_select');
    $$('#modalBox [data-pick]').forEach(x => x.classList.toggle('on', x === b));
    const go = $('#cardGo'); go.disabled = false; go.dataset.key = cardPick; go.textContent = `Play ${data.cardDefsById[def]?.name ?? def} on ${b.dataset.prov ? prov(b.dataset.prov) : 'this target'} ▶`;
  });
  $('#cardGo').onclick = () => { const d = list.find(x => G.descKey(x) === cardPick); if (!d) return; closeModal(); human(d); };
}
function optionsHtml(list) {
  return list.map(d => {
    const k = attr(G.descKey(d));
    const def = d.action.cardUid ? st().cards[d.action.cardUid]?.def : null;
    const art = def ? `<img src="${img('card.' + def)}" alt="" style="height:64px;border-radius:4px;vertical-align:middle;margin-right:6px">` : '';
    if (d.range) return `<div class="optrow" data-row="${k}">${art}<span>${esc(d.label.replace(/\s*\(\d+-\d+\)$/, ''))}</span><input type="range" min="${d.range.min}" max="${d.range.max}" value="${d.range.max}" data-range-for="${k}"><b class="v">${d.range.max}</b><button class="btn sm gold" data-key="${k}">OK</button></div>`;
    return `<button class="btn" data-key="${k}">${art}${esc(d.label)}</button>`;
  }).join('');
}
function wireOptions(root, list, after) {
  $$('input[data-range-for]', root).forEach(r => { r.oninput = () => { const v = r.parentElement.querySelector('.v'); if (v) v.textContent = r.value; }; });
  $$('[data-key]', root).forEach(b => b.onclick = () => {
    const d = list.find(x => G.descKey(x) === b.dataset.key); if (!d) return;
    const r = $(`input[data-range-for="${CSS.escape(b.dataset.key)}"]`, root);
    const v = r ? +r.value : undefined;
    if (after) after(); human(r ? { ...d, _v: v } : d);
  });
}

function renderPlayers() {
  const s = st(); const host = $('#players'); const f = topFrame(s);
  const trayPid = f?.kind === 'roll' || f?.kind === 'draw' ? (f.player ?? whoActs(s)) : s.phase === 'turn' ? s.turn.activePlayerId : null;
  host.innerHTML = s.players.map(p => {
    const c = col(p.id); const gen = p.general ? data.generalsById[p.general.id] : null;
    const pips = [...Array(data.rules.winPrestige)].map((_, k) => `<div class="pip ${k < p.prestige ? 'on' : ''} ${k === data.rules.winPrestige - 1 ? 'win' : ''}"></div>`).join('');
    const tag = arr => arr.map(x => `<span class="tag gold" title="${attr(data.cardDefsById[s.cards[x.uid].def]?.text)}">${esc(data.cardDefsById[s.cards[x.uid].def]?.name)}</span>`).join('');
    const active = s.phase === 'turn' && s.turn.activePlayerId === p.id;
    const recalled = p.generalRecalledThroughTurn !== null && p.generalRecalledThroughTurn !== undefined && s.turn.number <= p.generalRecalledThroughTurn;
    const tags = tag(p.savedResources) + tag(p.inPlay) + (p.items?.catapult ? `<span class="tag">Catapult ×${p.items.catapult}</span>` : '');
    return `<div class="player ${active ? 'active' : ''} ${p.out ? 'out' : ''}" data-pid="${p.id}" style="--pc:var(--${c})">
      <div class="ph"><span class="nm">${esc(p.name)}</span><span class="gn">${esc(gen?.name ?? 'no general yet')}</span><span class="ctl ${p.controller === 'ai' ? 'ai' : ''}">${p.controller === 'ai' ? 'AI' : 'Human'}</span>${netBadge(p.id)}<span class="turnbadge">▶ ACTIVE TURN</span></div>
      <div class="pbody2">
        <div class="gcard" title="${attr(gen ? gen.name + ': ' + gen.text + ' (click for every perk in detail)' : 'General not chosen yet')}"><img src="${img(gen ? 'general.' + gen.id : 'back.blank')}" alt="${attr(gen?.name ?? '')}">${recalled ? '<div class="oldtext">recalled to Rome</div>' : ''}</div>
        <div class="pstats">
          <div class="prest"><div class="lbl"><span>Prestige</span><span data-prestige>${p.prestige} / ${data.rules.winPrestige}</span></div><div class="pips">${pips}</div></div>
          <div class="pgold" title="Gold"><span class="coin"></span><span>Gold</span><b data-gold>${p.gold}</b></div>
          <div class="res"><div><span>Troops</span><b>${totalTroops(s, p.id)}</b></div><div><span>Provinces</span><b>${ownedBy(s, p.id).length}</b></div><div><span>Cards</span><b>${G.handCount(p)}</b></div></div>
          <div class="sv"><div class="small">Saved resources · in play · items</div><div class="tagrow">${tags || '<span class="small">none</span>'}</div></div>
          <div class="trayhost">${p.id === trayPid ? trayHtml(p.id) : ''}</div>
          ${turnActsHtml(p.id)}
          <div class="small perk" data-caption="${gen?.id ?? ''}" title="${attr(gen ? G.generalView(data, gen.id).perks.map(x => x.name).join(' · ') : '')}">${esc(gen ? G.generalCaption(data, gen.id) : '')}${p.out ? ' · OUT of the game' : ''}</div>
        </div>
      </div></div>`;
  }).join('');
  $$('#players [data-toai]').forEach(b => b.onclick = () => seatToAI(+b.dataset.toai));
  $$('#players [data-seatback]').forEach(b => b.onclick = () => seatBack(+b.dataset.seatback));
  renderNetBanner();
  $$('.player .gcard').forEach(g => g.onclick = () => {
    const p = G.playerById(s, g.closest('.player').dataset.pid); if (!p.general) return;
    openGeneralView(p.general.id, { player: p });   // M8.1: the same detail view as on the setup screen
  });
  $$('.tray .rollbtn, .tray .diebox').forEach(b => b.onclick = () => { const d = mineNow().find(x => x.type === 'ROLL'); if (d) human(d); else { SND.play('error_denied'); toast('No roll is due for you right now'); } });
  $$('#players .pacts [data-key]').forEach(b => b.onclick = () => { const d = mineNow().find(x => G.descKey(x) === b.dataset.key); if (d) human(d); else SND.play('error_denied'); });
  const legal = mineNow();
  $$('#pActs [data-key]').forEach(b => b.onclick = () => { const d = legal.find(x => G.descKey(x) === b.dataset.key); if (d) human(d); else SND.play('error_denied'); });
  $$('#pActs [data-a]').forEach(b => b.onclick = () => { if (busy) return; SND.play('button_click'); ab = ab?.type === b.dataset.a ? null : { type: b.dataset.a, from: null, to: null, n: null, key: null }; setTab(ab ? 'build' : 'table'); render(); });
  $$('#pActs [data-menu]').forEach(b => b.onclick = () => { if (!busy) openMenu(b.dataset.menu, legal); });
  const ba = $('#bAsk'); if (ba) ba.onclick = () => { askPeek = false; renderAsk(mineNow()); };
  const gm = $('#genMove'); if (gm) gm.onclick = () => { SND.play('button_click'); openGenMove(); };
  const sl = $('#panelSell'); if (sl) sl.onclick = () => { SND.play('button_click'); openSell(); };
}
/** M7 items 8 and 10: the active player's own buttons, next to the die: Roll, Draw a card, Move general (free, 15.j), Sell a card (free, 20.p). */
function panelActsHtml(pid) {
  const s = st(); const f = topFrame(s); const legal = mineNow(); if (whoActs(s) !== pid) return '';
  const b = [];
  if (f?.kind === 'roll' && f.purpose !== 'battleRound' && f.purpose !== 'loyalty') for (const d of legal.filter(x => x.type === 'ROLL')) b.push(`<button class="btn sm gold prollbtn" data-key="${attr(G.descKey(d))}"${busy ? ' disabled' : ''}>🎲 ${esc(d.label)}</button>`);
  if (f?.kind === 'draw') for (const d of legal.filter(x => x.type === 'DRAW_CARD')) b.push(`<button class="btn sm gold drawbtn" data-key="${attr(G.descKey(d))}"${busy ? ' disabled' : ''}>🂠 ${esc(d.label)}</button>`);
  return b.length ? `<div class="pacts">${b.join('')}</div>` : '';
}
const ROLL_NAMES = { gameRoll: 'GAME ROLL', revoltRoll: 'REVOLT ROLL', extraRevoltRoll: 'EXTRA REVOLT ROLL', rollOff: 'ROLL-OFF', startNative: 'START NATIVES', nativeRoll: 'NATIVES', loyalty: 'LOYALTY', startProvinces: 'DEAL STARTS' };
/** Batch 4 item 4: the active player's turn actions (Attack, Ally, Move, Buy, Build, Play card, Sell, Scout, More, Move general, End Turn),
 *  in the panel below the Saved resources and the die, beside the general's card; or the button that reopens a pending question. */
function turnActsHtml(pid) {
  const s = st(); const f = topFrame(s); const w = whoActs(s);
  if (s.phase !== 'turn' || w !== pid) return '';
  const legal = mineNow(); if (!legal.length) return '';
  const dis = busy ? ' disabled' : '';
  if (f) return OWN_UI.includes(f.kind) && !(f.kind === 'chooseBattleCards' && f.role === 'defender') ? '' : `<div class="pacts turn" id="pActs"><button class="btn sm gold wide" id="bAsk"${dis}>${esc(G.frameTitle(s, data))}…</button></div>`;
  const c = G.categorize(legal); const b = [];
  for (const t of ['ATTACK', 'ALLY', 'MOVE']) if (c.move.some(d => d.type === t)) b.push(`<button class="btn sm ${ab?.type === t ? 'on' : ''}" data-a="${t}"${dis}>${{ ATTACK: 'Attack', ALLY: 'Ally', MOVE: 'Move' }[t]}</button>`);
  b.push(`<button class="btn sm" data-menu="buy"${dis}>Buy…</button>`, `<button class="btn sm" data-menu="build"${dis}>Build…</button>`);
  const heldCards = G.handCards(G.playerById(s, pid)).some(x => data.cardDefsById[s.cards[x.uid].def]?.type !== 'battle');   // M8 item 3: the menu also says why a card is not playable
  if (c.card.length || heldCards) b.push(`<button class="btn sm" data-menu="card"${dis} title="Play a card from your hand">Card…</button>`);
  if (legal.some(x => x.type === 'SELL_CARD')) b.push(`<button class="btn sm" id="panelSell"${dis} title="Free: +${data.rules.sellCard?.gold ?? 2} Gold per card (20.p)">Sell…</button>`);
  if (c.scout.length) b.push(`<button class="btn sm" data-menu="scout"${dis} title="Scout a target: roll its natives (${c.scout.length} targets)">Scout…</button>`);
  if (c.other.length) b.push(`<button class="btn sm" data-menu="other"${dis} title="${c.other.length} more action(s)">More…</button>`);
  if (legal.some(x => x.type === 'MOVE_GENERAL')) b.push(`<button class="btn sm genbtn" id="genMove"${dis} title="Move your general: free, once per turn, along your own chain (15.j)">⚑ General</button>`);
  else if (s.turn.generalMoved) b.push('<span class="small pnote">General moved this turn</span>');
  const end = c.end[0];
  if (end) b.push(`<button class="btn sm gold endturn wide" id="bEnd" data-key="${attr(G.descKey(end))}" title="${attr(end.label)}"${dis}>End Turn ▶</button>`);
  return `<div class="pacts turn" id="pActs">${b.join('')}</div>`;
}
function trayHtml(pid) {
  const s = st(); const f = topFrame(s);
  const due = f?.kind === 'roll' && (f.player ?? whoActs(s)) === pid && f.purpose !== 'battleRound';
  const mine = due && mineNow().some(d => d.type === 'ROLL');
  const lr = lastRoll[pid];
  const die = due ? f.die : lr?.die ?? 'd10';
  const drawDue = f?.kind === 'draw' && (f.player ?? whoActs(s)) === pid;
  const lbl = drawDue ? `DRAW A ${f.deck === 'resource' ? 'RESOURCE' : f.deck === 'displeased' ? 'ROME IS DISPLEASED' : 'GAME'} CARD` : due ? `${ROLL_NAMES[f.purpose] ?? f.purpose.toUpperCase()} (${f.die})` : f?.kind === 'roll' && f.purpose === 'battleRound' ? 'COMBAT: see the battle window' : lr ? `LAST: ${ROLL_NAMES[lr.purpose] ?? lr.purpose} (${lr.die})` : 'NO ROLL NOW';
  const out = due ? (mine ? 'Click the die or ROLL' : `${pn(pid)} rolls…`) : lr ? `rolled ${lr.value}` : '';
  // batch 4 item 4: no roll or draw in the free part of the turn, so the die folds to one line and the action buttons get the room
  if (!f && s.phase === 'turn') return `<div class="tray off mini" id="tray-${pid}"><div class="trow"><div class="diebox ${die}" data-die="${die}"><img src="${img('dice.' + die)}" alt="${die}"><span class="n">${lr?.value ?? ''}</span></div><div class="tl">${esc(lbl)}${out ? `<div class="tout">${esc(out)}</div>` : ''}</div></div></div>`;
  return `<div class="tray ${due ? 'due' : 'off'}" id="tray-${pid}"><div class="tl">${esc(lbl)}</div><div class="trow"><div class="diebox ${die}" data-die="${die}"><img src="${img('dice.' + die)}" alt="${die}"><span class="n">${due ? '?' : lr?.value ?? ''}</span></div><button class="rollbtn" title="Roll"><img src="${img('ui.buttonRoll')}" alt="ROLL"></button></div><div class="tout">${esc(out)}</div>${panelActsHtml(pid)}</div>`;
}

// ------------------------------------------------------------------ map
function tokenFor(id) { const t = data.provincesById[id].token, sp = data.map.map.tokenSpace; return [t.x / sp.w * 100, t.y / sp.h * 100]; }
/** Provinces a human can click for the current frame or builder step. */
function pickTargets(legal) {
  const f = topFrame(st());
  if (ab && !f) { const tree = G.builderTree(legal, ab.type); return new Set(!ab.from ? Object.keys(tree) : Object.keys(tree[ab.from] ?? {})); }
  if (!f) return new Set();
  if (['chooseProvince', 'setupStartProvince', 'placeTroops', 'resourceBuild'].includes(f.kind) || (f.kind === 'responseWindow' && f.window === 'defenceAnnounced')) return new Set(legal.map(G.mainProvince).filter(Boolean));
  return new Set();
}
function renderMap(legal) {
  const s = st(); const picks = pickTargets(legal); const builder = ab && !topFrame(s);
  const showMin = $('#chkNames').checked; let h = '';
  const mk = (cls, txt, x, y, title = '') => { h += `<div class="mk ${cls}" style="left:${x}%;top:${y}%" title="${attr(title)}">${esc(txt)}</div>`; };
  if (!$('#links').innerHTML) {
    let links = ''; const seen = new Set();
    for (const p of data.provinces) for (const kind of ['land', 'sea']) for (const b of p[kind]) { const k = [p.id, b].sort().join('|') + kind; if (seen.has(k)) continue; seen.add(k); const A = p.token, B = data.provincesById[b].token; links += `<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="${kind === 'sea' ? '#bde3ff' : '#fff'}" stroke-width="1.6" ${kind === 'sea' ? 'stroke-dasharray="5 4"' : ''} opacity=".85"/>`; }
    $('#links').innerHTML = links;
  }
  for (const def of data.provinces) {
    const id = def.id, p = s.provinces[id], [x, y] = tokenFor(id);
    let cls = 'tok ', txt;
    if (id === 'roma' && !p.owner) { cls += 'roma'; txt = p.troops; }
    else if (!p.owner) { cls += 'native'; txt = p.native.present ?? '?'; }
    else { cls += col(p.owner) + (p.status === 'allied' ? ' allied' : ''); txt = p.troops; if (isUnderGarrisoned(s, data, id)) cls += ' low'; }
    if (selected === id) cls += ' sel';
    if (builder) cls += ab.from === id ? ' ab-origin' : ab.to === id ? ' ab-tgt' : picks.has(id) ? ' ab-ok' : ' ab-dim';
    else if (picks.has(id)) cls += ' pick';
    h += `<div class="${cls}" data-id="${id}" style="left:${x}%;top:${y}%" title="${attr(def.name)}">${txt}</div>`;
    if (p.road) mk('road', 'R', x + 2.4, y + 3.9, 'Road');
    for (const w of p.walls ?? []) { const [x2, y2] = tokenFor(w); mk('wall', 'W', x + (x2 - x) * 0.42, y + (y2 - y) * 0.42, 'Wall facing ' + prov(w)); }
    if (showMin) { const m = G.shownMin(s, data, id); if (m?.min) mk('lbl', 'min ' + m.min, x, y + 5.7, 'Minimum garrison'); }
    if (!p.owner && id !== 'roma' && p.native.present !== null && p.native.count !== null && p.native.present < p.native.count) mk('lbl', p.native.present + '/' + p.native.count, x, y + 5.7, 'natives present / count (depleted)');
  }
  for (const pl of s.players) if (pl.general?.at && !pl.out) { const [x, y] = tokenFor(pl.general.at); mk('gen ' + col(pl.id), genLetter(pl.general.id), x - 2.3, y - 3.9, `${data.generalsById[pl.general.id].name} (${pl.name})`); }
  { const [cx, cy] = tokenFor('carthage'); if (!s.provinces.carthage.owner) mk('wall', 'WALLS', cx, cy - 5.8, 'Carthage: walls on all sides'); const [rx, ry] = tokenFor('roma'); mk('wall', 'WALLS', rx, ry - 6.2, 'Roma: walls on all sides'); }
  $('#tokens').innerHTML = h;
  const r = s.provinces.roma; $('#romainfo').innerHTML = `ROMA: ${r.troops} troops · Gold pile ${s.roma?.goldPile ?? 0} · ${r.owner ? 'held by ' + esc(pn(r.owner)) : 'no holder'}<br><span style="opacity:.85">Walls on all sides · Ingrained Loyalty</span>`;
  $$('#tokens .tok').forEach(t => {
    t.onmouseenter = () => { if (!selected) showInfo(t.dataset.id, false); };
    t.onmouseleave = () => { if (selected) showInfo(selected, true); else hideInfo(); };
    t.onclick = e => { e.stopPropagation(); tokenClick(t.dataset.id); };
  });
  if (builder && ab.from && ab.to) drawArrow(ab.from, ab.to, ab.type === 'MOVE' ? '#9bd0ff' : ab.type === 'ALLY' ? '#9dff9d' : '#ffdf7a');
  else if (builder) $('#arrows').innerHTML = '';
}
function tokenClick(id) {
  if (busy) return;
  const s = st(); const legal = mineNow(); const f = topFrame(s);
  if (ab && !f) {
    const tree = G.builderTree(legal, ab.type); const dests = tree[ab.from] ?? {};
    if (ab.from && dests[id]) { ab.to = id; ab.n = null; ab.key = null; ab.borrow = null; ab.perk = null; SND.play('province_select'); }
    else if (id === ab.from) { ab.from = null; ab.to = null; }
    else if (tree[id]) { ab.from = id; ab.to = null; ab.key = null; SND.play('province_select'); }
    else {   // M8 item 4: say why, with the engine's own reason for an attack
      SND.play('error_denied'); const pid = s.turn.activePlayerId;
      const why = ab.type !== 'ATTACK' ? null : ab.from ? G.attackWhy(s, data, pid, ab.from, id) : G.attackOriginWhy(s, data, pid, id);
      ab.why = why ?? (ab.from ? `${prov(id)} is not a legal ${ab.type === 'MOVE' ? 'destination' : 'target'} from ${prov(ab.from)}.` : `${prov(id)} cannot be the origin of this ${ab.type.toLowerCase()}.`);
      toast(ab.why); render(); return;
    }
    ab.why = null;
    setTab('build'); render(); return;
  }
  if (pickTargets(legal).has(id)) {
    const here = legal.filter(d => G.mainProvince(d) === id);
    if (here.length === 1 && !here[0].range) { human(here[0]); return; }
  }
  selected = selected === id ? null : id; SND.play('province_select');
  renderMap(legal); if (selected) showInfo(id, true); else hideInfo();
  $$('#ptab tr[data-id]').forEach(r => r.classList.toggle('sel', r.dataset.id === selected));
}
function showInfo(id, pin) {
  const s = st(); const p = s.provinces[id]; const def = data.provincesById[id]; const [x, y] = tokenFor(id);
  const m = G.shownMin(s, data, id);
  const rows = [
    ['Status', id === 'roma' && !p.owner ? 'Roma (no holder)' : { native: 'Native (unowned)', conquered: 'Conquered', starting: 'Starting province', allied: 'Allied', held: 'Roma (held)' }[p.status] ?? p.status],
    ['Owner', p.owner ? `<b style="color:var(--${col(p.owner)})">${esc(pn(p.owner))}</b>` : '-'],
    ['Number / reward', p.number ? `${p.number} / ${p.reward}` : 'none'],
    ['Troops', p.owner || id === 'roma' ? p.troops : '-'],
    ['Natives count / present', p.native.count === null ? (id === 'roma' ? '-' : 'not rolled yet') : `${p.native.count} / ${p.native.present}`],
    ['Min garrison', m ? `<b>${m.min}</b>` : '-'],
    ['Builds', [p.road ? 'Road' : '', p.walls?.length ? 'Wall facing ' + p.walls.map(prov).join(', ') : ''].filter(Boolean).join('; ') || 'none'],
  ];
  const acts = pin && !ab ? G.forProvince(mineNow(), id).filter(d => !['ATTACK', 'ALLY', 'MOVE', 'END_TURN'].includes(d.type)).slice(0, 8) : [];
  const info = $('#info');
  info.innerHTML = `<h4><span>${esc(def.name)}</span><button class="x" id="infoX">×</button></h4><table>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>${acts.length ? `<div class="opts" style="display:flex;flex-direction:column;gap:3px;margin-top:4px">${optionsHtml(acts)}</div>` : ''}`;
  info.style.setProperty('--ic', p.owner ? `var(--${col(p.owner)})` : id === 'roma' ? 'var(--roma)' : 'var(--native)');
  info.style.display = 'block'; info.classList.toggle('pin', !!pin);
  const mw = $('#mapwrap'), w = mw.clientWidth, hh = mw.clientHeight, iw = info.offsetWidth, ih = info.offsetHeight;
  let px = x / 100 * w + 24, py = y / 100 * hh - ih / 2; if (px + iw > w - 4) px = x / 100 * w - iw - 24; py = Math.max(4, Math.min(hh - ih - 4, py));
  info.style.left = px + 'px'; info.style.top = py + 'px';
  if (acts.length) wireOptions(info, acts, () => { selected = null; hideInfo(); });
  const xb = $('#infoX'); if (xb) xb.onclick = e => { e.stopPropagation(); selected = null; hideInfo(); renderMap(mineNow()); };
}
function hideInfo() { $('#info').style.display = 'none'; $('#info').classList.remove('pin'); }

// ------------------------------------------------------------------ province table
function renderTable() {
  const s = st();
  const rows = data.provinces.map(def => {
    const id = def.id, p = s.provinces[id]; const m = G.shownMin(s, data, id); const under = p.owner ? isUnderGarrisoned(s, data, id) : false;
    const gens = s.players.filter(pl => pl.general?.at === id).map(pl => data.generalsById[pl.general.id].name).join(', ');
    const notes = [];
    if (p.status === 'starting') notes.push('Start province: minimum 1, always loyal.');
    if (p.status === 'allied') notes.push('Allied: no minimum, no bonus troop, no revolt.');
    if (under) notes.push('UNDER-GARRISONED: no bonus troop, no reward.');
    if (id === 'carthage') notes.push(s.carthage?.defeated ? 'Carthage defeated: Decree numbers count as Rome Rolls.' : 'Walls all sides; the Senate Decree target.');
    if (id === 'roma') notes.push('Walls all sides, Ingrained Loyalty; attack needs Battlefield Imperator.');
    return `<tr class="${p.owner ? col(p.owner) : 'none'}${selected === id ? ' sel' : ''}" data-id="${id}"><td>${esc(def.name)}</td><td>${p.number ?? '-'}</td><td>${p.reward ?? '-'}</td><td>${p.owner ? esc(pn(p.owner)) : '-'}</td><td>${p.status}</td>
      <td class="${p.owner ? '' : 'nat-cell'}">${p.native.count === null ? (id === 'roma' ? '-' : '?') : `${p.native.count} / ${p.native.present}`}</td><td>${p.owner || id === 'roma' ? p.troops : '-'}</td>
      <td class="min">${m ? m.min : '-'}</td><td>${under ? '<span class="pk-bad">under</span>' : p.owner ? '<span class="pk-ok">ok</span>' : '-'}</td><td>${[p.road ? 'Road' : '', p.walls?.length ? 'Wall' : ''].filter(Boolean).join(' ')}</td><td>${esc(gens)}</td><td class="notes">${notes.join(' ')}</td></tr>`;
  }).join('');
  $('#ptab').innerHTML = '<thead><tr>' + ['Province', 'No.', 'Reward', 'Owner', 'Status', 'Natives (count / present)', 'Troops', 'Min', 'Garrison', 'Builds', 'General', 'Notes'].map(x => `<th>${x}</th>`).join('') + '</tr></thead><tbody>' + rows + '</tbody>';
  $('#tlegend').innerHTML = s.players.map(p => `<span><i style="background:var(--${col(p.id)})"></i>${esc(p.name)}</span>`).join('') + '<span><i class="none"></i>Unowned</span>';
  $$('#ptab tr[data-id]').forEach(r => r.onclick = () => tokenClick(r.dataset.id));
}

// ------------------------------------------------------------------ decks + hand
function renderDecks(legal) {
  const s = st(); const f = topFrame(s);
  for (const k of ['game', 'resource', 'displeased']) {
    $('#cnt-' + k).textContent = G.deckCount(s, k);
    const d = f?.kind === 'draw' && f.deck === k ? legal.find(x => x.type === 'DRAW_CARD') : null;
    const el = $('#deck-' + k); el.classList.toggle('due', !!d); el.dataset.key = d ? G.descKey(d) : '';
    $('img', el).src = img(G.deckCount(s, k) ? 'deck.' + k : 'deck.empty');
  }
}
function renderHand(legal) {
  const s = st(); const h = G.handFor(s, data, viewer);
  const body = $('#handBody');
  const plays = legal.filter(d => (d.type === 'PLAY_CARD' || d.type === 'USE_SAVED_RESOURCE') && d.action.cardUid);   // batch 5 item 6: a saved Road / Wall is playable from its tile
  if (!h.owner) {
    $('#handTitle').textContent = 'Hands (all hidden)';
    body.innerHTML = s.players.map(p => `<div class="htile back" title="${attr(p.name)}: ${G.handCount(p)} card(s)"><div class="cf art"><img src="${img('back.game')}" alt=""></div><div class="nm">${esc(p.name)}: ${G.handCount(p)}</div></div>`).join('') + '<span class="handnote">AI hands are always hidden.</span>';
  } else {
    const p = G.playerById(s, h.owner);
    $('#handTitle').textContent = `${p.name}'s hand (${h.cards.length})`;
    const tile = (c, extra = '') => `<div class="htile ${plays.some(d => d.action.cardUid === c.uid) ? 'playable' : ''}" data-uid="${c.uid}" title="${attr(c.name + ': ' + c.text)}"><div class="cf art"><img src="${img(c.art)}" alt="${attr(c.name)}"></div><div class="nm">${extra}${esc(c.name)}${c.battle ? `<span class="bclabel">${G.BATTLE_LABEL}</span>` : ''}</div></div>`;
    const others = s.players.filter(x => x.id !== h.owner && G.handCount(x)).map(x => `${esc(x.name)} ${G.handCount(x)}`).join(' · ');
    body.innerHTML = (h.cards.length ? h.cards.map(c => tile(c)).join('') : '<span class="handnote">No cards in hand.</span>')
      + (h.inPlay.length || h.saved.length ? `<div class="inplay">${h.inPlay.map(c => tile(c, 'in play: ')).join('')}${h.saved.map(c => tile(c, 'saved: ')).join('')}</div>` : '')
      + (others ? `<span class="handnote">Others hold: ${others} (hidden)</span>` : '');
    $$('#handBody .htile[data-uid]').forEach(t => t.onclick = () => { SND.play('card_flip'); openCardView(t.dataset.uid); });
  }
  $('#hideCover').classList.toggle('on', hidden && !!h.owner);
  $('#hideWho').textContent = h.owner ? `Only ${G.nameOf(s, h.owner)} may look` : '';
  $('#bHide').textContent = hidden ? 'Show hand' : 'Hide hand'; $('#bHide2').textContent = hidden ? 'Show hand' : 'Hide hand';
}
/** Batch 5 items 6 and 7 (Vidi 2026-10-24): looking at a card makes it playable right there (a target card asks for its target, a
 *  no-target card plays at once, a saved Road / Wall card opens the Build screen on "where"). The view closes by itself after 8 s,
 *  on Close, or on a click anywhere outside it; any click inside it keeps it up. */
function openCardView(uid) {
  const s = st(); const legal = mineNow(); const owner = G.handFor(s, data, viewer).owner;
  const c = G.cardView(data, s.cards[uid].def, uid); const pv = G.cardPlayView(s, data, legal, uid);
  const sell = legal.find(d => d.type === 'SELL_CARD' && d.action.cardUid === uid);
  const play = pv.mode === 'targets' ? `<button class="btn gold" id="playThis" data-mode="targets">Play ${esc(c.name)}: choose the target…</button>`
    : pv.mode === 'now' ? `<button class="btn gold" id="playThis" data-mode="now" data-key="${attr(G.descKey(pv.list[0]))}">Play ${esc(c.name)} now</button>`
    : pv.mode === 'build' ? `<button class="btn gold" id="playThis" data-mode="build" data-piece="${pv.piece}">Use this ${esc(c.name)} card now (free): choose where…</button>`
    : `<p class="small whynot" id="cardWhy">${esc((owner && G.cardBlockReason(s, data, owner, uid)) ?? (c.battle ? "Can't play now: commit it in a battle (18.i)." : pv.reason ?? "Can't play now."))}</p>`;
  let left = CARD_VIEW_MS / 1000;
  const p = openModal(`<div class="cardbig"><img src="${img(c.art)}" alt=""></div><div class="txt" id="cardView" data-uid="${uid}"><h2>${esc(c.name)}</h2>${c.battle ? `<span class="bclabel">${G.BATTLE_LABEL}</span>` : ''}<p>${esc(c.text)}</p>${play}${sell ? `<button class="btn" id="sellThis" data-key="${attr(G.descKey(sell))}">Sell it for ${data.rules.sellCard?.gold ?? 2} Gold (free)</button>` : ''}<button class="btn" data-close id="cvClose">Close</button><p class="small cvtimer" id="cvTimer">Closes by itself in ${left} s, or click anywhere outside the card.</p></div>`, { autoMs: CARD_VIEW_MS, cls: 'cardview' });
  const tick = setInterval(() => { left -= 1; const t = $('#cvTimer'); if (!t || left < 0) { clearInterval(tick); return; } t.textContent = `Closes by itself in ${left} s, or click anywhere outside the card.`; }, 1000);
  p.then(() => clearInterval(tick));
  const pt = $('#playThis');
  if (pt) pt.onclick = () => {
    clearInterval(tick);
    if (pt.dataset.mode === 'targets') { SND.play('card_flip'); openCardTargets(uid); return; }
    if (pt.dataset.mode === 'now') { const d = pv.list[0]; closeModal(); human(d); return; }
    closeModal(); SND.play('button_click'); openBuild(pt.dataset.piece, uid);
  };
  const sb = $('#sellThis'); if (sb) sb.onclick = () => { closeModal(); SND.play('gold_gain'); human(sell); };
}
function renderLog() {
  $('#log').innerHTML = G.logFor(st(), data, 150, viewer).map(l => `<li class="${l.cls}">${esc(l.text)}${l.rule ? `<span class="r">${esc(l.rule)}</span>` : ''}</li>`).join('');
}

// ------------------------------------------------------------------ builder (attack / ally / move, then Borrow, Battle cards, perk)
const BUILDER_FRAMES = ['chooseBorrow', 'chooseBattleCards', 'choosePerk'];
function builderFrame(legal) { const f = topFrame(st()); return f && BUILDER_FRAMES.includes(f.kind) && legal.length && !(f.kind === 'chooseBattleCards' && f.role === 'defender') ? f : null; }
function renderBuilder(legal) {
  const pane = $('#pane-build'); const s = st(); const f = builderFrame(legal);
  const show = !!ab || !!f;
  $('#tabBuild').style.display = show ? '' : 'none';
  if (!show) { pane.innerHTML = ''; if (tab === 'build') setTab(bv ? 'battle' : 'table'); return; }
  const me = whoActs(s); const c = col(me);
  const type = f ? (s.battle?.mode === 'decree' ? 'DECREE' : 'ATTACK') : ab.type;
  const keys = type === 'ATTACK' ? ['Origin', 'Target', 'Troops + Borrow', 'Battle cards', 'Battle'] : type === 'DECREE' ? ['Battle cards', 'Battle'] : ['Origin', type === 'MOVE' ? 'Destination' : 'Target', 'Troops', 'Confirm'];
  const cur = f ? { chooseBorrow: 'Troops + Borrow', chooseBattleCards: 'Battle cards', choosePerk: 'Battle' }[f.kind] : !ab.from ? 'Origin' : !ab.to ? (type === 'MOVE' ? 'Destination' : 'Target') : type === 'ATTACK' ? 'Troops + Borrow' : 'Troops';
  const ci = keys.indexOf(cur);
  const steps = keys.map((k, i) => `<span class="bd-step ${i === ci ? 'cur' : i < ci ? 'done' : ''}">${k}</span>`).join('');
  let left = '', mid = '', right = '';
  if (f) {
    const b = s.battle;
    left = b ? `<div class="bd-card" style="--bc:var(--${c})"><b class="big">FROM ${esc(b.att.from ? prov(b.att.from) : 'the legions')}</b><br>${b.att.own} own troop(s)${b.att.general ? ' + general' : ''}</div><div class="bd-card" style="--bc:var(--native)"><b class="big">AGAINST ${esc(prov(b.target))}</b><br>${b.def.player ? esc(pn(b.def.player)) : b.def.kind}</div>` : '';
    if (f.kind === 'chooseBorrow') {
      const d = legal.find(x => x.type === 'CHOOSE_BORROW'); const k = attr(G.descKey(d));
      mid = `<div class="bd-ask"><div class="q">Borrow native troops from ${esc(prov(b?.att.from))}? <span class="small">(optional)</span></div>
        <div class="bd-row"><label>Borrow</label><input type="range" min="${d.range.min}" max="${d.range.max}" value="0" data-range-for="${k}" style="--bc:var(--${c})"><b class="bd-num v">0</b></div>
        <div class="bd-quick"><button class="btn sm" data-q="0">Don't borrow (0)</button><button class="btn sm" data-q="${d.range.max}">Borrow max (${d.range.max})</button></div>
        <div class="small">Borrowed troops always die first and go home if they survive; a borrowed death forces an extra Revolt Roll (19.d).</div>
        <div class="bd-btns"><button class="btn confirm" id="abConfirm" data-key="${k}">Confirm borrow ▶</button></div></div>`;
    } else if (f.kind === 'chooseBattleCards') {
      mid = `<div class="bd-ask"><div class="q">Tick the battle cards to use <span class="small">(optional, stackable)</span></div><div class="opts" style="display:flex;flex-direction:column;gap:4px">${cardChoiceHtml(legal, f)}</div></div>`;
      right = `<div class="small">Your battle cards: ${Object.entries(f.held ?? {}).map(([def, n]) => `${esc(data.cardDefsById[def]?.name)} ×${n} <span class="bclabel" style="display:inline">${G.BATTLE_LABEL}</span>`).join(', ')}</div>`;
    } else mid = `<div class="bd-ask"><div class="q">${esc(G.frameTitle(s, data))}</div><div class="opts" style="display:flex;flex-direction:column;gap:4px">${optionsHtml(legal)}</div></div>`;
  } else {
    const tree = G.builderTree(legal, ab.type);
    const tp = ab.to ? s.provinces[ab.to] : null;
    left = (ab.from ? `<div class="bd-card" style="--bc:var(--${c})"><b class="big">FROM ${esc(prov(ab.from))}</b><br>${s.provinces[ab.from].troops} troops</div>` : '<div class="bd-card empty"><b>FROM</b> (not chosen yet)<br><span class="small">Click a green-ringed province of yours on the map.</span></div>')
      + (tp ? `<div class="bd-card" style="--bc:${tp.owner ? `var(--${col(tp.owner)})` : 'var(--native)'}"><b class="big">${ab.type === 'MOVE' ? 'TO' : 'AGAINST'} ${esc(prov(ab.to))}</b><br>${tp.owner ? esc(pn(tp.owner)) + ' · ' + tp.troops + ' troops' : 'natives ' + (tp.native.present ?? '? (rolled when you attack)')}</div>` : `<div class="bd-card empty"><b>${ab.type === 'MOVE' ? 'TO' : 'TARGET'}</b> (not chosen yet)</div>`);
    if (ab.from && ab.to) {
      const vars = tree[ab.from]?.[ab.to] ?? [];
      // item 2: an ATTACK defaults to WITH the general when he stands on the origin
      if (!ab.key || !vars.some(v => G.descKey(v) === ab.key)) { const d0 = ab.type === 'ATTACK' ? G.builderVariant(vars, true) : vars[0]; ab.key = d0 ? G.descKey(d0) : null; }
      const v = vars.find(x => G.descKey(x) === ab.key);
      const gv = vars.find(x => x.action.withGeneral), ng = vars.find(x => !x.action.withGeneral);
      const gName = data.generalsById[G.playerById(s, me).general?.id]?.name ?? 'the general';
      if (ab.type === 'ATTACK' && gv && ng) mid = `<label class="bd-gen"><input type="checkbox" id="abGen" ${v?.action.withGeneral ? 'checked' : ''}> Attack WITH ${esc(gName)} (he is in ${esc(prov(ab.from))})</label>`;
      else if (vars.length > 1) mid = `<div class="opts" style="display:flex;flex-direction:column;gap:3px">${vars.map(x => `<label class="small"><input type="radio" name="abv" value="${attr(G.descKey(x))}" ${G.descKey(x) === ab.key ? 'checked' : ''}> ${esc(x.label)}</label>`).join('')}</div>`;
      else mid = `<div class="small">${esc(v?.label ?? '')}</div>`;
      if (v?.range) { const n = Math.max(v.range.min, Math.min(v.range.max, ab.n ?? v.range.max)); ab.n = n; mid += `<div class="bd-row"><label>Troops</label><button class="bd-pm" data-d="-1">−</button><input type="range" id="abN" min="${v.range.min}" max="${v.range.max}" value="${n}" data-range-for="${attr(ab.key)}" style="--bc:var(--${c})"><button class="bd-pm" data-d="1">+</button><b class="bd-num v">${n}</b></div><div class="small">${v.range.min} to ${v.range.max} may go.</div>`; }
      if (ab.type === 'ATTACK' && v) {
        const pv = G.attackPreview(s, data, { ...v.action, troops: ab.n ?? v.action.troops });
        // item 3: Borrow on the same screen (19.c: optional, locked before the first roll)
        if (pv.borrowMax >= 1) {
          const bn = Math.max(0, Math.min(pv.borrowMax, ab.borrow ?? 0)); ab.borrow = bn;
          mid += `<div class="bd-row"><label>Borrow</label><button class="bd-pm" data-bd="-1">−</button><input type="range" id="abB" min="0" max="${pv.borrowMax}" value="${bn}" style="--bc:var(--native)"><button class="bd-pm" data-bd="1">+</button><b class="bd-num vb">${bn}</b></div><div class="small">Borrow 0 to ${pv.borrowMax} native troop(s) of ${esc(prov(ab.from))} (19.c). Borrowed troops die first; a borrowed death forces an extra Revolt Roll (19.d).</div>`;
        } else { ab.borrow = 0; mid += `<div class="small">Borrow: none possible from ${esc(prov(ab.from))} (19.c).</div>`; }
        const scipio = pv.perks.find(p => p.side === 'attacker' && p.general === 'scipio' && p.applies);
        // batch 5 item 3 (Vidi 2026-10-24): Scipio keeps only the extra die; nothing to choose, it applies by itself
        ab.perk = null; if (scipio) mid += `<div class="bd-row bd-perk" id="abScipio"><label>Scipio</label><span class="small">rolls an extra die: ${pv.sea ? '3' : '4'} dice v 2 (15.c), by himself</span></div>`;
        // item 5: the general perks that will apply in this battle
        const pk = pv.perks.length ? pv.perks.map(p => `<li class="${p.applies ? 'on' : 'off'}">${p.applies ? '✔' : '✖'} ${esc(p.text)}</li>`).join('') : '<li class="off">none</li>';
        const held = G.handCards(G.playerById(s, me)).filter(x => data.cardDefsById[s.cards[x.uid].def].type === 'battle').length;
        right = `<div class="bd-perks" id="abPerks"><b>General perks in this battle</b><ul>${pv.perks.some(p => p.applies) ? pk : (pv.perks.length ? pk + '<li class="off"><b>none apply</b></li>' : pk)}</ul>`
          + `<div class="small">${pv.sea ? 'Sea attack: 2 dice (17.n).' : 'Land attack: 3 dice.'}${pv.wall ? ` Defender Wall: 3 defence dice${pv.wallRollsIgnored ? `, ignored for the first ${pv.wallRollsIgnored} roll(s) (${esc(pv.wallSources.join(', '))})` : ''}.` : ''}</div>`
          + `<div class="small">${held ? `You hold ${held} battle card(s): you choose them next.` : 'No battle cards in hand.'}</div></div>`;
      }
      mid += `<div class="bd-btns"><button class="btn" id="abCancel">Cancel</button><button class="btn confirm" id="abConfirm" data-key="${attr(ab.key ?? '')}">Confirm ${ab.type.toLowerCase()} ▶</button></div>`;
    } else {
      mid = `<div class="hint"><b>Green ring</b> = legal. ${!ab.from ? `Step 1: click the province your troops leave from (${Object.keys(tree).length} possible).` : `Step 2: click the ${ab.type === 'MOVE' ? 'destination' : 'target'} (${Object.keys(tree[ab.from] ?? {}).length} possible). Click the origin again to change it.`}</div>${ab.why ? `<div class="whynot" id="abWhy">⛔ ${esc(ab.why)}</div>` : ''}<div class="bd-btns"><button class="btn" id="abCancel">Cancel</button></div>`;
    }
  }
  pane.innerHTML = `<div class="builder" style="--bc:var(--${c})"><div class="bd-head"><span class="bd-title" style="color:var(--${c})">${type} BUILDER</span><span class="bd-steps">${steps}</span><span class="spacer"></span><span class="small">${esc(pn(me))}</span></div><div class="bd-grid"><div class="bd-col">${left}</div><div class="bd-col">${mid}</div><div class="bd-col">${right}</div></div></div>`;
  if (f && tab !== 'build') setTab('build');
  $$('#pane-build input[type=range]').forEach(r => {
    r.oninput = () => { const v = r.parentElement.querySelector(r.id === 'abB' ? '.vb' : '.v'); if (v) v.textContent = r.value; if (r.id === 'abN') ab.n = +r.value; if (r.id === 'abB') ab.borrow = +r.value; };
    if (r.id === 'abN') r.onchange = () => { ab.n = +r.value; renderBuilder(mineNow()); };
  });
  $$('#pane-build [data-bd]').forEach(b => b.onclick = () => { const r = $('#abB'); r.value = Math.max(0, Math.min(+r.max, +r.value + +b.dataset.bd)); r.oninput(); });
  const gb = $('#abGen'); if (gb) gb.onchange = () => { const vars = G.builderTree(mineNow(), ab.type)[ab.from]?.[ab.to] ?? []; const d = G.builderVariant(vars, gb.checked); ab.key = d ? G.descKey(d) : ab.key; ab.perk = null; renderBuilder(mineNow()); };
  $$('#pane-build [data-q]').forEach(b => b.onclick = () => { const r = $('#pane-build input[type=range]'); r.value = b.dataset.q; r.oninput(); });
  $$('#pane-build [data-d]').forEach(b => b.onclick = () => { const r = $('#abN'); r.value = Math.max(+r.min, Math.min(+r.max, +r.value + +b.dataset.d)); r.oninput(); });
  $$('#pane-build input[name=abv]').forEach(r => r.onchange = () => { ab.key = r.value; renderBuilder(mineNow()); });
  const cx = $('#abCancel'); if (cx) cx.onclick = () => { ab = null; $('#arrows').innerHTML = ''; setTab('table'); render(); };
  $$('#pane-build [data-key]').forEach(b => b.onclick = () => {
    const d = legal.find(x => G.descKey(x) === b.dataset.key); if (!d) { SND.play('error_denied'); return; }
    const r = $(`#pane-build input[data-range-for="${CSS.escape(b.dataset.key)}"]`);
    if (!f && ab?.type === 'ATTACK' && d.type === 'ATTACK') {     // items 3 and 5: borrow and Scipio's perk travel with the ATTACK itself
      if (busy) return; SND.play('button_click');
      const act = { ...G.withValue(d, r ? +r.value : d.range.max) };
      if ($('#abB')) act.borrow = +$('#abB').value; else act.borrow = 0;
      if (ab.perk && act.withGeneral) act.perk = ab.perk;
      apply(act); return;
    }
    human(r ? { ...d, _v: +r.value } : d);
  });
  if (f?.kind === 'chooseBattleCards') wireCardChecks($('#pane-build'), legal);
}
// batch 5 item 4 (Vidi 2026-10-24): one checkbox per battle card held; tick the ones to use, then confirm (none ticked = no cards)
const cardChoiceHtml = (legal, f = topFrame(st())) => {
  const items = G.battleCardChecklist(data, f?.held);
  return `<div class="bcchecks" id="bcChecks">${items.map(c => `<label class="bccheck" data-def="${attr(c.def)}"><input type="checkbox" data-bc="${attr(c.def)}"><img src="${img(c.art)}" alt=""><span><b>${esc(c.name)}</b> <span class="bclabel" style="display:inline">${G.BATTLE_LABEL}</span><br><span class="small">${esc(c.text)}</span></span></label>`).join('')}</div>`
    + `<div class="bd-btns"><button class="btn confirm" id="bcConfirm">Use the ticked cards ▶</button></div><div class="small" id="bcSum">No card ticked: you fight without battle cards.</div>`
    + (G.battleCardsHint(data, f?.role) ? `<div class="small bchint" id="bcHint">${esc(G.battleCardsHint(data, f?.role))}</div>` : '');
};
function wireCardChecks(root, legal, after) {
  const boxes = $$('input[data-bc]', root); const btn = $('#bcConfirm', root); if (!btn) return;
  const ticked = () => boxes.filter(b => b.checked).map(b => b.dataset.bc);
  const sync = () => { const t = ticked(); boxes.forEach(b => b.closest('.bccheck')?.classList.toggle('on', b.checked)); $('#bcSum', root).textContent = t.length ? `${t.length} card(s) ticked: ${t.map(d => data.cardDefsById[d]?.name ?? d).join(', ')}.` : 'No card ticked: you fight without battle cards.'; btn.textContent = t.length ? `Use ${t.length} card(s) ▶` : 'Fight without battle cards ▶'; };
  boxes.forEach(b => { b.onchange = () => { SND.play('button_click'); sync(); }; });
  btn.onclick = () => { const d = G.battleCardsChoice(legal, ticked()); if (!d) { SND.play('error_denied'); toast('That combination cannot be played'); return; } if (after) after(); human(d); };
  sync();
}
function renderBattleCtl(legal) {
  const f = topFrame(st()); let h = '';
  if (!busy && st().battle && f && ((f.kind === 'roll' && (f.purpose === 'battleRound' || f.purpose === 'loyalty')) || f.kind === 'battleContinue')) {
    h = legal.map(d => `<button class="btn sm ${d.type === 'BATTLE_RETREAT' ? '' : 'gold'}" data-key="${attr(G.descKey(d))}">${esc(d.label)}</button>`).join('');
    if (legal.length && st().battle) openBattlePop();
  }
  if (st().battle && !bv) { const b = st().battle; const gn = pid => { const g = G.playerById(st(), pid)?.general; return g ? data.generalsById[g.id]?.name : null; }; bv = { title: `BATTLE for ${prov(b.target)}`, att: pn(b.att.player), attCls: col(b.att.player), def: b.def.player ? pn(b.def.player) : 'natives', defCls: b.def.player ? col(b.def.player) : 'nat', rounds: [], aCount: b.att.own + b.att.borrowed, dCount: null, borrowed: b.att.borrowed, attId: b.att.player, defId: b.def.player, aGen: b.att.general ? `General ${gn(b.att.player) ?? ''} leads the army` : 'no general', dGen: b.def.general ? `General ${gn(b.def.player) ?? ''} defends` : b.def.player ? 'no general here' : 'natives: no general', perks: { a: new Map(), d: new Map() } }; renderBattleHead(true); }
  $('#bCtl').innerHTML = h;
  $$('#bCtl [data-key]').forEach(b => b.onclick = () => { const d = legal.find(x => G.descKey(x) === b.dataset.key); if (d) human(d); });
}

// ------------------------------------------------------------------ the decision prompt (every other pending frame a human answers)
let askFrame = null;
const OWN_UI = ['roll', 'draw', 'battleContinue', ...BUILDER_FRAMES];
function renderAsk(legal) {
  const s = st(); const f = topFrame(s); const ov = $('#ovAsk'); const box = $('#askBox');
  const need = f && legal.length && !busy && !(OWN_UI.includes(f.kind) && !(f.kind === 'chooseBattleCards' && f.role === 'defender'));
  if (!need) { ov.classList.remove('on', 'peek'); box.innerHTML = ''; return; }
  if (askFrame !== f.id) { askFrame = f.id; askPeek = false; }   // a new prompt always opens in full
  const w = whoActs(s);
  let body;
  if (f.kind === 'setupGeneral') body = `<div class="cards">${legal.map(d => { const g = data.generalsById[d.action.general]; return `<button class="pickcard" data-key="${attr(G.descKey(d))}"><img src="${img(g ? 'general.' + g.id : 'back.blank')}" alt=""><b>${esc(g?.name ?? 'Random')}</b><span class="small">${esc(g ? G.generalCaption(data, g.id) : 'a random free general')}</span></button>`; }).join('')}</div>`;
  else if (f.kind === 'chooseBattleCards') body = `<div class="opts">${cardChoiceHtml(legal, f)}</div>`;
  else if (f.kind === 'resourceBuild') {          // item 9: the same step-by-step screen for a Bonus Road / Wall card just drawn
    if (!bs || bs.frame !== f.id) bs = { frame: f.id, piece: f.piece, province: null, facing: null };
    box.innerHTML = buildHtml(G.buildSteps(s, data, legal), true) + `<div class="foot"><button class="btn sm" id="askPeek">${askPeek ? 'Back to the choice' : 'Look at the map'}</button></div>`;
    ov.classList.add('on'); ov.classList.toggle('peek', askPeek);
    wireBuild(box, legal, () => renderAsk(mineNow()), () => { bs = null; askPeek = false; ov.classList.remove('on'); });
    $('#askPeek').onclick = () => { askPeek = !askPeek; renderAsk(mineNow()); };
    return;
  }
  else {
    const shown = f.kind === 'responseWindow' && f.window === 'displeasedResponse' ? `<div class="cards"><div class="pickcard"><img src="${img('card.' + f.def)}" alt=""><span class="small">${esc(data.cardDefsById[f.def]?.name)}</span></div></div>` : '';
    // batch 5 item 5: the Horn has no troop cap; the slider already stops at what may leave (1 stays, a held Roma keeps 10, Roma holds 20 at most)
    const horn = f.kind === 'responseWindow' && f.window === 'defenceAnnounced' ? `<p class="small" id="hornNote">Horn of Titus Pullus: bring <b>any number</b> of troops from ONE bordering province of yours, allied ones included (no cap); at least 1 stays there${f.sources?.some(x => x.province === 'roma') ? ', and a held Roma keeps its 10' : ''}${f.target === 'roma' ? '; Roma holds 20 troops at most' : ''}. Only one Horn per battle (18.y).</p>` : '';
    body = shown + horn + `<div class="opts">${optionsHtml(legal)}</div>`;
  }
  box.innerHTML = `<h2>${esc(G.frameTitle(s, data))}</h2><div><b style="color:var(--${col(w)})">${esc(pn(w))}</b>: ${esc(G.describePrompt(s, data).replace(/^.*?: /, ''))}</div>${body}<div class="foot"><button class="btn sm" id="askPeek">${askPeek ? 'Back to the choice' : 'Look at the map'}</button><span class="small">${pickTargets(legal).size ? 'You can also click a glowing province on the map.' : ''}</span></div>`;
  ov.classList.add('on'); ov.classList.toggle('peek', askPeek);
  wireOptions(box, legal, () => { askPeek = false; ov.classList.remove('on'); });
  if (f.kind === 'chooseBattleCards') wireCardChecks(box, legal, () => { askPeek = false; ov.classList.remove('on'); });
  $('#askPeek').onclick = () => { askPeek = !askPeek; renderAsk(mineNow()); };
}
const BATTLE_DICE = new Set(['battleRound', 'battleAttack', 'battleDefence']);
/** Batch 4 item 3: show or hide the Provinces / Battle section under the map; the map grows into the room. The Builder still
 *  opens while the section is hidden (it is where Attack / Ally / Move are set up). */
let tabsHidden = false; try { tabsHidden = localStorage.getItem('imperator.tabsHidden') === '1'; } catch { /* */ }
function applyTabsHidden() {
  document.body.classList.toggle('tabshidden', tabsHidden);
  const b = $('#tabsToggle'); if (!b) return;
  b.textContent = tabsHidden ? '▴ Show Provinces / Battle' : '▾ Hide'; b.setAttribute('aria-pressed', tabsHidden ? 'true' : 'false');
  b.title = tabsHidden ? 'Show the Provinces / Battle section again' : 'Hide the Provinces / Battle section: the map gets the room';
}
function setTabsHidden(h) { tabsHidden = !!h; try { localStorage.setItem('imperator.tabsHidden', tabsHidden ? '1' : '0'); } catch { /* */ } applyTabsHidden(); if (S) renderMap(mineNow()); }
function setTab(t) { tab = t; document.body.classList.toggle('battletab', t === 'battle' || t === 'build'); document.body.classList.toggle('tabforce', t === 'build'); $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t)); $$('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + t)); }

// ------------------------------------------------------------------ save / load / game over
/** M14: a host's save keeps the room (code, seats, guest tokens, the seed salt), so "Resume online game" can reopen it. */
const withOnline = o => (NET?.role === 'host' && NET.me && NET.room.started ? { ...o, online: { code: NET.code, me: NET.me, salt: NET.salt, room: NET.room.snapshot() } } : o);
const makeSaveNow = kind => withOnline(G.makeSave(S, { appVersion: uiLabel, kind }));
function autosave() { if (!S || NET?.role === 'guest') return; try { localStorage.setItem('imperator.autosave', JSON.stringify(makeSaveNow('autosave'))); } catch (e) { console.warn('autosave failed', e.message); } }
function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function saveMenu() {
  if (!S) { toast('No game to save yet'); return; }
  openModal(`<div class="ask" style="display:flex;flex-direction:column;gap:8px;min-width:380px"><h2>Save game</h2><button class="btn gold" id="svSlot">Save in this browser</button><button class="btn" id="svFile">Export a JSON file</button><p class="small">The file holds everything, hidden hands included: keep it for yourself, do not share it mid-game. The game also autosaves after every move.${NET?.role === 'host' ? ' An online game\'s save also keeps the room and your friends\' seats: load it and choose "Resume online" to reopen the room.' : ''}</p><button class="btn" data-close>Close</button></div>`);
  $('#svSlot').onclick = () => { try { localStorage.setItem('imperator.save.slot1', JSON.stringify(makeSaveNow('slot'))); toast('Saved in this browser'); SND.play('card_play'); closeModal(); } catch (e) { toast('Could not save: ' + e.message); } };
  $('#svFile').onclick = () => { download(G.saveFileName(st()), JSON.stringify(makeSaveNow('file'))); toast('Save file exported'); closeModal(); };
}
function loadMenu() {
  const get = k => { try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : null; } catch { return null; } };
  const slot = get('imperator.save.slot1'), auto = get('imperator.autosave');
  const when = o => (o ? `${new Date(o.meta.savedAt).toLocaleString('en-US', { timeZone: 'America/Edmonton', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} MT · turn ${o.snapshot?.turn?.number ?? 0} · ${(o.snapshot?.players ?? []).map(p => p.name).join(', ')}${o.meta?.appVersion ? ' · made by ' + String(o.meta.appVersion).split(' · ')[0] : ''}` : 'none');
  openModal(`<div class="ask" style="display:flex;flex-direction:column;gap:8px;min-width:420px"><h2>Load game</h2>
    <button class="btn gold" id="ldSlot" ${slot ? '' : 'disabled'}>Browser save: ${esc(when(slot))}</button>
    <button class="btn" id="ldAuto" ${auto ? '' : 'disabled'}>Autosave: ${esc(when(auto))}</button>
    <button class="btn" id="ldFile">Import a JSON file…</button><div class="errors" id="ldErr"></div><button class="btn" data-close>Close</button></div>`);
  $('#ldSlot').onclick = () => loadFrom(slot); $('#ldAuto').onclick = () => loadFrom(auto);
  $('#ldFile').onclick = () => $('#importFile').click();
}
function loadFrom(obj, { local = false } = {}) {
  const on = !local && onlineSave(obj);
  if (on) {   // M14: a hosted online game: reopen the room, or play it on this computer
    openModal(`<div class="ask" id="resumeAsk"><h2>An online game</h2><p>This save is an online game you hosted (room <b>${esc(on.online.code)}</b>, turn ${on.snapshot?.turn?.number ?? 0}).</p>
      <div class="row"><button class="btn gold" id="raOnline">🌐 Resume online</button><button class="btn" id="raLocal">Play it on this computer</button></div><div class="errors" id="ldErr"></div></div>`);
    $('#raOnline').onclick = () => resumeOnline(on); $('#raLocal').onclick = () => loadFrom(on, { local: true });
    return true;
  }
  const show = m => { const el = $('#ldErr') ?? (document.body.dataset.screen === 'setup' ? $('#setupErrors') : null); if (el) el.textContent = m; else toast(m); };
  let ns; try { ns = G.readSave(obj, data); } catch (e) { show(e.message); return false; }
  if (NET) { netLeave(); playWhere = 'local'; }   // M11: a loaded save is played on this computer
  const prev = S; clearTimeout(aiTimer); S = ns; closeModal();
  try { enterGame(); } catch (e) { console.warn('load', e); S = prev; if (prev) { render(); schedule(); } else renderSetup(); show('This save could not be shown by this build: ' + e.message + ' (the file itself is not changed).'); return false; }
  toast('Game loaded'); SND.play('deck_shuffle'); return true;
}
function showGameOver() {
  const s = st(); if (s.phase !== 'finished' || overShown) return; overShown = true;
  const w = G.playerById(s, s.winner);
  SND.play(G.soundsFor({ type: 'gameWon', pub: { player: s.winner } }, s)[0]);
  const rows = [...s.players].sort((a, b) => b.prestige - a.prestige).map(p => `<tr><td style="color:var(--${col(p.id)});font-weight:800;background:#f3e7c4">${esc(p.name)}</td><td>${p.controller === 'ai' ? 'AI' : 'Human'}</td><td>${p.prestige}</td><td>${ownedBy(s, p.id).length}</td><td>${totalTroops(s, p.id)}</td><td>${p.gold}</td></tr>`).join('');
  const ov = $('#ovOver');
  ov.innerHTML = `<h1>IMPERATOR!</h1><div style="font-size:1.6em"><b style="color:var(--${col(w.id)});background:#f3e7c4;padding:0 10px;border-radius:6px" id="winnerName">${esc(w.name)}</b> wins${w.prestige >= data.rules.winPrestige ? ` with ${w.prestige} Prestige` : ' as the last player standing'} on turn ${s.turn.number}.</div>
    <table id="finalTable"><tr><th>Player</th><th>Seat</th><th>Prestige</th><th>Provinces</th><th>Troops</th><th>Gold</th></tr>${rows}</table>
    <div class="row"><button class="btn gold big" id="ovNew">New game</button><button class="btn" id="ovLook">Look at the board</button>${NET?.role === 'guest' ? '' : '<button class="btn" id="ovExport">Export the save</button>'}</div>`;
  ov.classList.add('on'); document.body.dataset.over = s.winner;
  $('#ovNew').onclick = () => { ov.classList.remove('on'); toSetup(); };
  $('#ovLook').onclick = () => ov.classList.remove('on');
  if ($('#ovExport')) $('#ovExport').onclick = () => download(G.saveFileName(s), JSON.stringify(G.makeSave(S, { appVersion: uiLabel, kind: 'final' })));
}
function toSetup() { if (NET) { netLeave(); playWhere = 'local'; } clearTimeout(aiTimer); $('#toast').classList.remove('on'); S = null; document.body.dataset.over = ''; ['#ovOver', '#ovAsk', '#ovModal'].forEach(x => $(x).classList.remove('on')); renderSetup(); }

// ------------------------------------------------------------------ static wiring
function wireStatic() {
  $('#bSound').onclick = () => SND.toggle();
  $('#speed').onchange = e => { speed = Number(e.target.value) || 1; try { localStorage.setItem('imperator.speed', String(speed)); } catch { /* */ } };
  $('#bSave').onclick = saveMenu; $('#bLoad').onclick = loadMenu; $('#setupLoad').onclick = loadMenu;
  $('#bNew').onclick = () => { if (!S || S && st().phase === 'finished' || window.confirm(NET?.role === 'guest' ? 'Leave this online game?' : NET ? 'Leave this online game? Your guests are disconnected (it stays in your autosave).' : 'Leave this game? It stays in the autosave.')) toSetup(); };
  $$('#playWhere .segb').forEach(b => b.onclick = () => setPlayWhere(b.dataset.where));
  $('#hostCopy').onclick = () => { const t = $('#hostLink').value; navigator.clipboard?.writeText(t).then(() => toast('Link copied'), () => { $('#hostLink').select(); }); };
  $('#joinGo').onclick = joinGame;
  // M14: a closed or reloaded tab says goodbye, so the other side knows at once (a host: guests start reconnecting and wait
  // for "Resume online game"; a guest: its seat shows as away). The host's autosave already has the room.
  window.addEventListener('pagehide', () => { if (!NET) return; try { if (NET.role === 'host') { autosave(); NET.room.close('HOST_LEFT'); } else NET.client.leave(); } catch { /* */ } });
  $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
  try { $('#joinName').value = localStorage.getItem('imperator.online.name') || ''; } catch { /* */ }
  const toggleHide = () => { hidden = !hidden; SND.play('card_flip'); if (S) renderHand(mineNow()); };
  $('#bHide').onclick = toggleHide; $('#bHide2').onclick = toggleHide; $('#bReveal').onclick = toggleHide;
  $('#addSeat').onclick = () => setSeatCount(3);
  $('#delSeat').onclick = () => setSeatCount(2);
  $$('#pCount .segb').forEach(b => b.onclick = () => setSeatCount(+b.dataset.n));
  $('#spImg').src = img('map');
  $('#startMode').onchange = renderSetup;
  $('#seed').addEventListener('input', () => { if (rollOff) { resetRollOff(); renderSetup(); } });   // Q110: a new seed means a new roll-off
  $('#startGame').onclick = startGame;
  $('#resumeOnline').onclick = () => { const o = onlineSave(localStorage.getItem('imperator.autosave')); if (o) resumeOnline(o); };
  $('#resumeAuto').onclick = () => { try { loadFrom(JSON.parse(localStorage.getItem('imperator.autosave'))); } catch (e) { $('#setupErrors').textContent = 'The autosave could not be read: ' + e.message; } };
  $('#importFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; const text = await f.text(); e.target.value = ''; let o = text; try { o = JSON.parse(text); } catch { /* readSave says why */ } loadFrom(o); };
  $$('.tab').forEach(b => b.onclick = () => { if (tabsHidden) setTabsHidden(false); setTab(b.dataset.tab); });
  $('#tabsToggle').onclick = () => { SND.play('button_click'); setTabsHidden(!tabsHidden); };
  applyTabsHidden();
  $$('.deck[data-deck]').forEach(d => d.onclick = () => { const k = d.dataset.key; const x = k && mineNow().find(y => G.descKey(y) === k); if (x) human(x); else { SND.play('error_denied'); toast('No draw from this deck is due for you right now'); } });
  $('#mapwrap').addEventListener('click', e => { if (!e.target.closest('.info') && !e.target.closest('.tok') && !e.target.closest('.maptools')) { selected = null; hideInfo(); if (S) renderMap(mineNow()); } });
  $('#chkLinks').onchange = e => $('#links').classList.toggle('on', e.target.checked);
  $('#chkNames').onchange = () => S && renderMap(mineNow());
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if (e.key === 'm' || e.key === 'M') SND.toggle();
    if (e.key === 'Escape' && !mustAck()) { closeModal(); if (ab) { ab = null; render(); } }
  });
}

// test / debugging hook: read-only views plus the AI's suggestion for the seat that must act (the UI test clicks what it suggests)
window.__imperator = {
  state: () => (S ? G.stateOf(S) : null), view: () => (S ? st() : null), busy: () => busy || autoRoll, viewer: () => viewer, legal: () => (S ? mineNow() : []),
  suggest: () => (S && NET?.role !== 'guest' ? G.aiMove(S) : null), play: a => { apply(a); return null; },   // M11: does not wait for the animations
  net: () => (NET ? { role: NET.role, code: NET.code, me: NET.me, pending: !!NET.pending, seats: NET.role === 'host' ? NET.room.lobby().seats : NET.client.lobby?.seats ?? [], queued: NET.role === 'host' ? NET.inbox.length : NET.q.length, status: NET.role === 'guest' ? NET.client.status : 'host', hostAway: NET.role === 'guest' ? NET.client.hostAway : false, ai: NET.role === 'guest' ? NET.client.ai : false, reconnects: NET.role === 'guest' ? NET.client.reconnects : 0, statuses: NET.statuses ?? [], token: NET.role === 'guest' ? NET.client.token : null } : null),
  // M14 test hooks: a guest's link drops (as if the network went away); a host that stops pinging
  netDrop: () => { const c = NET?.role === 'guest' && NET.client; if (c) { try { c.transport.close(); } catch { /* */ } c.linkLost('LINK_LOST'); } }, netQuiet: on => { if (NET?.role === 'host') NET.quiet = !!on; }, keyOf: a => { const d = S && G.findDesc(mineNow(), a); return d ? G.descKey(d) : null; },
  sounds: () => SND.played.slice(-80), label: () => uiLabel,
};
boot();
