// Immersive vertical Shorts viewer: one video per screen, scroll-snap + swipe, muted autoplay with an explicit mute control.
import { h, icon, fmtCount, setTitle, qs, toast } from '../util.js';
import { api, state } from '../api.js';
import { navigate } from '../router.js';
import { avatarEl } from '../cards.js';
import { react, toggleSave, shareVideo, reportDialog, requireLogin, subscribeBar, commentsPanel } from '../engage.js';
import { SORT_LABELS } from '../listing.js';

const TITLE_MAX = 32;        // longer titles are cut here and end in "..."
const SEEK_SECONDS = 10;     // double-tap / double-click skips this far
const DOUBLE_TAP_MS = 280;   // how quickly the second tap must follow the first

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
  let stalls = 0, syncingMute = false;

  // ---------- data ----------
  // The default feed is "For you" (a mix of what you watch, what is new and something different).
  // Choosing a sort, category, channel or search switches to that plain list.
  const forYou = filters.sort === 'trending' && !filters.category && !filters.channel && !filters.q;
  const shownIds = new Set();
  async function fetchPage(p) {
    if (forYou) {
      const ex = [...shownIds].slice(-150).join(',');
      const r = await api.get('/api/feed/for-you' + qs({ kind: 'short', limit: 12, exclude: ex }));
      r.items.forEach((v) => shownIds.add(v.id));
      return r;
    }
    return api.get('/api/videos' + qs({ kind: 'short', ...filters, page: p, limit: 12 }));
  }
  try {
    let first = null;
    if (params.id) {
      try {
        const d = await api.get(`/api/videos/${params.id}`);
        if (d.video.kind !== 'short') { navigate(`/watch/${params.id}`, { replace: true }); return; }
        first = d.video; shownIds.add(first.id);
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
    const bufferBar = h('i', { class: 'buf' });
    const progress = h('div', { class: 'sv-progress', role: 'slider', 'aria-label': 'Video progress', 'aria-valuemin': 0, 'aria-valuemax': 100, tabindex: '0',
      onclick: (e) => { const r = progress.getBoundingClientRect(); if (video.duration) video.currentTime = ((e.clientX - r.left) / r.width) * video.duration; } }, bufferBar, progressBar);
    const flash = h('div', { class: 'sv-flash' }, icon('pause', 'fill'));
    const soundBtn = h('button', { class: 'sv-sound', hidden: !muted, 'aria-label': 'Turn sound on', onclick: (e) => { e.stopPropagation(); setMuted(false); } }, icon('mute'), 'Tap for sound');
    const spinner = h('div', { class: 'sv-spin', role: 'status', 'aria-label': 'Buffering', hidden: true }, h('i'));
    // One tap/click toggles play; a quick second one on the left or right third seeks 10 seconds
    // back or forward (and further quick taps keep seeking), like the big video apps.
    const seekL = h('div', { class: 'sv-seek left', 'aria-hidden': 'true' }, h('span', null, '−10s'));
    const seekR = h('div', { class: 'sv-seek right', 'aria-hidden': 'true' }, h('span', null, '+10s'));
    let tapTimer = null, lastTapAt = 0, seeking = false, seekingTimer = null;
    const zoneOf = (e) => { const r = tap.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width; return x < 0.38 ? -1 : x > 0.62 ? 1 : 0; };
    const seekBy = (dir) => {
      if (!(video.duration > 0)) return;
      video.currentTime = Math.min(Math.max(0, video.currentTime + dir * SEEK_SECONDS), Math.max(0, video.duration - 0.05));
      const el = dir < 0 ? seekL : seekR;
      el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
      seeking = true; clearTimeout(seekingTimer); seekingTimer = setTimeout(() => { seeking = false; }, 700);
    };
    const tap = h('div', { class: 'sv-tap', 'aria-hidden': 'true', onclick: (e) => {
      if (node.isOpen?.()) { node.setOpen(false); return; }
      const dir = zoneOf(e);
      const now = performance.now();
      if (dir !== 0 && (seeking || (tapTimer && now - lastTapAt < DOUBLE_TAP_MS))) {
        clearTimeout(tapTimer); tapTimer = null; lastTapAt = now; seekBy(dir); return;
      }
      clearTimeout(tapTimer); lastTapAt = now;
      tapTimer = setTimeout(() => { tapTimer = null; togglePlay(node); }, DOUBLE_TAP_MS);
    } });

    const heart = actBtn('heart', fmtCount(v.metrics.hearts), () => doReact(node, 'heart'), { aria: 'Heart', pressed: true });
    const dis = actBtn('dislike', fmtCount(v.metrics.dislikes), () => doReact(node, 'dislike'), { aria: 'Dislike', pressed: true });
    const com = actBtn('comment', fmtCount(v.metrics.comments), () => toggleSheet(node), { aria: 'View comments' });
    const sha = actBtn('share', fmtCount(v.metrics.shares), async () => { await shareVideo(node.v); refresh(node); }, { aria: 'Share' });
    const sav = actBtn('bookmark', 'Save', async () => { await toggleSave(node.v); refresh(node); }, { aria: 'Save', pressed: true });
    const actions = h('div', { class: 'sv-actions' }, heart.btn, dis.btn, com.btn, sha.btn, sav.btn);

    const who = h('div', { class: 'who' },
      h('a', { href: `/c/${v.channel.handle}`, class: 'row', style: 'gap:8px' }, avatarEl(v.channel, 'md'), h('span', { class: 'un' }, '@' + v.channel.handle)));
    // The title is cut to a fixed length with "..."; the full title, description and category stay hidden
    // until the caption is tapped, so the video keeps the screen.
    const desc = String(v.description || v.caption || '').trim();
    const cut = v.title.length > TITLE_MAX;
    const expandable = cut || (desc && desc !== v.title) || !!v.category;
    const more = h('div', { class: 'more', id: `more-${v.id}` },
      cut ? h('div', { class: 'full' }, v.title) : null,
      desc && desc !== v.title ? h('div', { class: 'txt' }, desc) : null,
      v.category ? h('a', { class: 'cat', href: `/category/${v.category.slug}` }, v.category.name) : null);
    const cap = h('div', { class: `cap${expandable ? ' expandable' : ''}`, role: expandable ? 'button' : null, tabindex: expandable ? '0' : null,
      'aria-expanded': expandable ? 'false' : null, 'aria-controls': expandable ? `more-${v.id}` : null },
      h('div', { class: 'ttl' }, h('b', null, cut ? v.title.slice(0, TITLE_MAX).trimEnd() + '...' : v.title), expandable ? h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('up')) : null),
      more);
    const info = h('div', { class: 'sv-info' }, who, cap);
    node.setOpen = (open) => { info.classList.toggle('open', open); cap.setAttribute('aria-expanded', String(open)); };
    node.isOpen = () => info.classList.contains('open');
    if (expandable) {
      const toggle = (e) => { if (e.target.closest('a')) return; node.setOpen(!node.isOpen()); };
      cap.addEventListener('click', toggle);
      cap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
    }

    const muteBtn = h('button', { class: 'sv-pill', 'aria-label': 'Toggle sound', onclick: (e) => { e.stopPropagation(); setMuted(!muted); } }, icon(muted ? 'mute' : 'volume'));
    const moreBtn = h('button', { class: 'sv-pill', 'aria-label': 'Report this Short', onclick: (e) => { e.stopPropagation(); reportDialog(node.v); } }, icon('flag'));
    const sortSel = h('select', { class: 'sv-sort', 'aria-label': 'Sort Shorts', onchange: (e) => navigate('/shorts' + qs({ ...filters, sort: e.target.value === 'trending' ? '' : e.target.value })) },
      Object.entries(SORT_LABELS).map(([k, l]) => h('option', { value: k, selected: k === filters.sort }, l)));
    const top = h('div', { class: 'sv-top' },
      h('div', { class: 'row', style: 'gap:8px' }, h('a', { class: 'sv-pill', href: '/', 'aria-label': 'Home' }, icon('home')), sortSel),
      h('div', { class: 'row', style: 'gap:8px' }, muteBtn, moreBtn));

    const stage = h('div', { class: 'sv-stage' }, video, tap, seekL, seekR, spinner, soundBtn, flash, top, info, progress);
    const sheet = h('div', { class: 'sv-sheet', hidden: true, role: 'dialog', 'aria-label': 'Comments' });
    stage.append(sheet);
    const el = h('section', { class: 'sv-item', dataset: { id: v.id } }, stage, actions);

    Object.assign(node, { el, video, stage, progressBar, bufferBar, spinner, soundBtn, flash, heart, dis, com, sha, sav, who, muteBtn, sheet, tap });
    video.addEventListener('timeupdate', () => {
      if (video.duration) { const pct = (video.currentTime / video.duration) * 100; progressBar.style.width = pct + '%'; progress.setAttribute('aria-valuenow', String(Math.round(pct))); }
    });
    // ---- Buffering feedback: the spinner appears only if playback has really stalled for 300 ms,
    // so quick seeks and normal starts do not flicker. The pale bar shows how much is already buffered.
    let spinTimer = null;
    node.showSpin = () => {
      if (spinTimer || !spinner.hidden) return;
      spinTimer = setTimeout(() => { spinTimer = null; if (!video.paused && video.readyState < 3) spinner.hidden = false; }, 300);
    };
    const hideSpin = () => { clearTimeout(spinTimer); spinTimer = null; spinner.hidden = true; };
    const stalled = () => { if (nodes[active] === node && !video.paused) { if (video.readyState < 3) stalls++; node.showSpin(); } };
    video.addEventListener('waiting', stalled);
    video.addEventListener('stalled', stalled);
    for (const ev of ['playing', 'canplay', 'seeked', 'pause', 'emptied']) video.addEventListener(ev, hideSpin);
    const drawBuffer = () => {
      if (!video.duration) return;
      let end = 0;
      for (let k = 0; k < video.buffered.length; k++) if (video.buffered.start(k) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(k));
      bufferBar.style.width = Math.min(100, (end / video.duration) * 100) + '%';
    };
    video.addEventListener('progress', drawBuffer);
    video.addEventListener('timeupdate', drawBuffer);
    video.addEventListener('playing', () => { node.retries = 0; node.error = false; });

    // ---- Recovery: a dropped connection retries with a growing delay, resuming where it stopped.
    video.addEventListener('error', () => {
      node.error = true;
      if (!video.getAttribute('src') || (node.retries || 0) >= 3 || destroyed) { hideSpin(); return; }
      node.retries = (node.retries || 0) + 1;
      const at = video.currentTime || 0;
      if (nodes[active] === node) { spinner.hidden = false; }
      setTimeout(() => {
        if (destroyed || !video.getAttribute('src')) return;
        video.load();
        video.addEventListener('loadedmetadata', () => { if (at) video.currentTime = at; if (nodes[active] === node) video.play().catch(() => {}); }, { once: true });
      }, 600 * 2 ** (node.retries - 1));
    });

    // ---- Volume: the browser reports volume changes made through its own controls; treat them as "turn sound on".
    video.addEventListener('volumechange', () => {
      if (syncingMute) return;
      if (!video.muted && muted) setMuted(false);
    });
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
    syncingMute = true;
    nodes.forEach((n) => {
      n.video.muted = m;
      if (!m && n.video.volume === 0) n.video.volume = 1;
      n.soundBtn.hidden = !m;
      const old = n.muteBtn.firstChild; n.muteBtn.replaceChild(icon(m ? 'mute' : 'volume'), old);
    });
    setTimeout(() => { syncingMute = false; }, 0);
  }
  // How much to load ahead depends on the connection: nothing extra on Data Saver / 2G or after repeated stalls.
  function netTier() {
    const c = navigator.connection;
    if (stalls >= 3 || c?.saveData || /(^|slow-)2g/.test(c?.effectiveType || '')) return 'low';
    if (c?.effectiveType === '4g' && (c.downlink || 10) >= 5) return 'high';
    return 'mid';
  }
  function preloadAhead(i) {
    const tier = netTier();
    const next = nodes[i + 1], after = nodes[i + 2];
    if (next) ensureSrc(next, tier === 'low' ? 'metadata' : 'auto');
    if (after) ensureSrc(after, tier === 'high' ? 'auto' : 'metadata');
    return tier === 'low' ? 2 : 3;
  }
  function ensureSrc(node, preload = 'metadata') {
    if (!node.v.stream_url) return;
    if (!node.video.getAttribute('src')) node.video.src = node.v.stream_url;
    else if (node.error && node.video.error) { node.error = false; node.retries = 0; node.video.load(); }
    node.video.preload = preload;
  }
  function release(node) {
    if (node.video.getAttribute('src')) { node.video.pause(); node.video.removeAttribute('src'); node.video.load(); }
  }
  async function playNode(node) {
    ensureSrc(node, 'auto');
    node.video.muted = muted;
    if (node.video.readyState < 3) node.showSpin?.();
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
      const mine = state.channel?.handle === node.v.channel.handle;
      let info = { subscribers: 0, subscribed: false };
      try { info = await api.get(`/api/channels/${node.v.channel.handle}/subscription`); } catch { /* show the bar anyway */ }
      node.who.append(subscribeBar(node.v.channel, info, { telegram: m.telegram, isOwner: mine }).el);
      refresh(node);
    } catch { node.detail = false; }
  }

  function activate(i) {
    if (i === active || i < 0 || i >= nodes.length) return;
    const prev = nodes[active];
    if (prev) { prev.setOpen?.(false); prev.video.pause(); clearTimeout(timers.get(prev)); if (!prev.sheet.hidden) { prev.sheet.classList.remove('open'); prev.sheet.hidden = true; } }
    active = i;
    const node = nodes[i];
    playNode(node);
    const keep = preloadAhead(i);
    nodes.forEach((n, k) => { if (Math.abs(k - i) > keep) release(n); });
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
    // Hardware / media volume keys (where the browser reports them) switch the sound on.
    if (['AudioVolumeUp', 'AudioVolumeDown', 'VolumeUp', 'VolumeDown'].includes(e.key) || ['AudioVolumeUp', 'AudioVolumeDown'].includes(e.code)) { if (muted) setMuted(false); return; }
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
