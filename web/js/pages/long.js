import { h, setTitle } from '../util.js';
import { state } from '../api.js';
import { navigate } from '../router.js';
import { createListing, sortSelect } from '../listing.js';

export default async function longVideos({ root, query }) {
  setTitle('Long Videos');
  let sort = query.get('sort') || 'trending';
  let category = query.get('category') || '';
  const listing = createListing({ kind: 'long', params: () => ({ sort, category }), emptyText: 'No long videos match these filters.' });
  const cat = h('select', { class: 'select', style: 'width:auto;min-width:150px', 'aria-label': 'Category' },
    h('option', { value: '' }, 'All categories'), (state.config?.categories || []).map((c) => h('option', { value: c.slug, selected: c.slug === category }, c.name)));
  cat.addEventListener('change', () => { category = cat.value; listing.reload(); });
  root.append(h('div', { class: 'page' }, h('div', { class: 'sec-head' }, h('h1', { class: 'title' }, 'Long Videos'),
    h('div', { class: 'row wrap' }, cat, sortSelect(sort, (v) => { sort = v; listing.reload(); }))), listing.el));
  listing.reload();
  void navigate;
}
