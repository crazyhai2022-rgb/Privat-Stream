// Minimal History-API router with lazy page modules.
const table = [];
let current = null;
let renderToken = 0;
let hooks = { before: () => {}, after: () => {} };

export function route(pattern, loader) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  table.push({ re, keys, loader, pattern });
}
export function setHooks(h) { hooks = { ...hooks, ...h }; }

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) { render(); return; }
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}

export async function render() {
  const token = ++renderToken;
  const url = new URL(location.href);
  let match = null;
  for (const r of table) {
    const m = r.re.exec(url.pathname);
    if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
  }
  const root = document.getElementById('view');
  if (current?.destroy) { try { current.destroy(); } catch (e) { console.error(e); } }
  current = null;
  hooks.before(url.pathname, match?.r.pattern);
  root.replaceChildren();
  window.scrollTo(0, 0);
  const ctx = { root, params: match?.params || {}, query: url.searchParams, path: url.pathname };
  try {
    const mod = await (match ? match.r.loader() : import('./pages/notfound.js'));
    if (token !== renderToken) return;
    const page = await mod.default(ctx);
    if (token !== renderToken) { page?.destroy?.(); return; }
    current = page || null;
  } catch (e) {
    console.error(e);
    if (token !== renderToken) return;
    const { h } = await import('./util.js');
    root.replaceChildren(h('div', { class: 'page narrow' }, h('div', { class: 'empty' }, h('h3', null, 'Something went wrong'), h('p', null, e.message || 'Please try again.'))));
  }
  hooks.after(url.pathname);
}

export function startRouter() {
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.origin !== location.origin) return;
    if (a.pathname.startsWith('/admin') || a.pathname.startsWith('/api/') || a.pathname.startsWith('/stream/')) return;
    e.preventDefault();
    navigate(a.pathname + a.search + a.hash);
  });
  return render();
}
