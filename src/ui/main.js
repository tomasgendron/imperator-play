// M0 scaffold page: proves that data/*.json load and validate in the browser, and shows the map, an empty province table,
// the generals, a gallery of every card type and the items (Cardartista's style 3 art, approved by Vidi 2026-10-21). The real UI is M4 (PLAN 10).
import { loadGameData } from './loadData.js';
import { createBlankState } from '../engine/state.js';
import { buildViewModel } from './viewModel.js';
import { resolveAsset, imgFor } from './assets.js';

const app = document.getElementById('app');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function renderMap(vm, data, assets) {
  const wrap = el('div', 'map');
  wrap.append(imgFor(document, resolveAsset(assets, 'map', { title: 'Map' }), 'Map of the Roman world'));
  const { w, h } = data.map.map.tokenSpace;
  for (const r of vm.rows) {
    const t = el('div', 'token' + (r.id === 'roma' ? ' roma' : ''), r.troops ?? (r.natives ?? ''));
    t.style.left = (r.token.x / w * 100) + '%'; t.style.top = (r.token.y / h * 100) + '%';
    t.title = `${r.name}${r.number ? ' (number ' + r.number + ')' : ''}`; t.dataset.province = r.id;
    wrap.append(t);
  }
  return wrap;
}

function renderTable(vm) {
  const t = el('table', 'prov'); t.id = 'provTable';
  const head = el('tr'); for (const c of ['Province', 'No.', 'Reward', 'Owner', 'Status', 'Troops', 'Natives', 'Min garrison', 'Notes']) head.append(el('th', '', c));
  t.append(head);
  for (const r of vm.rows) {
    const tr = el('tr'); tr.dataset.province = r.id;
    for (const v of [r.name, r.number ?? '–', r.reward ?? '–', r.owner ?? 'unowned', r.status, r.troops ?? '–', r.natives ?? '?', '–', r.note]) tr.append(el('td', '', v));
    t.append(tr);
  }
  return t;
}

function renderCards(vm, assets) {
  const g = el('div', 'gallery'); g.id = 'cardGallery';
  for (const c of vm.cards) {
    const tile = el('div', 'card'); tile.dataset.card = c.id; tile.dataset.type = c.type;
    tile.append(imgFor(document, resolveAsset(assets, c.artId, { title: c.name, subtitle: c.text, tag: c.label ?? c.deck }), c.name));
    const cap = el('div', 'cap'); cap.append(el('b', '', c.name + ' ×' + c.copies));
    if (c.label) cap.append(el('span', 'bclabel', c.label));   // only type "battle" cards get the label (Vidi 2026-10-17)
    tile.append(cap); g.append(tile);
  }
  return g;
}

function renderItems(vm, assets) {
  const g = el('div', 'gallery'); g.id = 'itemGallery';
  for (const x of vm.items) {
    const tile = el('div', 'card'); tile.dataset.item = x.id;
    tile.append(imgFor(document, resolveAsset(assets, x.artId, { title: x.name, subtitle: x.text, tag: 'item' }), x.name));
    tile.append(el('div', 'cap', `${x.name} (${x.cost} Gold)`)); g.append(tile);
  }
  return g;
}

function renderGenerals(vm, assets) {
  const g = el('div', 'gallery generals'); g.id = 'generals';
  for (const x of vm.generals) {
    const tile = el('div', 'card'); tile.dataset.general = x.id;
    tile.append(imgFor(document, resolveAsset(assets, x.artId, { title: x.name, subtitle: x.text }), x.name));
    tile.append(el('div', 'cap', `${x.name}, ${x.title}`)); g.append(tile);
  }
  return g;
}

async function boot() {
  try {
    const { data, assets } = await loadGameData();
    const state = createBlankState(data, { seed: 'm0-demo', players: [] });
    const vm = buildViewModel(data, state, assets);
    app.textContent = '';
    const top = el('header', 'top');
    top.append(el('h1', '', 'IMPERATOR'), el('span', 'badge', 'M0 scaffold · data loaded'));
    const ok = vm.counts.stateProblems.length === 0;
    const c = vm.counts;
    const status = el('p', 'status', `${c.provinces} provinces · ${c.cardTypes} card types (${c.battleCards} battle) · ${c.cardsTotal} cards in the decks · ${c.generals} generals · blank state ${ok ? 'valid ✓' : 'INVALID ✗'}`);
    status.id = 'status'; status.dataset.ok = ok ? '1' : '0';
    app.append(top, status);
    const cols = el('div', 'cols');
    const left = el('section'); left.append(el('h2', '', 'Map'), renderMap(vm, data, assets));
    const right = el('section'); right.append(el('h2', '', 'Provinces (empty table)'), renderTable(vm));
    cols.append(left, right); app.append(cols);
    app.append(el('h2', '', 'Generals'), renderGenerals(vm, assets), el('h2', '', `Cards (${vm.counts.cardTypes} types)`), renderCards(vm, assets), el('h2', '', 'Items'), renderItems(vm, assets));
    document.body.dataset.ready = '1';
  } catch (e) {
    app.textContent = '';
    const pre = el('pre', 'error', 'Imperator could not start:\n' + (e && e.message || e));
    pre.id = 'bootError'; app.append(pre);
    document.body.dataset.ready = 'error';
    console.error(e);
  }
}
boot();
