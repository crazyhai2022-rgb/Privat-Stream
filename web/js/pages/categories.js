import { h, icon, setTitle } from '../util.js';
import { api } from '../api.js';

export default async function categories({ root }) {
  setTitle('Categories');
  const page = h('div', { class: 'page' }, h('h1', { class: 'title' }, 'Categories'), h('p', { class: 'muted', style: 'margin-bottom:16px' }, 'Browse by topic.'));
  const grid = h('div', { class: 'opt-grid', style: 'grid-template-columns:repeat(auto-fill,minmax(220px,1fr))' });
  page.append(grid);
  root.append(page);
  const r = await api.get('/api/categories');
  if (!r.items.length) grid.append(h('p', { class: 'muted' }, 'No categories yet.'));
  r.items.forEach((c) => grid.append(h('a', { class: 'opt', href: `/category/${c.slug}` }, icon('tag'), h('h3', null, c.name),
    h('div', { class: 'muted small' }, `${c.shorts} Shorts · ${c.longs} videos`))));
}
