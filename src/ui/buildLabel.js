// The small "build M3 · <date time MT>" label on every page (Vidi needs to see which build he runs). Reads BUILD.json (tools/stamp-build.mjs).
export async function buildLabel(base = '') {
  try {
    const r = await fetch(base + 'BUILD.json', { cache: 'no-store' });
    if (!r.ok) return 'build ? (no BUILD.json)';
    const b = await r.json();
    return b.label ?? `build ${b.milestone} · ${b.stamp}`;
  } catch { return 'build ? (no BUILD.json)'; }
}
if (typeof document !== 'undefined') {
  buildLabel().then(text => {
    const d = document.createElement('div');
    d.id = 'buildLabel'; d.className = 'build-label'; d.textContent = text;
    d.title = 'Which build of Imperator this page runs (BUILD.json)';
    document.body.append(d);
  });
}
