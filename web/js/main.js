import { h, icon, logoMark, $, $$, clear, setTitle } from './util.js';
import { state, loadConfig, refreshMe, onAuthChange, logout } from './api.js';
import { route, setHooks, startRouter, navigate } from './router.js';
import { avatarEl } from './cards.js';

const page = (file, name = 'default') => async () => {
  const m = await import(`./pages/${file}.js`);
  return { default: m[name] };
};
route('/', page('home'));
route('/shorts', page('shorts'));
route('/shorts/:id', page('shorts'));
route('/long', page('long'));
route('/watch/:id', page('watch'));
route('/categories', page('categories'));
route('/category/:slug', page('category'));
route('/search', page('search'));
route('/c/:handle', page('channel'));
route('/login', page('auth', 'login'));
route('/register', page('auth', 'register'));
route('/verify-email', page('auth', 'verify'));
route('/forgot-password', page('auth', 'forgot'));
route('/reset-password', page('auth', 'reset'));
route('/channel/setup', page('channel-edit'));
route('/studio/channel', page('channel-edit'));
route('/studio', page('studio'));
route('/upload', page('upload'));
route('/upload/short', page('upload', 'short'));
route('/upload/long', page('upload', 'long'));
route('/saved', page('saved'));
route('/settings', page('settings'));

const topbar = h('header', { class: 'topbar' });
const sidebar = h('nav', { class: 'sidebar nav', 'aria-label': 'Main' });
let drawer = null;

function myChannelHref() {
  if (!state.user) return '/login?next=/studio';
  if (!state.channel) return '/channel/setup';
  return state.channel.status === 'approved' ? `/c/${state.channel.handle}` : '/studio';
}
const NAV = () => [
  ['/', 'Home', 'home'], ['/shorts', 'Shorts', 'shorts'], ['/long', 'Long Videos', 'film'], ['/categories', 'Categories', 'grid'],
  ['/saved', 'Saved Videos', 'bookmark'], [myChannelHref(), 'My Channel', 'user', 'channel'], ['/upload', 'Upload', 'upload'], ['/settings', 'Settings', 'sliders'],
];

function navLinks() {
  return NAV().map(([href, label, ic, key]) => h('a', { href, dataset: { nav: key || href } }, icon(ic), label));
}
function markActive(path) {
  const set = (el) => $$('a[data-nav]', el).forEach((a) => {
    const k = a.dataset.nav;
    let on;
    if (k === '/') on = path === '/';
    else if (k === 'channel') on = path === '/studio' || path.startsWith('/c/') || path === '/channel/setup' || path === '/studio/channel';
    else if (k === '/categories') on = path.startsWith('/categor');
    else if (k === '/upload') on = path.startsWith('/upload');
    else if (k === '/long') on = path === '/long' || path.startsWith('/watch');
    else on = path === k || path.startsWith(k + '/');
    a.classList.toggle('on', on);
  });
  set(sidebar); if (drawer) set(drawer);
  $$('.mtabs a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '/' ? path === '/' : path.startsWith('/shorts')));
}

function closeDrawer() { drawer?.remove(); $('.scrim')?.remove(); drawer = null; }
function openDrawer() {
  closeDrawer();
  const scrim = h('div', { class: 'scrim', onclick: closeDrawer });
  drawer = h('aside', { class: 'drawer nav', 'aria-label': 'Menu' },
    h('a', { class: 'brand', href: '/' }, logoMark(), h('span', null, window.__brand)), ...navLinks(),
    h('hr'),
    state.user ? h('a', { href: '#', onclick: async (e) => { e.preventDefault(); closeDrawer(); await logout(); navigate('/'); } }, icon('logout'), 'Log out')
      : [h('a', { href: '/login' }, icon('user'), 'Log in'), h('a', { href: '/register' }, icon('user'), 'Create account')]);
  document.body.append(scrim, drawer);
  drawer.addEventListener('click', (e) => { if (e.target.closest('a')) closeDrawer(); });
  markActive(location.pathname);
}

function userArea() {
  if (!state.user) {
    return [h('a', { class: 'btn sm', href: `/login?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Log in'), h('a', { class: 'btn sm primary only-d', href: '/register' }, 'Sign up')];
  }
  const menu = h('div', { class: 'menu', hidden: true, role: 'menu' },
    h('div', { class: 'who' }, h('b', null, state.user.full_name), h('div', { class: 'muted small' }, state.user.email)),
    h('hr'),
    h('a', { href: myChannelHref() }, icon('user'), 'My channel'),
    h('a', { href: '/studio' }, icon('film'), 'Creator studio'),
    h('a', { href: '/saved' }, icon('bookmark'), 'Saved videos'),
    h('a', { href: '/settings' }, icon('sliders'), 'Settings'),
    h('hr'),
    h('button', { onclick: async () => { menu.hidden = true; await logout(); navigate('/'); } }, icon('logout'), 'Log out'));
  const btn = h('button', { class: 'icon-btn', 'aria-label': 'Account menu', 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } },
    avatarEl(state.channel || { name: state.user.full_name }));
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) menu.hidden = true; });
  return [
    state.user && !('ontouchstart' in window && innerWidth < 900) ? h('a', { class: 'btn sm only-d', href: '/upload' }, icon('upload'), 'Upload') : null,
    h('div', { class: 'usermenu' }, btn, menu),
  ];
}

function buildChrome() {
  const searchInput = h('input', { type: 'search', name: 'q', placeholder: 'Search videos and creators', 'aria-label': 'Search', autocomplete: 'off', maxlength: 100 });
  const form = h('form', { class: 'search desk', role: 'search', onsubmit: (e) => { e.preventDefault(); const q = searchInput.value.trim(); if (q) navigate(`/search?q=${encodeURIComponent(q)}`); } },
    searchInput, h('button', { type: 'submit', 'aria-label': 'Search' }, icon('search')));
  clear(topbar).append(
    h('button', { class: 'icon-btn only-m', 'aria-label': 'Open menu', onclick: openDrawer }, icon('menu')),
    h('a', { class: 'brand', href: '/', 'aria-label': `${window.__brand} home` }, logoMark(), h('span', { class: 'name' }, window.__brand)),
    h('div', { class: 'mtabs' }, h('a', { href: '/' }, 'Home'), h('a', { href: '/shorts' }, 'Shorts')),
    form,
    h('div', { class: 'top-actions' }, h('a', { class: 'icon-btn only-m', href: '/search', 'aria-label': 'Search' }, icon('search')), ...userArea()));
  clear(sidebar).append(...navLinks(), h('div', { class: 'side-foot' }, `© ${new Date().getFullYear()} ${window.__brand}`));
  markActive(location.pathname);
  const q = new URLSearchParams(location.search).get('q');
  if (q && location.pathname === '/search') searchInput.value = q;
}

(async function boot() {
  try { await Promise.all([loadConfig(), refreshMe()]); } catch (e) { console.error(e); window.__brand = 'Privat Stream'; }
  document.body.prepend(topbar, sidebar);
  buildChrome();
  setTitle('');
  onAuthChange(buildChrome);
  setHooks({
    before: (path) => {
      document.body.classList.toggle('immersive', path === '/shorts' || path.startsWith('/shorts/'));
      closeDrawer();
      markActive(path);
    },
  });
  window.addEventListener('popstate', () => markActive(location.pathname));
  await startRouter();
})();
