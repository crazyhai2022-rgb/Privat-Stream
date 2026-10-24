import { h, setTitle } from '../util.js';
import { api } from '../api.js';
import { shortsRail, longCard, sectionHead, emptyState } from '../cards.js';

export default async function home({ root }) {
  setTitle('');
  const page = h('div', { class: 'page' });
  const feed = h('div');
  const status = h('div', { class: 'loading' }, 'Loading…');
  const sentinel = h('div', { class: 'sentinel' });
  page.append(feed, status, sentinel);
  root.append(page);

  let n = 0, hasMore = true, loading = false, destroyed = false;
  async function loadMore() {
    if (loading || !hasMore || destroyed) return;
    loading = true;
    try {
      const r = await api.get(`/api/feed/home?page=${n}`);
      if (destroyed) return;
      if (r.shorts.length) {
        feed.append(h('section', { class: 'feed-sec' }, sectionHead(n === 0 ? 'Shorts' : 'More Shorts', '/shorts'), shortsRail(r.shorts, 'sort=trending')));
      }
      if (r.long.length) {
        feed.append(h('section', { class: 'feed-sec', style: 'margin-top:14px' },
          sectionHead(n === 0 ? 'Videos' : 'More videos', '/long'), h('div', { class: 'lgrid' }, r.long.map(longCard)), h('div', { class: 'divider', style: 'margin:22px 0 14px' })));
      }
      hasMore = r.has_more;
      n++;
      if (n === 1 && !r.shorts.length && !r.long.length) {
        feed.append(emptyState('No videos yet', 'Approved creators will publish here soon.', h('a', { class: 'btn primary', href: '/upload', style: 'margin-top:12px' }, 'Become a creator')));
        hasMore = false;
      }
    } catch (e) { status.textContent = e.message; hasMore = false; }
    status.hidden = !hasMore;
    loading = false;
  }
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  await loadMore();
  return { destroy() { destroyed = true; io.disconnect(); } };
}
