// v31.33 Test Mode setup page + in-game tweak panel (shared by desktop + mobile).
// The host (desktop app.js / mobile app.js) supplies the platform pieces:
//   dataForMap(mapId) — the data bundle for a map
//   img(id), toast(msg), sound(name) — platform helpers
//   onStartTest(session), onCancel() — setup-page navigation
//   getSession(), applyTweak(fn) — in-game panel: fn(session) -> {session, notes, error}
// The renderer owns no game state of its own on the setup page: the speed-run
// result and the tweaked session live in a closure here; in-game it works on
// the live session through the host. Every tweak applies at once and is logged.
import { runSpeedRun, rankedSeats, tweakFlipProvince, tweakPlayerStat, tweakRecall, tweakGiveCard, tweakRemoveCard, giveableCards, TEST_CONDITIONS, TEST_LIMITS } from './testMode.js';
import { stateOf } from './model.js';
import { playerOf } from '../../engine/index.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = s => esc(s).replace(/"/g, '&quot;');
const clamp = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const provName = (data, id) => data.provincesById[id]?.name ?? id;
const genName = (data, id) => data.generalsById[id]?.name ?? id;
const ordinal = n => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th');

/** The human seat of a test game: the one seat whose controller is 'human'. */
export const humanSeat = state => state.players.find(p => p.controller === 'human' && !p.out)
  ?? state.players.find(p => !p.out) ?? state.players[0];

/** Roma first, Carthage second, then the rest by name. */
const provinceOrder = (data, state) => {
  const ids = Object.keys(state.provinces);
  return ids.sort((a, b) => (a === 'roma' ? -1 : b === 'roma' ? 1 : a === 'carthage' ? -1 : b === 'carthage' ? 1 : provName(data, a).localeCompare(provName(data, b))));
};

// ------------------------------------------------------------------ tweak panel (shared)

/** One HTML string for the whole tweak panel; `humanId` is the "Me" seat. */
function tweakPanelHtml(session, data, humanId, notes, battleWarn) {
  const st = stateOf(session);
  const me = humanSeat(st);
  const live = st.players.filter(p => !p.out);
  const ownerOpts = p => `<option value="neutral" ${p.owner === null ? 'selected' : ''}>Neutral</option>` + live.map(pl =>
    `<option value="${attr(pl.id)}" ${p.owner === pl.id ? 'selected' : ''}>${pl.id === humanId ? 'Me — ' : ''}${esc(pl.name)}</option>`).join('');
  const provRows = provinceOrder(data, st).map(id => {
    const p = st.provinces[id];
    const n = p.owner === null && id !== 'roma' ? (p.native?.present ?? 0) : p.troops;
    const max = id === 'roma' ? data.rules.romaMaxTroops : TEST_LIMITS.troops.max;
    const note = id === 'roma' ? 'Capital · min 10 · +3 Prestige'
      : id === 'carthage' ? 'Worth 2 Prestige'
      : p.owner === null ? `Neutral · ${p.native?.present ?? 0} natives`
      : `${esc(playerOf(st, p.owner)?.name ?? '')} · ${p.troops} troops · ${p.status}`;
    return `<div class="ts-provrow" data-prov="${attr(id)}">
      <span class="ts-provname">${esc(provName(data, id))}</span>
      <span class="ts-provnote">${note}</span>
      <select class="ts-owner" data-prov="${attr(id)}" aria-label="Owner of ${esc(provName(data, id))}">${ownerOpts(p)}</select>
      <span class="ts-stepper"><button type="button" data-step="-1" data-prov="${attr(id)}" aria-label="Fewer troops">−</button><b>${n}</b><button type="button" data-step="1" data-prov="${attr(id)}" aria-label="More troops">+</button></span>
      <span class="ts-max small">max ${max}</span>
    </div>`;
  }).join('');
  const playerRows = live.map(pl => {
    const recalled = pl.generalRecalledThroughTurn !== null && pl.generalRecalledThroughTurn !== undefined;
    return `<div class="ts-playrow" data-player="${attr(pl.id)}">
      <span class="ts-playname">${pl.id === humanId ? 'Me — ' : ''}${esc(pl.name)} <span class="small">(${esc(genName(data, pl.general?.id))}${pl.general?.at ? ' · in ' + esc(provName(data, pl.general.at)) : ''})</span></span>
      <label>Prestige <span class="ts-stepper"><button type="button" data-stat="prestige" data-step="-1" data-player="${attr(pl.id)}">−</button><b>${pl.prestige}</b><button type="button" data-stat="prestige" data-step="1" data-player="${attr(pl.id)}">+</button></span></label>
      <label>Gold <span class="ts-stepper"><button type="button" data-stat="gold" data-step="-1" data-player="${attr(pl.id)}">−</button><b>${pl.gold}</b><button type="button" data-stat="gold" data-step="1" data-player="${attr(pl.id)}">+</button></span></label>
      <button type="button" class="btn sm ts-recall${recalled ? ' on' : ''}" data-player="${attr(pl.id)}" ${pl.general ? '' : 'disabled'}>${recalled ? `General recalled (thru turn ${pl.generalRecalledThroughTurn}) — tap to free` : 'Recall general'}</button>
    </div>`;
  }).join('');
  const cards = giveableCards(session);
  const cardOpts = `<option value="">Pick a card…</option>` + ['game', 'resource'].map(deck =>
    `<optgroup label="${deck === 'game' ? 'Game cards' : 'Resource cards'}">` + cards.filter(c => c.deck === deck).map(c =>
      `<option value="${attr(c.def)}">${esc(c.name)} (${c.loc.inDeck} in deck)</option>`).join('') + `</optgroup>`).join('');
  const hand = [...me.hand, ...me.savedResources, ...me.inPlay].map(c => {
    const def = st.cards[c.uid]?.def;
    const name = data.cardDefsById[def]?.name ?? def;
    return `<span class="ts-chip">${esc(name)} <button type="button" data-remove="${attr(c.uid)}" title="Take ${esc(name)} out of the hand" aria-label="Remove ${esc(name)}">✕</button></span>`;
  }).join('') || '<span class="small">Empty hand.</span>';
  return `<div class="ts-tweaks">
    ${battleWarn ? `<p class="ts-warn">⚠️ A battle is running — flipping a province mid-battle may behave oddly. Finish the battle first if you can.</p>` : ''}
    <div class="ts-sec"><h4>Provinces</h4><div class="ts-provlist">${provRows}</div>
      <div class="ts-quick"><button type="button" class="btn sm" data-quick="roma">Give me Roma</button><button type="button" class="btn sm" data-quick="carthage">Make Carthage neutral</button><button type="button" class="btn sm" data-quick="undo">Undo flips</button></div></div>
    <div class="ts-sec"><h4>Players</h4>${playerRows}<p class="small">Prestige 0–15, Gold 0–60. Setting Prestige at or above the win target does not end the game at once — it ends on the next Prestige award.</p></div>
    <div class="ts-sec"><h4>Give me a card</h4>
      <div class="ts-give"><select id="tsCardPick" aria-label="Card to give yourself">${cardOpts}</select> <span class="small ts-cardsrc" id="tsCardSrc"></span> <button type="button" class="btn sm gold" id="tsAddCard">Add to hand</button></div>
      <div class="ts-hand"><b>My hand:</b> ${hand}</div></div>
    ${notes.length ? `<div class="ts-sec"><h4>Your tweaks</h4><ul class="ts-tweaklog">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
  </div>`;
}

/**
 * Wires a tweak panel already in `box`. `getSession()` returns the current
 * session; `apply(fn)` applies a tweak function to it and returns
 * {session, notes, error} (the panel re-renders itself on success).
 * `snapshot` is the province state the "Undo flips" button restores.
 */
function wireTweakPanel(box, host, getSession, apply, snapshot, notes) {
  const data = getSession().data;
  const rerender = () => {
    const s = getSession();
    box.innerHTML = tweakPanelHtml(s, s.data, humanSeat(stateOf(s)).id, notes, !!stateOf(s).battle);
    wireTweakPanel(box, host, getSession, apply, snapshot, notes);
  };
  const done = r => {
    if (r.error) { host.toast(r.error); return; }
    if (r.notes?.length) notes.push(...r.notes);
    rerender();
  };
  const session = getSession();
  const st = stateOf(session);
  const me = humanSeat(st);
  // Province owner + troop steppers: each change applies at once.
  box.querySelectorAll('.ts-owner').forEach(sel => sel.onchange = () => {
    const id = sel.dataset.prov;
    const cur = stateOf(getSession()).provinces[id];
    const troops = cur.owner === null && id !== 'roma' ? (cur.native?.present ?? 0) : cur.troops;
    done(apply(s => tweakFlipProvince(s, { province: id, owner: sel.value === 'neutral' ? null : sel.value, troops })));
  });
  box.querySelectorAll('.ts-stepper button[data-prov]').forEach(b => b.onclick = () => {
    const id = b.dataset.prov;
    const cur = stateOf(getSession()).provinces[id];
    const max = id === 'roma' ? getSession().data.rules.romaMaxTroops : TEST_LIMITS.troops.max;
    const curN = cur.owner === null && id !== 'roma' ? (cur.native?.present ?? 0) : cur.troops;
    done(apply(s => tweakFlipProvince(s, { province: id, owner: cur.owner, troops: clamp(curN + Number(b.dataset.step), 0, max) })));
  });
  // Player prestige / gold steppers.
  box.querySelectorAll('.ts-stepper button[data-stat]').forEach(b => b.onclick = () => {
    const pid = b.dataset.player;
    const cur = playerOf(stateOf(getSession()), pid);
    const field = b.dataset.stat;
    const lim = TEST_LIMITS[field];
    done(apply(s => tweakPlayerStat(s, { player: pid, [field]: clamp(cur[field] + Number(b.dataset.step), lim.min, lim.max) })));
  });
  // Recall toggle.
  box.querySelectorAll('.ts-recall').forEach(b => b.onclick = () => {
    const pid = b.dataset.player;
    const cur = playerOf(stateOf(getSession()), pid);
    const recalled = cur.generalRecalledThroughTurn !== null && cur.generalRecalledThroughTurn !== undefined;
    done(apply(s => tweakRecall(s, { player: pid, recalled: !recalled })));
  });
  // Give-a-card picker: the source line says where the copy comes from.
  const pick = box.querySelector('#tsCardPick');
  const src = box.querySelector('#tsCardSrc');
  const updateSrc = () => {
    if (!pick || !src) return;
    if (!pick.value) { src.textContent = ''; return; }
    const cards = giveableCards(getSession());
    const c = cards.find(x => x.def === pick.value);
    if (!c) { src.textContent = ''; return; }
    src.textContent = c.loc.inDeck > 0 ? `${c.loc.inDeck} ${c.loc.inDeck === 1 ? 'copy' : 'copies'} left in the deck`
      : c.loc.holders.length ? `0 copies left in the deck — this will steal ${c.name} from ${c.loc.holders.map(h => h.name).join(', ')}`
      : c.loc.inDiscard > 0 ? '0 in the deck — this will take it from the discard pile'
      : c.loc.withheld > 0 ? '0 in the deck — this will take it from the withheld pile'
      : '0 in the deck — this will take it from the throwaway pile';
  };
  if (pick) { pick.onchange = updateSrc; updateSrc(); }
  const add = box.querySelector('#tsAddCard');
  if (add) add.onclick = () => {
    if (!pick.value) { host.toast('Pick a card first'); return; }
    done(apply(s => tweakGiveCard(s, { player: me.id, def: pick.value })));
  };
  // Hand chips: ✕ takes the card out of the hand.
  box.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
    done(apply(s => tweakRemoveCard(s, { player: me.id, uid: b.dataset.remove })));
  });
  // Quick buttons.
  box.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => {
    if (b.dataset.quick === 'roma') done(apply(s => tweakFlipProvince(s, { province: 'roma', owner: me.id, troops: 16 })));
    if (b.dataset.quick === 'carthage') done(apply(s => tweakFlipProvince(s, { province: 'carthage', owner: null, troops: 10 })));
    if (b.dataset.quick === 'undo') {
      done(apply(s => {
        let cur = s;
        for (const [id, snap] of Object.entries(snapshot)) {
          const r = tweakFlipProvince(cur, { province: id, owner: snap.owner, troops: snap.troops });
          if (r.error) return r;
          cur = r.session;
        }
        return { session: cur, notes: ['Flips undone — provinces back to how the panel opened'], error: null };
      }));
    }
  });
}

/** A snapshot of every province's owner + troops/natives for "Undo flips". */
const provinceSnapshot = session => Object.fromEntries(Object.entries(stateOf(session).provinces).map(([id, p]) => [
  id, { owner: p.owner, troops: p.owner === null && id !== 'roma' ? (p.native?.present ?? 0) : p.troops },
]));

/** Renders just the tweak panel into `box` for the live session (in-game overlay). */
export function renderTweakPanel(box, host) {
  const notes = [];
  const snapshot = provinceSnapshot(host.getSession());
  box.innerHTML = tweakPanelHtml(host.getSession(), host.getSession().data, humanSeat(stateOf(host.getSession())).id, notes, !!stateOf(host.getSession()).battle);
  wireTweakPanel(box, host, () => host.getSession(), fn => host.applyTweak(fn), snapshot, notes);
}

// ------------------------------------------------------------------ setup page

const COND_VALUE = { highest: { min: 4, max: 10, def: 7, suffix: 'Prestige' }, everyone: { min: 4, max: 10, def: 7, suffix: 'Prestige' }, roma: { min: 4, max: 10, def: 7, suffix: 'Prestige' }, turn: { min: 5, max: 60, def: 20, suffix: 'turn' } };

/**
 * Renders the 3-step Test Setup Page into `box`. The run + tweaked session
 * live in a closure; `host.onStartTest(session)` starts the game, `host.onCancel()`
 * goes back to the setup screen.
 */
export function renderTestSetupPage(box, host) {
  let run = null; let session = null; let notes = []; let snapshot = null; let running = false;
  const mapIds = host.mapIds ?? ['large1'];
  const condOpts = TEST_CONDITIONS.map(c => `<option value="${attr(c.id)}">${esc(c.label)}</option>`).join('');
  box.innerHTML = `<div class="ts-page">
    <div class="ts-head"><h2>🧪 Test Mode</h2>
      <p class="small">Set up a game situation to test — the AI plays all seats until your condition is met, then you take over one seat and tweak the board. Test games get a <b>TEST</b> badge and never touch your normal saves or stats.</p>
      <button type="button" class="btn" id="tsCancel">← Back to setup</button></div>
    <section class="ts-step" id="tsStep1"><h3>1 · Speed-run to a situation</h3>
      <p>Play until <select id="tsCondKind" aria-label="Condition">${condOpts}</select>
        <input id="tsCondValue" type="number" min="4" max="10" value="7" size="4" aria-label="Condition value"> <span id="tsCondSuffix">Prestige</span>,
        then give me control of the player in <select id="tsPlace" aria-label="Place to take over"><option value="1">1st place</option><option value="2">2nd place</option><option value="3">3rd place</option></select>.</p>
      <div class="ts-row">
        <label>Players <select id="tsPlayers"><option value="3" selected>3 players</option><option value="2">2 players</option></select></label>
        ${mapIds.length > 1 ? `<label>Map <select id="tsMap">${mapIds.map(id => `<option value="${attr(id)}" ${id === host.mapId ? 'selected' : ''}>${id === 'large1' ? 'Large Map 1' : 'Small Map 1'}</option>`).join('')}</select></label>` : ''}
        <label>AI level <select id="tsDiff"><option value="normal" selected>Normal</option><option value="easy">Easy</option></select></label>
        <label>Seed <input id="tsSeed" size="10" placeholder="random" title="Same seed + same choices = the same run"> <button type="button" class="btn sm" id="tsSeedDice" title="Roll a fresh random seed">🎲</button></label>
        <label>Stop at turn <select id="tsCap"><option value="60" selected>60 — closest match</option><option value="40">40 — closest match</option></select></label>
      </div>
      <div class="ts-row"><button type="button" class="btn gold big" id="tsRun">▶ Run the speed-run</button>
        <span class="small ts-runstate" id="tsRunState"></span></div>
      <div class="ts-runlog" id="tsRunLog" hidden></div>
      <div class="ts-result" id="tsResult" hidden></div>
    </section>
    <section class="ts-step" id="tsStep2"><h3>2 · Tweak the board</h3>
      <div id="tsTweaks"><p class="small">Run the speed-run first — then flip provinces, set Prestige and Gold, recall a general, or give yourself any card.</p></div>
    </section>
    <section class="ts-step" id="tsStep3"><h3>3 · Start the test game</h3>
      <button type="button" class="btn gold big" id="tsStart" disabled>Start test game ▶</button>
      <p class="small">The game opens with a 🧪 TEST badge and the seed in the top bar — and a Test Setup button to reopen these tweaks mid-game.</p>
    </section>
  </div>`;

  const $ = sel => box.querySelector(sel);
  const condKind = $('#tsCondKind'), condValue = $('#tsCondValue'), condSuffix = $('#tsCondSuffix');
  const syncCond = () => {
    const cfg = COND_VALUE[condKind.value] ?? COND_VALUE.highest;
    condValue.min = cfg.min; condValue.max = cfg.max;
    if (Number(condValue.value) < cfg.min || Number(condValue.value) > cfg.max) condValue.value = cfg.def;
    condSuffix.textContent = cfg.suffix;
  };
  condKind.onchange = syncCond;
  $('#tsPlayers').onchange = e => {
    const n = Number(e.target.value);
    $('#tsPlace').innerHTML = [1, 2, 3].slice(0, n).map(i => `<option value="${i}">${ordinal(i)} place</option>`).join('');
  };
  $('#tsSeedDice').onclick = () => { $('#tsSeed').value = 't' + Math.floor(Math.random() * 1e6); };
  $('#tsCancel').onclick = () => host.onCancel();

  const showResult = () => {
    const log = $('#tsRunLog'), res = $('#tsResult');
    log.hidden = false; res.hidden = false;
    log.innerHTML = run.log.map(l => `<div>${esc(l)}</div>`).join('');
    if (run.finished) {
      const w = stateOf(run.session).winner;
      const wp = w ? playerOf(stateOf(run.session), w) : null;
      res.innerHTML = `<p><b>The game finished before the handover</b> — ${wp ? esc(wp.name) + ' won with ' + wp.prestige + ' Prestige' : 'no winner'} (usually by elimination). Run again with a new seed or a lower target.</p>
        <button type="button" class="btn gold" id="tsRunAgain">Run again (new seed)</button>`;
      $('#tsRunAgain').onclick = () => { $('#tsSeed').value = 't' + Math.floor(Math.random() * 1e6); doRun(); };
      $('#tsStart').disabled = true;
      return;
    }
    const st = stateOf(run.session);
    const rows = rankedSeats(st).map((p, i) => `<div class="ts-standrow${p.id === run.seatId ? ' me' : ''}"><b>${ordinal(i + 1)}</b> ${esc(p.name)} · ${esc(genName(run.session.data, p.general?.id))} · ${p.prestige} Prestige · ${p.gold} Gold · ${p.provinces} provinces${p.id === run.seatId ? ' — <span class="ts-youtag">YOU TAKE THIS SEAT</span>' : ''}</div>`).join('');
    res.innerHTML = `<p>${run.met ? `Condition met on turn ${run.metTurn}.` : `Closest match — the condition was not met by turn ${run.capTurn ?? ''}.`} Seed <b>${esc(run.seed)}</b> · the game is still live.</p>${rows}
      <p class="small">You take over ${ordinal(run.place)} place — ${esc(playerOf(st, run.seatId)?.name ?? '')}'s seat, playing ${esc(genName(run.session.data, playerOf(st, run.seatId)?.general?.id))}, at the start of turn ${st.turn.number}. The other seats stay AI.</p>`;
    session = run.session;
    notes = [];
    snapshot = provinceSnapshot(session);
    const tw = $('#tsTweaks');
    tw.innerHTML = tweakPanelHtml(session, session.data, run.seatId, notes, !!stateOf(session).battle);
    wireTweakPanel(tw, host, () => session, fn => { const r = fn(session); if (!r.error) session = r.session; return r; }, snapshot, notes);
    $('#tsStart').disabled = false;
  };

  const doRun = async () => {
    if (running) return;
    running = true;
    const btn = $('#tsRun');
    btn.disabled = true;
    $('#tsRunState').textContent = 'Running… the AI plays all seats — this takes a few seconds.';
    $('#tsResult').hidden = true; $('#tsRunLog').hidden = true;
    $('#tsStart').disabled = true;
    const seed = $('#tsSeed').value.trim() || ('t' + Math.floor(Math.random() * 1e6));
    const data = host.dataForMap($('#tsMap')?.value ?? host.mapId);
    try {
      run = await runSpeedRun(data, {
        seed,
        players: Number($('#tsPlayers').value),
        difficulty: $('#tsDiff').value,
        condition: { kind: condKind.value, value: clamp(condValue.value, COND_VALUE[condKind.value].min, COND_VALUE[condKind.value].max) },
        place: Number($('#tsPlace').value),
        capTurn: Number($('#tsCap').value),
      }, p => { if (p.phase === 'running') $('#tsRunState').textContent = `Running… turn ${p.turn}, highest ${p.highest} Prestige.`; });
      run.capTurn = Number($('#tsCap').value);
      $('#tsRunState').textContent = run.finished ? 'Finished — the game ended before the handover.' : run.met ? `Done — condition met on turn ${run.metTurn}.` : 'Done — closest match.';
      showResult();
    } catch (e) {
      $('#tsRunState').textContent = 'The run failed: ' + e.message;
    } finally {
      running = false;
      btn.disabled = false;
    }
  };
  $('#tsRun').onclick = doRun;
  $('#tsStart').onclick = () => { if (session) host.onStartTest(session); };
}
