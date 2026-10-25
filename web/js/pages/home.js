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

  let n = 0, hasMore = true, loading = false, destroyed = false, pending = null;
  const shown = { short: new Set(), long: new Set() };

  // "For you": a mix of what you watch, what is new and something different; nothing repeats.
  function fetchBatch() {
    const ex = (kind) => [...shown[kind]].slice(-150).join(',');
    return Promise.all([
      api.get(`/api/feed/for-you?kind=short&limit=10&exclude=${encodeURIComponent(ex('short'))}`),
      api.get(`/api/feed/for-you?kind=long&limit=5&exclude=${encodeURIComponent(ex('long'))}`),
    ]).then(([sh, lg]) => {
      for (const v of sh.items) shown.short.add(v.id);
      for (const v of lg.items) shown.long.add(v.id);
      return { shorts: sh.items, long: lg.items, has_more: sh.has_more || lg.has_more };
    });
  }

  async function loadMore() {
    if (loading || !hasMore || destroyed) return;
    loading = true;
    try {
      // The next batch is requested as soon as the current one is on screen, so it is ready
      // before the reader reaches the end and scrolling never waits for the network.
      const ready = pending; pending = null;
      const r = await (ready || fetchBatch()).catch(() => fetchBatch());
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
      if (hasMore) { pending = fetchBatch(); pending.catch(() => {}); }
    } catch (e) { status.textContent = e.message; hasMore = false; }
    status.hidden = !hasMore;
    loading = false;
    // The observer only reports changes; look again so a sentinel that is still near the screen keeps loading.
    if (hasMore && !destroyed) { io.unobserve(sentinel); io.observe(sentinel); }
  }
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '1200px' });
  io.observe(sentinel);
  await loadMore();
  return { destroy() { destroyed = true; io.disconnect(); } };
}
