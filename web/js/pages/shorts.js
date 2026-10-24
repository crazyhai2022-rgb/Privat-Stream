// Immersive vertical Shorts viewer: one video per screen, scroll-snap + swipe, muted autoplay with an explicit mute control.
import { h, icon, fmtCount, setTitle, qs, toast } from '../util.js';
import { api, state } from '../api.js';
import { navigate } from '../router.js';
import { avatarEl } from '../cards.js';
import { react, toggleSave, shareVideo, reportDialog, requireLogin, telegramButton, commentsPanel } from '../engage.js';
import { SORT_LABELS } from '../listing.js';

let muted = true; // starts muted (browser autoplay rules + no surprise audio); stays unmuted once the user chooses

export default async function shorts({ root, params, query }) {
  const filters = { sort: query.get('sort') || 'trending', category: query.get('category') || '', channel: query.get('channel') || '', q: query.get('q') || '' };
  const ctxQuery = () => qs({ sort: filters.sort === 'trending' ? '' : filters.sort, category: filters.category, channel: filters.channel, q: filters.q });
  const wrap = h('div', { class: 'sv' });
  const scroller = h('div', { class: 'sv-scroll', tabindex: '-1', 'aria-label': 'Shorts feed' });
  wrap.append(scroller);
  root.append(wrap);
  setTitle('Shorts');

  const nodes = [];
  const items = [];
  let active = -1, page = 0, hasMore = true, loadingMore = false, destroyed = false;
  const timers = new Map();

  // ---------- data ----------
  async function fetchPage(p) {
    const r = await api.get('/api/videos' + qs({ kind: 'short', ...filters, page: p, limit: 12 }));
    return r;
  }
  try {
    let first = null;
    if (params.id) {
      try {
        const d = await api.get(`/api/videos/${params.id}`);
        if (d.video.kind !== 'short') { navigate(`/watch/${params.id}`, { replace: true }); return; }
        first = d.video;
      } catch { toast('That Short is not available', 'bad'); }
    }
    const r = await fetchPage(0);
    hasMore = r.has_more;
    const list = r.items.filter((v) => !first || v.id !== first.id);
    items.push(...(first ? [first, ...list] : list));
  } catch (e) {
    scroller.append(h('div', { class: 'sv-empty' }, h('div', null, h('h3', null, 'Could not load Shorts'), h('p', { class: 'muted' }, e.message))));
    return { destroy() {} };
  }
  if (!items.length) {
    scroller.append(h('div', { class: 'sv-empty' }, h('div', null, h('h3', null, 'No Shorts yet'), h('p', { class: 'muted' }, 'Check back soon or browse long videos.'),
      h('a', { class: 'btn primary', href: '/', style: 'margin-top:12px' }, 'Go home'))));
    return { destroy() {} };
  }

  // ---------- building one item ----------
  function actBtn(name, label, onClick, extra = {}) {
    const count = h('span', null, label);
    const btn = h('button', { class: 'sv-act', 'aria-label': extra.aria || label, onclick: onClick }, h('span', { class: 'ico' }, icon(name)), count);
    return { btn, set(text, on) { count.textContent = text; btn.classList.toggle('on', !!on); if (extra.pressed) btn.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  }

  function build(v) {
    const node = { v, loaded: false, detail: false, viewed: false };
    const video = h('video', { playsinline: '', loop: '', muted: '', preload: 'none', poster: v.thumbnail_url || '', 'aria-label': v.title });
    video.muted = true;
    const landscape = v.width && v.height && v.width / v.height > 0.75;
    if (landscape) video.classList.add('contain');
    const progressBar = h('i');
    const progress = h('div', { class: 'sv-progress', role: 'slider', 'aria-label': 'Video progress', 'aria-valuemin': 0, 'aria-valuemax': 100, tabindex: '0',
      onclick: (e) => { const r = progress.getBoundingClientRect(); if (video.duration) video.currentTime = ((e.clientX - r.left) / r.width) * video.duration; } }, progressBar);
    const flash = h('div', { class: 'sv-flash' }, icon('pause', 'fill'));
    const tap = h('div', { class: 'sv-tap', onclick: () => togglePlay(node), 'aria-hidden': 'true' });

    const heart = actBtn('heart', fmtCount(v.metrics.hearts), () => doReact(node, 'heart'), { aria: 'Heart', pressed: true });
    const dis = actBtn('dislike', fmtCount(v.metrics.dislikes), () => doReact(node, 'dislike'), { aria: 'Dislike', pressed: true });
    const com = actBtn('comment', fmtCount(v.metrics.comments), () => toggleSheet(node), { aria: 'View comments' });
    const sha = actBtn('share', fmtCount(v.metrics.shares), async () => { await shareVideo(node.v); refresh(node); }, { aria: 'Share' });
    const sav = actBtn('bookmark', 'Save', async () => { await toggleSave(node.v); refresh(node); }, { aria: 'Save', pressed: true });
    const actions = h('div', { class: 'sv-actions' }, heart.btn, dis.btn, com.btn, sha.btn, sav.btn);

    const who = h('div', { class: 'who' },
      h('a', { href: `/c/${v.channel.handle}`, class: 'row', style: 'gap:8px' }, avatarEl(v.channel, 'md'), h('span', { class: 'un' }, '@' + v.channel.handle)));
    const info = h('div', { class: 'sv-info' }, who,
      h('div', { class: 'cap' }, h('b', null, v.title), v.caption && v.caption !== v.title ? h('div', { class: 'clamp2', style: 'margin-top:2px;font-weight:400' }, v.caption) : null),
      v.category ? h('a', { class: 'cat', href: `/category/${v.category.slug}` }, v.category.name) : null);

    const muteBtn = h('button', { class: 'sv-pill', 'aria-label': 'Toggle sound', onclick: (e) => { e.stopPropagation(); setMuted(!muted); } }, icon(muted ? 'mute' : 'volume'));
    const moreBtn = h('button', { class: 'sv-pill', 'aria-label': 'Report this Short', onclick: (e) => { e.stopPropagation(); reportDialog(node.v); } }, icon('flag'));
    const sortSel = h('select', { class: 'sv-sort', 'aria-label': 'Sort Shorts', onchange: (e) => navigate('/shorts' + qs({ ...filters, sort: e.target.value === 'trending' ? '' : e.target.value })) },
      Object.entries(SORT_LABELS).map(([k, l]) => h('option', { value: k, selected: k === filters.sort }, l)));
    const top = h('div', { class: 'sv-top' },
      h('div', { class: 'row', style: 'gap:8px' }, h('a', { class: 'sv-pill', href: '/', 'aria-label': 'Home' }, icon('home')), sortSel),
      h('div', { class: 'row', style: 'gap:8px' }, muteBtn, moreBtn));

    const stage = h('div', { class: 'sv-stage' }, video, tap, flash, top, info, progress);
    const sheet = h('div', { class: 'sv-sheet', hidden: true, role: 'dialog', 'aria-label': 'Comments' });
    stage.append(sheet);
    const el = h('section', { class: 'sv-item', dataset: { id: v.id } }, stage, actions);

    Object.assign(node, { el, video, stage, progressBar, flash, heart, dis, com, sha, sav, who, muteBtn, sheet, tap });
    video.addEventListener('timeupdate', () => {
      if (video.duration) { const pct = (video.currentTime / video.duration) * 100; progressBar.style.width = pct + '%'; progress.setAttribute('aria-valuenow', String(Math.round(pct))); }
    });
    video.addEventListener('error', () => { node.error = true; });
    refresh(node);
    return node;
  }

  function refresh(node) {
    const v = node.v;
    node.heart.set(fmtCount(v.metrics.hearts), v.my_reaction === 'heart');
    node.dis.set(fmtCount(v.metrics.dislikes), v.my_reaction === 'dislike');
    node.com.set(fmtCount(v.metrics.comments));
    node.sha.set(fmtCount(v.metrics.shares));
    node.sav.set(v.saved ? 'Saved' : 'Save', v.saved);
    if (node.sheetCount) node.sheetCount.textContent = `Comments (${fmtCount(v.metrics.comments)})`;
  }

  async function doReact(node, type) { await react(node.v, type); refresh(node); }

  function toggleSheet(node) {
    const { sheet } = node;
    if (!node.sheetBuilt) {
      node.sheetBuilt = true;
      node.sheetCount = h('span', null, `Comments (${fmtCount(node.v.metrics.comments)})`);
      const list = h('div', { class: 'list' }, commentsPanel(node.v, { onCount: () => refresh(node) }));
      sheet.append(h('header', null, node.sheetCount, h('button', { class: 'icon-btn', 'aria-label': 'Close comments', onclick: () => toggleSheet(node) }, icon('x'))), list);
    }
    if (sheet.hidden) { sheet.hidden = false; requestAnimationFrame(() => sheet.classList.add('open')); }
    else { sheet.classList.remove('open'); setTimeout(() => { sheet.hidden = true; }, 220); }
  }

  // ---------- playback ----------
  function setMuted(m) {
    muted = m;
    nodes.forEach((n) => { n.video.muted = m; const old = n.muteBtn.firstChild; n.muteBtn.replaceChild(icon(m ? 'mute' : 'volume'), old); });
  }
  function ensureSrc(node, preload = 'metadata') {
    if (!node.v.stream_url) return;
    if (!node.video.getAttribute('src')) node.video.src = node.v.stream_url;
    node.video.preload = preload;
  }
  function release(node) {
    if (node.video.getAttribute('src')) { node.video.pause(); node.video.removeAttribute('src'); node.video.load(); }
  }
  async function playNode(node) {
    ensureSrc(node, 'auto');
    node.video.muted = muted;
    try { await node.video.play(); } catch {
      if (!node.video.muted) { setMuted(true); try { await node.video.play(); } catch { /* user will tap */ } }
    }
  }
  function togglePlay(node) {
    const v = node.video;
    if (v.paused) { playNode(node); node.flash.replaceChildren(icon('play', 'fill')); } else { v.pause(); node.flash.replaceChildren(icon('pause', 'fill')); }
    node.flash.classList.remove('show'); void node.flash.offsetWidth; node.flash.classList.add('show');
  }

  async function loadDetail(node) {
    if (node.detail) return;
    node.detail = true;
    try {
      const d = await api.get(`/api/videos/${node.v.id}`);
      const m = d.video;
      Object.assign(node.v, { my_reaction: m.my_reaction, saved: m.saved, telegram: m.telegram, comments_enabled: m.comments_enabled, description: m.description });
      node.v.metrics = { ...node.v.metrics, ...m.metrics };
      const tg = telegramButton(m.telegram);
      if (tg) node.who.append(tg);
      refresh(node);
    } catch { node.detail = false; }
  }

  function activate(i) {
    if (i === active || i < 0 || i >= nodes.length) return;
    const prev = nodes[active];
    if (prev) { prev.video.pause(); clearTimeout(timers.get(prev)); if (!prev.sheet.hidden) { prev.sheet.classList.remove('open'); prev.sheet.hidden = true; } }
    active = i;
    const node = nodes[i];
    playNode(node);
    ensureSrc(nodes[i + 1]?.video ? nodes[i + 1] : node, 'metadata');
    nodes.forEach((n, k) => { if (Math.abs(k - i) > 3) release(n); });
    loadDetail(node);
    history.replaceState(null, '', `/shorts/${node.v.id}${ctxQuery()}`);
    setTitle(node.v.title);
    // Count a view after 3 seconds of this Short being on screen.
    if (!node.viewed) {
      timers.set(node, setTimeout(async () => {
        if (destroyed || active !== i || node.video.paused) return;
        node.viewed = true;
        try { const r = await api.post(`/api/videos/${node.v.id}/view`); if (r.counted) node.v.metrics.views = r.views; } catch { /* ignore */ }
      }, 3000));
    }
    if (i >= nodes.length - 3) loadMore();
  }

  async function loadMore() {
    if (loadingMore || !hasMore || destroyed) return;
    loadingMore = true;
    try {
      page++;
      const r = await fetchPage(page);
      hasMore = r.has_more;
      const seen = new Set(items.map((x) => x.id));
      const fresh = r.items.filter((x) => !seen.has(x.id));
      fresh.forEach((v) => { items.push(v); addNode(v); });
    } catch { /* retry on next scroll */ page--; }
    loadingMore = false;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(nodes.findIndex((n) => n.el === e.target));
    }
  }, { root: scroller, threshold: [0.6] });

  function addNode(v) {
    const n = build(v);
    nodes.push(n);
    scroller.append(n.el);
    io.observe(n.el);
    return n;
  }
  items.forEach(addNode);

  // Desktop up/down buttons + keyboard
  const go = (d) => { const t = nodes[active + d]; if (t) t.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const navBtns = h('div', { class: 'sv-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous Short', onclick: () => go(-1) }, icon('up')),
    h('button', { class: 'icon-btn', 'aria-label': 'Next Short', onclick: () => go(1) }, icon('down')));
  wrap.append(navBtns);
  const onKey = (e) => {
    if (e.target.closest?.('input,textarea,select,[contenteditable]')) return;
    if (['ArrowDown', 'PageDown', 'j'].includes(e.key)) { e.preventDefault(); go(1); }
    else if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); go(-1); }
    else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); if (nodes[active]) togglePlay(nodes[active]); }
    else if (e.key === 'm') setMuted(!muted);
    else if (e.key === 'ArrowRight' && nodes[active]?.video.duration) nodes[active].video.currentTime += 5;
    else if (e.key === 'ArrowLeft' && nodes[active]) nodes[active].video.currentTime -= 5;
  };
  document.addEventListener('keydown', onKey);
  const onVis = () => { const n = nodes[active]; if (!n) return; if (document.hidden) n.video.pause(); };
  document.addEventListener('visibilitychange', onVis);

  // Start on the first item (the requested Short).
  requestAnimationFrame(() => { activate(0); });
  void state;

  return {
    destroy() {
      destroyed = true;
      io.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      timers.forEach((t) => clearTimeout(t));
      nodes.forEach((n) => { n.video.pause(); n.video.removeAttribute('src'); n.video.load(); });
    },
  };
}
