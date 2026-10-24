import { h, setTitle, toast } from '../util.js';
import { api, state } from '../api.js';
import { navigate } from '../router.js';
import { shortCard, longCard, emptyState } from '../cards.js';

export default async function saved({ root }) {
  setTitle('Saved Videos');
  if (!state.user) { navigate('/login?next=/saved', { replace: true }); return; }
  const page = h('div', { class: 'page' }, h('h1', { class: 'title', style: 'margin-bottom:10px' }, 'Saved Videos'));
  root.append(page);
  let items;
  try { items = (await api.get('/api/me/saved')).items; } catch (e) { page.append(h('p', { class: 'err' }, e.message)); return; }
  if (!items.length) { page.append(emptyState('Nothing saved yet', 'Tap Save on any video to keep it here.', h('a', { class: 'btn primary', href: '/', style: 'margin-top:12px' }, 'Browse videos'))); return; }
  let tab = 'short';
  const host = h('div'); const tabs = h('div', { class: 'tabs' });
  const shorts = items.filter((v) => v.kind === 'short'), longs = items.filter((v) => v.kind === 'long');
  function cell(v) {
    const card = v.kind === 'short' ? shortCard(v, '') : longCard(v);
    const rm = h('button', { class: 'btn sm', style: 'margin-top:6px', onclick: async () => {
      try { await api.del(`/api/videos/${v.id}/save`); wrapEl.remove(); toast('Removed from saved'); } catch (e) { toast(e.message, 'bad'); }
    } }, 'Remove');
    const wrapEl = h('div', null, card, rm);
    return wrapEl;
  }
  function show() {
    tabs.replaceChildren(h('button', { class: tab === 'short' ? 'on' : '', onclick: () => { tab = 'short'; show(); } }, `Shorts (${shorts.length})`),
      h('button', { class: tab === 'long' ? 'on' : '', onclick: () => { tab = 'long'; show(); } }, `Videos (${longs.length})`));
    const arr = tab === 'short' ? shorts : longs;
    host.replaceChildren(arr.length ? h('div', { class: tab === 'short' ? 'sgrid' : 'lgrid all' }, arr.map(cell)) : h('p', { class: 'muted' }, 'Nothing saved in this tab.'));
  }
  page.append(tabs, host);
  show();
}
