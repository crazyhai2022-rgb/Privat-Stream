import { h, qs } from './util.js';
import { api } from './api.js';
import { shortCard, longCard, emptyState } from './cards.js';

export const SORT_LABELS = {
  trending: 'Trending', recent: 'Recently uploaded', views: 'Most viewed', hearts: 'Most hearted', dislikes: 'Most disliked',
  comments: 'Most commented', shares: 'Most shared', featured: 'Admin featured',
};

export function sortSelect(value, onChange, cls = 'select') {
  const el = h('select', { class: cls, 'aria-label': 'Sort videos', style: cls === 'select' ? 'width:auto;min-width:170px' : '' },
    Object.entries(SORT_LABELS).map(([k, l]) => h('option', { value: k, selected: k === value }, l)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** Paged grid of videos with a "Load more" button. `params()` returns the current filters. */
export function createListing({ kind, params, emptyText = 'No videos found.' }) {
  const grid = h('div', { class: kind === 'short' ? 'sgrid' : 'lgrid all' });
  const more = h('button', { class: 'btn', hidden: true }, 'Load more');
  const msg = h('div', { class: 'loading', hidden: true });
  const el = h('div', null, grid, h('div', { class: 'row', style: 'justify-content:center;margin:18px 0' }, more), msg);
  let page = 0, token = 0;
  async function load(reset) {
    if (reset) { page = 0; grid.replaceChildren(); }
    const my = ++token;
    more.disabled = true;
    msg.hidden = false; msg.textContent = 'Loading…';
    try {
      const p = params();
      const r = await api.get('/api/videos' + qs({ ...p, kind, page, limit: kind === 'short' ? 18 : 12 }));
      if (my !== token) return;
      const ctx = qs({ sort: p.sort, category: p.category, channel: p.channel, q: p.q }).slice(1);
      r.items.forEach((v) => grid.append(kind === 'short' ? shortCard(v, ctx) : longCard(v)));
      more.hidden = !r.has_more;
      msg.hidden = true;
      if (!grid.children.length) { msg.hidden = false; msg.replaceChildren(emptyState('Nothing here yet', emptyText)); }
    } catch (e) { msg.textContent = e.message; }
    more.disabled = false;
  }
  more.addEventListener('click', () => { page++; load(false); });
  return { el, reload: () => load(true) };
}
