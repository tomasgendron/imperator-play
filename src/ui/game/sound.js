// Sound module (PLAN 14), ported from the approved mockup: OGG first, MP3 fallback, never throws; on/off and volume remembered in this browser.
// `assets.audio` (data/assets.json) lists the files: {name: ['mp3','ogg']}; names like card_draw_1/_2 are variants of "card_draw".
export function createSound(assets, doc = document) {
  const KEY = 'imperator.sound', VKEY = 'imperator.volume';
  let on = true, vol = 0.7, last = 0;
  const active = new Set(), tmpl = {}, variants = {}, played = [];
  try { if (localStorage.getItem(KEY) === 'off') on = false; const v = parseFloat(localStorage.getItem(VKEY)); if (v >= 0 && v <= 1) vol = v; } catch { /* private mode */ }
  let fmt = 'ogg'; try { const a = new Audio(); if (!a.canPlayType('audio/ogg; codecs="vorbis"')) fmt = 'mp3'; } catch { /* no audio */ }
  const files = assets.audio ?? {};
  for (const k of Object.keys(files)) { const m = k.match(/^(.*)_(\d)$/); if (m) (variants[m[1]] ??= []).push(k); }
  const key = name => (files[name] ? name : variants[name] ? variants[name][Math.floor(Math.random() * variants[name].length)] : null);
  function play(name, o = {}) {
    try {
      played.push(name);
      if (!on) return false;
      const k = key(name); if (!k) return false;
      const ext = files[k].includes(fmt) ? fmt : files[k][0];
      let base = tmpl[k]; if (!base) { base = tmpl[k] = new Audio(); base.preload = 'auto'; base.src = `${assets.audioRoot}${k}.${ext}`; }
      const el = base.cloneNode(true); el.volume = Math.max(0, Math.min(1, vol * (o.vol ?? 1)));
      el.onended = el.onerror = () => active.delete(el);
      if (active.size > 16) { const f = active.values().next().value; try { f.pause(); } catch { /* */ } active.delete(f); }
      active.add(el); last = Date.now();
      const pr = el.play(); if (pr?.catch) pr.catch(() => active.delete(el));
      return true;
    } catch { return false; }
  }
  const later = (name, ms, o) => setTimeout(() => play(name, o), ms);
  function stopAll() { active.forEach(e => { try { e.pause(); } catch { /* */ } }); active.clear(); }
  function ui() {
    const b = doc.getElementById('bSound'); if (!b) return;
    b.classList.toggle('muted', !on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    doc.getElementById('bSoundTxt').textContent = on ? 'Sound on' : 'Sound off'; doc.body.dataset.sound = on ? 'on' : 'off';
  }
  function setOn(v) { on = !!v; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* */ } if (!on) stopAll(); ui(); if (on) play('button_click'); }
  return { play, later, stopAll, ui, setOn, toggle: () => setOn(!on), isOn: () => on, since: () => Date.now() - last, played };
}
