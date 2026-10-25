// Asset resolution with placeholders (PLAN 14, 5.1). Pure: no DOM. The page tries `path`, then `fallback`, then the generated SVG.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text, max) {
  const lines = []; let line = '';
  for (const w of String(text).split(/\s+/)) {
    if ((line + ' ' + w).trim().length > max) { if (line) lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

/** A generated placeholder (SVG data URI) that shows the card/asset name: cards 540x1080, tokens 96x96, images 640x360. */
export function placeholderSvg({ title, subtitle = '', kind = 'card', tag = '' }) {
  const [w, h] = kind === 'card' ? [540, 1080] : kind === 'token' ? [96, 96] : [640, 360];
  const big = kind === 'token' ? 14 : 44, small = kind === 'token' ? 9 : 26;
  const tl = wrap(title, kind === 'token' ? 9 : 16).slice(0, 4);
  const sl = wrap(subtitle, kind === 'card' ? 30 : 40).slice(0, 8);
  let y = kind === 'card' ? 220 : h * 0.3;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#efe3c2"/><rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="none" stroke="#8c1d18" stroke-width="${kind === 'token' ? 2 : 8}"/>`];
  if (tag) out.push(`<text x="${w / 2}" y="${kind === 'card' ? 90 : 24}" text-anchor="middle" font-family="Georgia,serif" font-size="${small}" fill="#8c1d18" font-weight="bold">${esc(tag.toUpperCase())}</text>`);
  for (const l of tl) { out.push(`<text x="${w / 2}" y="${y}" text-anchor="middle" font-family="Georgia,serif" font-size="${big}" font-weight="bold" fill="#2b2118">${esc(l)}</text>`); y += big * 1.25; }
  y += small;
  for (const l of sl) { out.push(`<text x="${w / 2}" y="${y}" text-anchor="middle" font-family="Georgia,serif" font-size="${small}" fill="#4a3c2c">${esc(l)}</text>`); y += small * 1.35; }
  if (kind !== 'token') out.push(`<text x="${w / 2}" y="${h - 24}" text-anchor="middle" font-family="Georgia,serif" font-size="${small * 0.7}" fill="#8a7a5a">placeholder art</text>`);
  out.push('</svg>');
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out.join(''));
}

/** -> {path, fallback|null, placeholder} for an asset id; unknown ids still yield a placeholder (never throws). */
export function resolveAsset(assets, id, { title, subtitle, tag } = {}) {
  const e = assets.assets[id];
  const kind = e?.kind ?? 'image';
  const ph = placeholderSvg({ title: title ?? id, subtitle, kind, tag });
  if (!e) return { path: null, fallback: null, placeholder: ph, known: false };
  // `pending`: delivered art waiting for Vidi's approval is NOT shown yet (PLAN 14.2, 2026-10-21): skip to the fallback/placeholder
  if (e.pending) return { path: null, fallback: e.fallback ? assets.root + e.fallback : null, placeholder: ph, known: true, pending: e.pending };
  return { path: assets.root + e.path, fallback: e.fallback ? assets.root + e.fallback : null, placeholder: ph, known: true };
}

/** DOM helper: an <img> that walks path -> fallback -> placeholder. */
export function imgFor(doc, r, alt = '') {
  const img = doc.createElement('img');
  img.alt = alt;
  const chain = [r.path, r.fallback, r.placeholder].filter(Boolean);
  let i = 0;
  img.addEventListener('error', () => { i += 1; if (i < chain.length) { img.src = chain[i]; img.dataset.placeholder = i === chain.length - 1 ? '1' : '0'; } });
  img.src = chain[0];
  if (chain[0] === r.placeholder) img.dataset.placeholder = '1';
  return img;
}
