// M18 / v30: the phone map (from the approved mockup): one finger pans, two fingers pinch-zoom about their midpoint, the buttons zoom
// and fit; a zoom changes the map's pixel size (not a CSS scale), so the 44 px tokens stay 44 px and stay easy to tap. A minimap shows
// where the view is. A drag of more than 8 px is a pan, not a tap (the token's click is swallowed).
export function createMapView({ wrap, inner, mini, frame, aspect }) {
  const V = { W: 0, x: 0, y: 0, moved: false };
  const rect = () => wrap.getBoundingClientRect();
  const fitMin = () => { const r = rect(); return Math.min(r.width, r.height / aspect); };
  const maxW = () => Math.max(2600, fitMin() * 4);
  function clamp() {
    const r = rect(); const H = V.W * aspect;
    V.x = V.W <= r.width ? (r.width - V.W) / 2 : Math.min(0, Math.max(r.width - V.W, V.x));
    V.y = H <= r.height ? (r.height - H) / 2 : Math.min(0, Math.max(r.height - H, V.y));
  }
  function apply() {
    if (!V.W) return; clamp(); const r = rect();
    inner.style.width = V.W + 'px'; inner.style.height = V.W * aspect + 'px'; inner.style.transform = `translate(${V.x}px,${V.y}px)`;
    const mw = mini.clientWidth || 100, mh = mini.clientHeight || 56;
    frame.style.left = Math.max(0, -V.x / V.W * mw) + 'px'; frame.style.top = Math.max(0, -V.y / (V.W * aspect) * mh) + 'px';
    frame.style.width = Math.min(mw, r.width / V.W * mw) + 'px'; frame.style.height = Math.min(mh, r.height / (V.W * aspect) * mh) + 'px';
  }
  /** Centre the view on (fx, fy) (0..1 of the map) at `zoom` times the size that covers the whole frame. */
  function focus(fx, fy, zoom = 1) {
    const r = rect(); if (!r.width || !r.height) return;
    V.W = Math.min(maxW(), Math.max(fitMin(), Math.max(r.width, r.height / aspect) * zoom));
    V.x = r.width / 2 - fx * V.W; V.y = r.height / 2 - fy * V.W * aspect; apply();
  }
  function zoomAt(k, cx, cy) {
    const nW = Math.min(maxW(), Math.max(fitMin(), V.W * k)); const kk = nW / V.W;
    V.x = cx - (cx - V.x) * kk; V.y = cy - (cy - V.y) * kk; V.W = nW; apply();
  }
  const zoomBy = k => { const r = rect(); zoomAt(k, r.width / 2, r.height / 2); };
  const fit = () => { V.W = fitMin(); apply(); };
  const pts = new Map(); let last = null, start = null;
  wrap.addEventListener('pointerdown', e => {
    if (e.target.closest('.mapctl, .minimap')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = null;
    if (pts.size === 1) { start = { x: e.clientX, y: e.clientY }; V.moved = false; }
  });
  wrap.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; const prev = pts.get(e.pointerId); const now = { x: e.clientX, y: e.clientY }; pts.set(e.pointerId, now);
    if (pts.size === 1) {
      if (start && Math.hypot(now.x - start.x, now.y - start.y) > 8) V.moved = true;
      if (V.moved) { V.x += now.x - prev.x; V.y += now.y - prev.y; apply(); }
      return;
    }
    V.moved = true;
    const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (last) { const r = rect(); zoomAt(d / last, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); }
    last = d;
  });
  const up = e => { pts.delete(e.pointerId); last = null; };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('click', e => { if (V.moved && e.target.closest('.tok')) { e.stopPropagation(); e.preventDefault(); } V.moved = false; }, true);
  wrap.addEventListener('wheel', e => { e.preventDefault(); const r = rect(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  mini.addEventListener('click', e => { const r = mini.getBoundingClientRect(); focus((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, Math.max(1, V.W / Math.max(rect().width, rect().height / aspect))); });
  /** Keep a point (0..1) in view when a sheet covers the bottom part (`cover` px). */
  function reveal(fx, fy, cover = 0) {
    const r = rect(); const px = V.x + fx * V.W, py = V.y + fy * V.W * aspect; const vis = Math.max(80, r.height - cover);
    if (px < 40 || px > r.width - 40) V.x += r.width / 2 - px;
    if (py < 50 || py > vis - 40) V.y += Math.min(vis, r.height) / 2 - py;
    apply();
  }
  /** The opening view: wide enough that the 44 px tokens do not overlap much, centred on (fx, fy). */
  function opening(fx = 0.5, fy = 0.5) { const r = rect(); if (!r.width) return; V.W = Math.min(maxW(), Math.max(fitMin() * 1.7, Math.min(r.width, r.height / aspect))); V.x = r.width / 2 - fx * V.W; V.y = r.height / 2 - fy * V.W * aspect; apply(); }
  return { V, apply, start: opening, focus, zoomBy, fit, reveal, refit: () => { if (!V.W) fit(); else apply(); } };
}
