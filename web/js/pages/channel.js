import { h, icon, setTitle, fmtDate, fmtCount, statusPill } from '../util.js';
import { api, state } from '../api.js';
import { avatarEl, emptyState } from '../cards.js';
import { createListing, sortSelect } from '../listing.js';
import { subscribeBar } from '../engage.js';

export default async function channel({ root, params, query }) {
  let d;
  try { d = await api.get(`/api/channels/${params.handle}`); } catch (e) {
    root.append(h('div', { class: 'page narrow' }, emptyState('Channel not found', 'This channel does not exist or is not public.', h('a', { class: 'btn primary', href: '/', style: 'margin-top:12px' }, 'Back to home'))));
    return;
  }
  const c = d.channel;
  setTitle(c.name);
  let sort = query.get('sort') || 'recent';
  let tab = query.get('tab') === 'long' ? 'long' : 'short';
  const make = (kind) => createListing({ kind, params: () => ({ sort, channel: c.handle }), emptyText: `${c.name} has no ${kind === 'short' ? 'Shorts' : 'long videos'} yet.` });
  const lists = { short: make('short'), long: make('long') };
  const loaded = new Set();
  const host = h('div'), tabs = h('div', { class: 'tabs' });
  function show() {
    tabs.replaceChildren(...['short', 'long'].map((k) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; show(); } },
      k === 'short' ? `Shorts (${c.stats.shorts})` : `Videos (${c.stats.longs})`)));
    host.replaceChildren(lists[tab].el);
    if (!loaded.has(tab)) { loaded.add(tab); lists[tab].reload(); }
  }
  const banner = h('div', { class: 'banner', style: c.banner_url ? `background-image:url('${c.banner_url}')` : '' });
  const bar = subscribeBar(c, { subscribers: c.subscribers, subscribed: c.subscribed }, { telegram: c.telegram, isOwner: d.is_owner });
  root.append(h('div', { class: 'page' },
    d.is_owner && c.status !== 'approved' ? h('div', { class: 'notice warn', style: 'margin-bottom:12px' }, 'Only you can see this channel right now: ', statusPill(c.status)) : null,
    banner,
    h('div', { class: 'chead' }, avatarEl(c, 'xl'),
      h('div', { class: 'cinfo' },
        h('h1', { class: 'title cname' }, c.name),
        h('div', { class: 'muted cmeta' }, h('span', null, `@${c.handle}`), bar.countEl, h('span', null, `${fmtCount(c.stats.views)} views`), h('span', null, `Joined ${fmtDate(c.created_at)}`)),
        c.bio ? h('p', { class: 'cbio' }, c.bio) : null,
        h('div', { class: 'row wrap', style: 'margin-top:10px' }, bar.el, d.is_owner ? h('a', { class: 'btn sm', href: '/studio/channel' }, icon('edit'), 'Edit channel') : null),
        c.categories?.length ? h('div', { class: 'chips', style: 'margin-top:10px' }, c.categories.map((x) => h('a', { class: 'chip', href: `/category/${x.slug}` }, x.name))) : null)),
    h('div', { class: 'sec-head' }, tabs, sortSelect(sort, (v) => { sort = v; loaded.clear(); loaded.add(tab); lists[tab].reload(); })), host));
  show();
  void state;
}
