import { h, icon, fmtCount, fmtDur, timeAgo, initials } from './util.js';
import { navigate } from './router.js';

export function avatarEl(channel, cls = '') {
  const label = channel?.name || channel?.handle || '?';
  if (channel?.avatar_url) return h('img', { class: `avatar ${cls}`, src: channel.avatar_url, alt: '', loading: 'lazy' });
  return h('div', { class: `avatar ${cls}`, 'aria-hidden': 'true' }, initials(label));
}

function thumb(v, cls) {
  if (!v.thumbnail_url) return h('div', { class: `ph ${cls || ''}` }, 'No preview');
  const img = h('img', { src: v.thumbnail_url, alt: v.title ? `Thumbnail: ${v.title}` : 'Video thumbnail', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(h('div', { class: `ph ${cls || ''}` }, 'No preview')), { once: true });
  return img;
}

/** ctx: query string (without ?) that tells the Shorts viewer which list to continue with. */
export function shortCard(v, ctx = '') {
  return h('a', { class: 'scard', href: `/shorts/${v.id}${ctx ? '?' + ctx : ''}`, title: v.title },
    thumb(v),
    v.duration ? h('span', { class: 'badge-dur' }, fmtDur(v.duration)) : null,
    h('div', { class: 'scrim-b' },
      h('div', { class: 't clamp2' }, v.title),
      h('div', { class: 'u' }, '@' + v.channel.handle),
      h('div', { class: 'v' }, `${fmtCount(v.metrics.views)} views`)));
}

export function longCard(v) {
  return h('a', { class: 'lcard', href: `/watch/${v.id}` },
    h('div', { class: 'th' }, thumb(v), v.duration ? h('span', { class: 'badge-dur br' }, fmtDur(v.duration)) : null),
    h('div', { class: 'meta' },
      h('span', { onclick: (e) => { e.preventDefault(); e.stopPropagation(); navigate(`/c/${v.channel.handle}`); } }, avatarEl(v.channel, 'md')),
      h('div', { class: 'grow' },
        h('div', { class: 't clamp2' }, v.title),
        h('div', { class: 'sub' }, `@${v.channel.handle}`),
        h('div', { class: 'sub' }, `${fmtCount(v.metrics.views)} views · ${timeAgo(v.published_at)}`))));
}

export function shortsRail(items, ctx = '') {
  const rail = h('div', { class: 'rail' }, items.map((v) => shortCard(v, ctx)));
  const step = () => Math.max(300, rail.clientWidth * 0.8);
  const l = h('button', { class: 'rail-btn l', 'aria-label': 'Scroll left', onclick: () => rail.scrollBy({ left: -step(), behavior: 'smooth' }) }, icon('left'));
  const r = h('button', { class: 'rail-btn r', 'aria-label': 'Scroll right', onclick: () => rail.scrollBy({ left: step(), behavior: 'smooth' }) }, icon('right'));
  return h('div', { class: 'rail-wrap' }, l, rail, r);
}

export function sectionHead(title, href, linkText = 'See all') {
  return h('div', { class: 'sec-head' }, h('h2', { class: 'sec' }, title), href ? h('a', { class: 'more', href }, linkText) : null);
}

export const emptyState = (title, text, action) => h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, action || null);

export function skeletonGrid(n = 4, kind = 'long') {
  return h('div', { class: kind === 'long' ? 'lgrid' : 'sgrid' }, Array.from({ length: n }, () =>
    h('div', { class: 'skel', style: kind === 'long' ? 'aspect-ratio:16/9' : 'aspect-ratio:9/16' })));
}
