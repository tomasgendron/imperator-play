// M18 / v30 (Vidi 2026-10-27, PLAN-mobile.md): which page a device gets. A phone (an iPhone, an Android phone: "Mobile" in its user
// agent, or any touch screen whose short side is under 600 px) gets mobile.html; everything else gets the desktop page (index.html),
// iPads and tablets too, iPadOS that calls itself a Mac included. A manual choice wins: ?ui=mobile|desktop (then remembered) or
// localStorage['imperator.ui']; ?ui=auto (the menu's "Automatic") forgets it. The page keeps its ?join= / ?net= query and #hash.
// index.html and mobile.html carry the same rule as a small inline script (it runs before any module); tests/ui/m18.detect.test.js
// checks that both copies agree with this one.
export const UI_KEY = 'imperator.ui';

/** env: { ua, maxTouchPoints, coarse, screenW, screenH, uaMobile, search, stored }. Returns { ui, forced, save } where save is the
 *  value to store ('mobile' | 'desktop'), 'auto' to remove the stored value, or null to leave it. */
export function decideUI(env) {
  const ua = env.ua ?? '';
  const q = /[?&]ui=(mobile|desktop|auto)\b/.exec(env.search ?? '')?.[1] ?? null;
  const save = q;
  const stored = q === 'auto' ? null : q ?? (env.stored === 'mobile' || env.stored === 'desktop' ? env.stored : null);
  if (stored) return { ui: stored, forced: true, save };
  return { ui: isPhone(env) ? 'mobile' : 'desktop', forced: false, save };
}

export function isPhone(env) {
  const ua = env.ua ?? '';
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1);
  if (iPad) return false;
  if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua)) || env.uaMobile === true) return true;
  return !!env.coarse && Math.min(env.screenW ?? 9999, env.screenH ?? 9999) < 600;
}

/** The URL to go to for `ui` from `page` ('index' | 'mobile'), or null to stay. The ?ui= switch is taken out; the rest is kept. */
export function targetFor(ui, page, search = '', hash = '') {
  if ((ui === 'mobile') === (page === 'mobile')) return null;
  const rest = (search || '').replace(/^\?/, '').split('&').filter(x => x && !/^ui=/.test(x)).join('&');
  return (ui === 'mobile' ? 'mobile.html' : 'index.html') + (rest ? '?' + rest : '') + (hash || '');
}
