import { h, icon, setTitle, debounce } from '../util.js';
import { navigate } from '../router.js';
import { createListing, sortSelect } from '../listing.js';

export default async function search({ root, query }) {
  const q = (query.get('q') || '').trim();
  setTitle(q ? `Search: ${q}` : 'Search');
  let sort = query.get('sort') || 'trending';
  const input = h('input', { class: 'input', type: 'search', value: q, placeholder: 'Search videos, tags and creators', maxlength: 100, 'aria-label': 'Search', autocomplete: 'off' });
  const form = h('form', { class: 'row', style: 'margin-bottom:14px', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) navigate(`/search?q=${encodeURIComponent(v)}`); } },
    input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Search' }, icon('search')));
  const page = h('div', { class: 'page' }, form);
  root.append(page);
  void debounce;
  if (!q) { page.append(h('p', { class: 'muted' }, 'Type something to search.')); input.focus(); return; }
  const shorts = createListing({ kind: 'short', params: () => ({ q, sort }), emptyText: 'No matching Shorts.' });
  const longs = createListing({ kind: 'long', params: () => ({ q, sort }), emptyText: 'No matching videos.' });
  page.append(h('div', { class: 'sec-head' }, h('h2', { class: 'sec' }, `Results for “${q}”`), sortSelect(sort, (v) => { sort = v; shorts.reload(); longs.reload(); })),
    h('h3', { style: 'margin:12px 0 8px' }, 'Shorts'), shorts.el, h('div', { class: 'divider' }), h('h3', { style: 'margin:0 0 8px' }, 'Videos'), longs.el);
  shorts.reload(); longs.reload();
}
