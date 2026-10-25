// Throwaway engine console (PLAN 12, M1.4): drive the real engine by hand. One button per legal action, rigged dice, undo, auto-play, state JSON.
// It uses the same pure model as the Node tests (consoleModel.js). Dev tool: private events are shown too.
import { loadGameData } from './loadData.js';
import { resolveAsset, imgFor } from './assets.js';
import * as M from './consoleModel.js';
import { createRng, nextU32, viewFor } from '../engine/index.js';

const app = document.getElementById('app');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let data = null, assets = null, session = null, lastError = '', autoRnd = null, dice = '';

const GROUP_ORDER = ['ROLL', 'CHOOSE_BORROW', 'CHOOSE_BATTLE_CARDS', 'CHOOSE_PERK', 'PLAY_CARD', 'PASS', 'DISCARD_CARDS', 'CALL_REINFORCEMENTS', 'BATTLE_CONTINUE', 'BATTLE_RETREAT', 'PLACE_SURVIVORS', 'DRAW_CARD', 'PLACE_TROOPS', 'RESOURCE_BUILD', 'CHOOSE_PROVINCE', 'CHOOSE_GENERAL', 'CHOOSE_START_PROVINCE', 'MOVE', 'BUY_TROOP', 'BUY_GAME_CARD', 'BUILD_ROAD', 'BUILD_WALL', 'USE_SAVED_RESOURCE', 'ATTACK', 'PREVIEW_TARGET', 'ALLY', 'END_TURN'];

// ---- M4 setup screen: 2-3 seats, each Human or AI, a general (or Random), Random or Selected starts (validated like the engine does)
let seatsForm = [
  { name: 'Vidi', controller: 'human', general: 'random', startProvince: '' },
  { name: 'Boardicca', controller: 'ai', general: 'random', startProvince: '' },
  { name: 'Gaius', controller: 'ai', general: 'random', startProvince: '' },
];
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let seatCount = 2, startMode = 'random', aiDelay = 600, aiPaused = false, aiTimer = null;
function readSetup(form) {
  seatCount = Number(form.seats.value); startMode = form.mode.value;
  seatsForm = seatsForm.map((x, i) => ({ name: form['name' + i].value, controller: form['ctl' + i].value, general: form['gen' + i].value, startProvince: form['start' + i].value }));
}
function startGame(form) {
  readSetup(form);
  const seats = seatsForm.slice(0, seatCount);
  const v = M.checkSetup(data, seats, startMode);
  if (!v.ok) { renderSetup(v.errors); return; }
  try { session = M.newSession(data, { seed: form.seed.value || 'console', seats, mode: startMode }); }
  catch (e) { renderSetup([{ seat: null, message: e.message }]); return; }
  aiPaused = false; dice = '';
  autoRnd = createRng('auto-' + (form.seed.value || 'console')); lastError = ''; render();
}
function doAction(action) {
  const r = M.play(session, action, dice);
  if (r.error) lastError = `${r.error.code}: ${r.error.message}${r.error.rule ? ' (' + r.error.rule + ')' : ''}`;
  else { session = r.session; lastError = ''; dice = ''; }
  render();
}
const rnd = () => nextU32(autoRnd) / 2 ** 32;
function auto(n) {
  for (let i = 0; i < n; i++) {
    if (M.stateOf(session).phase === 'finished') break;
    const a = M.botMove(session, rnd); if (!a) break;
    const r = M.play(session, a); if (r.error) { lastError = r.error.code + ': ' + r.error.message; break; }
    session = r.session;
  }
  render();
}

function renderSetup(errors = null) {
  app.textContent = '';
  const top = el('header', 'top'); top.append(el('h1', '', 'IMPERATOR'), el('span', 'badge', 'engine console · M4'), Object.assign(el('a', '', '← main page'), { href: 'index.html' }));
  const ch = M.setupChoices(data);
  const opt = (v, t, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`;
  const f = el('form', 'setupform'); f.id = 'setupForm';
  const seatRows = seatsForm.map((x, i) => `<tr class="seat" data-seat="${i}"${i >= seatCount ? ' hidden' : ''}><td>Seat ${i + 1}</td>
    <td><input name="name${i}" value="${esc(x.name)}" size="12"></td>
    <td><select name="ctl${i}">${opt('human', 'Human', x.controller === 'human')}${opt('ai', 'AI', x.controller === 'ai')}</select></td>
    <td><select name="gen${i}">${opt('random', 'General: choose in setup', x.general === 'random')}${ch.generals.map(g => opt(g.id, g.name, x.general === g.id)).join('')}</select></td>
    <td class="startcol"${startMode === 'selected' ? '' : ' hidden'}><select name="start${i}">${opt('', 'pick in setup', !x.startProvince)}${ch.starts.map(p => opt(p.id, p.name, x.startProvince === p.id)).join('')}</select></td></tr>`).join('');
  f.innerHTML = `<h2>New game</h2>
    <p><label>Players <select name="seats">${opt(2, '2', seatCount === 2)}${opt(3, '3', seatCount === 3)}</select></label>
    <label>Start provinces <select name="mode">${opt('random', 'Random (2+ provinces apart, never Carthage or Roma)', startMode === 'random')}${opt('selected', 'Selected (same rule)', startMode === 'selected')}${opt('classic', 'Classic (by general, 15.i)', startMode === 'classic')}</select></label>
    <label>Seed <input name="seed" value="console" size="10"></label></p>
    <table class="seats"><tr><th></th><th>Name</th><th>Human / AI</th><th>General</th><th class="startcol"${startMode === 'selected' ? '' : ' hidden'}>Start province</th></tr>${seatRows}</table>
    <p class="status">Every player starts with ${data.rules.startingGold} Gold and ${data.rules.startingTroops} troops. AI seats move by themselves after a short delay; humans click the buttons (hot-seat).</p>
    <div id="setupErrors" class="err">${(errors ?? []).map(e => esc((e.seat !== null && e.seat !== undefined ? `Seat ${e.seat + 1}: ` : '') + e.message)).join('<br>')}</div>
    <p><button type="submit" id="newGame">Start</button></p>`;
  f.addEventListener('change', ev => { if (['seats', 'mode'].includes(ev.target.name)) { readSetup(f); renderSetup(); } else { readSetup(f); const v = M.checkSetup(data, seatsForm.slice(0, seatCount), startMode); f.querySelector('#setupErrors').innerHTML = v.errors.map(e => esc((e.seat !== null && e.seat !== undefined ? `Seat ${e.seat + 1}: ` : '') + e.message)).join('<br>'); } });
  f.addEventListener('submit', ev => { ev.preventDefault(); startGame(f); });
  app.append(top, f);
  document.body.dataset.ready = '1';
}

// ---- AI seats: one move per tick after `aiDelay` ms, so a human can follow; Pause stops them, "AI step" does one move
function scheduleAi() {
  clearTimeout(aiTimer); aiTimer = null;
  if (!session || aiPaused || !M.aiToMove(session)) return;
  aiTimer = setTimeout(aiStep, aiDelay);
}
function aiStep() {
  if (!session || !M.aiToMove(session)) return;
  const a = M.aiMove(session);
  if (!a) return;
  const r = M.play(session, a);
  if (r.error) { lastError = 'AI: ' + r.error.code + ': ' + r.error.message; aiPaused = true; } else { session = r.session; lastError = ''; }
  render();
}

function render() {
  if (!session) return renderSetup();
  const state = M.stateOf(session);
  app.textContent = '';
  const top = el('header', 'top');
  top.append(el('h1', '', 'IMPERATOR'), el('span', 'badge', 'engine console · M4'), Object.assign(el('a', '', '← main page'), { href: 'index.html' }));
  app.append(top);
  const seatsLine = el('div', 'seatsline'); seatsLine.id = 'seatsLine';
  seatsLine.textContent = 'Seats: ' + state.players.map(p => `${p.name} (${p.controller === 'ai' ? 'AI' : 'Human'})`).join(' · ');
  app.append(seatsLine);
  const cols = el('div', 'cons'); const left = el('section'), right = el('section');

  const aiTurn = M.aiToMove(session);
  const prompt = el('div', 'prompt' + (state.phase === 'finished' ? ' over' : ''), M.describePrompt(state, data) + (aiTurn ? (aiPaused ? ' [AI paused]' : ' [AI is thinking ...]') : '')); prompt.id = 'prompt';
  if (aiTurn) prompt.dataset.ai = '1';
  const err = el('div', 'err', lastError); err.id = 'err';
  left.append(prompt, err);
  const bp = M.battlePanel(state, data);
  if (bp) { const box = el('div', 'battle'); box.id = 'battle'; box.append(el('h3', '', bp.title)); for (const l of bp.lines) box.append(el('div', '', l)); if (bp.diceHint) box.append(el('div', 'hint', bp.diceHint)); left.append(box); }

  const legal = M.legalOf(session);
  const acts = el('div'); acts.id = 'actions';
  const bar = el('div', 'bar');
  const diceIn = Object.assign(el('input'), { type: 'text', id: 'dice', value: dice, placeholder: 'rig dice e.g. 3,5' });
  diceIn.addEventListener('input', () => { dice = diceIn.value; });
  const btn = (label, fn, id) => { const b = el('button', '', label); if (id) b.id = id; b.addEventListener('click', fn); return b; };
  bar.append(el('span', '', 'Rigged dice for the next action:'), diceIn,
    btn('Undo', () => { session = M.undo(session); lastError = ''; render(); }, 'undo'), btn('Auto ×1', () => auto(1), 'auto1'), btn('Auto ×25', () => auto(25), 'auto25'),
    btn('Auto ×300', () => auto(300), 'auto300'), btn('New game', () => { clearTimeout(aiTimer); session = null; render(); }, 'restart'));
  const aiBar = el('div', 'bar');
  const pause = btn(aiPaused ? 'Resume AI' : 'Pause AI', () => { aiPaused = !aiPaused; render(); }, 'aiPause');
  const speed = el('select'); speed.id = 'aiDelay';
  for (const [v, t] of [[150, 'fast'], [600, 'normal'], [1500, 'slow']]) speed.append(Object.assign(el('option', '', `AI speed: ${t}`), { value: v, selected: aiDelay === v }));
  speed.addEventListener('change', () => { aiDelay = Number(speed.value); scheduleAi(); });
  aiBar.append(pause, speed, btn('AI step', () => aiStep(), 'aiStep'), btn('AI plays the rest', () => { aiPaused = true; for (let i = 0; i < 6000 && M.stateOf(session).phase !== 'finished'; i++) { const a = M.aiMove(session); const r = M.play(session, a); if (r.error) { lastError = r.error.code; break; } session = r.session; } render(); }, 'aiRest'));
  left.append(aiBar);
  left.append(bar);
  const groups = {};
  for (const d of legal) (groups[d.type] ??= []).push(d);
  for (const t of [...GROUP_ORDER.filter(x => groups[x]), ...Object.keys(groups).filter(x => !GROUP_ORDER.includes(x))]) {
    const det = el('details', 'grp'); det.open = groups[t].length <= 14 || ['ROLL', 'DRAW_CARD', 'END_TURN'].includes(t);
    det.append(el('summary', '', `${t} (${groups[t].length})`));
    const row = el('div', 'acts');
    for (const d of groups[t]) {
      const w = el('span', 'row');
      let input = null;
      if (d.range) { input = Object.assign(el('input'), { type: 'number', min: d.range.min, max: d.range.max, value: d.range.max, title: `${d.range.field} ${d.range.min} to ${d.range.max}` }); }
      const b = btn(d.label, () => doAction(input ? { ...d.action, [d.range.field]: Number(input.value) } : d.action));
      b.dataset.type = d.type; w.append(b); if (input) w.append(input); row.append(w);
    }
    det.append(row); acts.append(det);
  }
  if (!legal.length) acts.append(el('p', '', 'No action is legal (game over).'));
  left.append(el('h2', '', 'Legal actions (' + legal.length + ')'), acts);

  const pt = el('table', 'pl'); pt.id = 'players';
  pt.innerHTML = '<tr><th>Player</th><th>Gold</th><th>Prestige</th><th>General</th><th>Catapults</th><th>Hand</th><th>In play</th><th>Saved</th></tr>';
  const thumb = (artId, title, cls = 'thumb') => { const i = imgFor(document, resolveAsset(assets, artId, { title }), title); i.className = cls; i.title = title; return i; };
  const cardCell = defs => { const td = el('td'); if (!defs.length) td.textContent = '–'; for (const d of defs) td.append(thumb('card.' + d, data.cardDefsById[d]?.name ?? d)); return td; };
  for (const p of M.playerRows(state, data)) {
    const tr = el('tr', [p.active ? 'active' : '', p.out ? 'out' : ''].join(' ').trim()); tr.dataset.player = p.id;
    for (const v of [p.name + (p.out ? ' (out)' : ''), p.gold, p.prestige]) tr.append(el('td', '', String(v)));
    const g = el('td'); if (p.generalId) g.append(thumb('token.general.' + p.generalId, p.general, 'token')); g.append(' ' + p.general); tr.append(g);
    const c = el('td'); for (let i = 0; i < p.catapults; i++) c.append(thumb('item.catapult', 'Catapult')); if (!p.catapults) c.textContent = '0'; tr.append(c);
    tr.append(cardCell(p.hand), cardCell(p.inPlay), cardCell(p.saved));
    pt.append(tr);
  }
  right.append(el('h2', '', 'Players'), pt);

  const t = el('table', 'pl'); t.id = 'provTable';
  t.innerHTML = '<tr><th>Province</th><th>No.</th><th>Rew.</th><th>Owner</th><th>Status</th><th>Troops</th><th>Min</th><th>Natives</th><th>Road/Walls</th></tr>';
  for (const r of M.provinceRows(state, data)) {
    const tr = el('tr'); tr.dataset.province = r.id;
    const cells = [r.name, r.number ?? '–', r.reward ?? '–', r.owner || '–', r.status, r.troops ?? '–', r.min ?? '–', r.natives, (r.road ? 'Road ' : '') + r.walls];
    cells.forEach((v, i) => { const td = el('td', i === 5 && r.under ? 'under' : '', String(v)); tr.append(td); });
    t.append(tr);
  }
  right.append(el('h2', '', 'Provinces'), t);

  const log = el('div', 'log'); log.id = 'log';
  for (const l of M.logLines(session)) { const d = el('div', l.type === 'turnStarted' ? 'turn' : ''); d.append(l.text + ' '); if (l.rule) d.append(Object.assign(el('span', 'r', '[' + l.rule + ']'))); log.append(d); }
  right.append(el('h2', '', `Log (${state.log.length} events, deck sizes game ${state.decks.game.length} / resource ${state.decks.resource.length} / displeased ${state.decks.displeased.length})`), log);
  log.scrollTop = log.scrollHeight;
  const js = el('details', 'json'); js.append(el('summary', '', 'State JSON (public view, no rng or deck order)'));
  js.append(Object.assign(el('pre'), { textContent: JSON.stringify({ ...viewFor(state, data, null), log: undefined }, null, 1) }));
  right.append(js);
  cols.append(left, right); app.append(cols);
  document.body.dataset.ready = '1';
  scheduleAi();
}

(async () => {
  try {
    ({ data, assets } = await loadGameData());
    const q = new URLSearchParams(location.search);
    if (q.get('auto')) { session = M.newSession(data, { seed: q.get('seed') ?? 'console', names: ['Vidi', 'Boardicca', 'Gaius'] }); autoRnd = createRng('auto-' + (q.get('seed') ?? 'console')); render(); auto(Number(q.get('auto'))); }
    else render();
  } catch (e) { app.textContent = ''; const pre = el('pre', 'error', 'The console could not start:\n' + (e && e.message || e)); pre.id = 'bootError'; app.append(pre); }
})();
