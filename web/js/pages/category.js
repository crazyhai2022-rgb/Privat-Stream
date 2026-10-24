import { h, setTitle } from '../util.js';
import { state } from '../api.js';
import { createListing, sortSelect } from '../listing.js';
import { emptyState } from '../cards.js';

export default async function category({ root, params, query }) {
  const cat = (state.config?.categories || []).find((c) => c.slug === params.slug);
  if (!cat) { root.append(h('div', { class: 'page' }, emptyState('Category not found', 'It may have been removed.', h('a', { class: 'btn primary', href: '/categories', style: 'margin-top:12px' }, 'All categories')))); return; }
  setTitle(cat.name);
  let sort = query.get('sort') || 'trending';
  let tab = query.get('tab') === 'long' ? 'long' : 'short';
  const make = (kind) => createListing({ kind, params: () => ({ sort, category: cat.slug }), emptyText: `No ${kind === 'short' ? 'Shorts' : 'videos'} in ${cat.name} yet.` });
  const lists = { short: make('short'), long: make('long') };
  const host = h('div');
  const tabs = h('div', { class: 'tabs' });
  const loaded = new Set();
  function show() {
    tabs.replaceChildren(...['short', 'long'].map((k) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; show(); } }, k === 'short' ? 'Shorts' : 'Long videos')));
    host.replaceChildren(lists[tab].el);
    if (!loaded.has(tab)) { loaded.add(tab); lists[tab].reload(); }
  }
  root.append(h('div', { class: 'page' }, h('div', { class: 'sec-head' }, h('h1', { class: 'title' }, cat.name),
    sortSelect(sort, (v) => { sort = v; loaded.clear(); loaded.add(tab); lists[tab].reload(); })), tabs, host));
  show();
}
