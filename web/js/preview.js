// Muted video previews on cards.
//  - Desktop (mouse): hover a card -> short highlight reel plays after a tiny delay.
//  - Phone/tablet (touch): press-and-hold a card, or just scroll: when scrolling stops the card
//    nearest the screen centre (at least 60% visible) starts previewing.
// "Best parts" = a few short clips sampled at fixed points of the video (skips the intro).
// Cache = small LRU of already-loaded <video> elements (plus the normal browser HTTP cache),
// so re-hovering a card starts instantly. Only one preview plays at a time.

const MAX_CACHE_MOUSE = 6;
const MAX_CACHE_TOUCH = 3;
const HOVER_DELAY = 350;   // ms before a hover turns into a preview
const HOLD_DELAY = 180;    // ms touch-hold
const TOUCH_LINGER = 6000; // ms a touch preview keeps playing after the finger is lifted
const SCROLL_IDLE = 220;   // ms without scrolling before we pick a card

const cache = new Map();   // id -> { el, failed }  (insertion order = LRU order)
let active = null;         // { id, host, el, stop, mode }

const mq = (q) => { try { return window.matchMedia(q).matches; } catch { return false; } };
const hoverCapable = () => mq('(hover: hover) and (pointer: fine)');

// Hover / press-and-hold are explicit actions, so they only need the data-saver check; automatic scroll previews
// also respect "reduce motion" and slow connections.
function allowed(mode) {
  if (document.hidden) return false;
  const c = navigator.connection;
  if (c && c.saveData) return false;
  if (mode === 'scroll') {
    if (mq('(prefers-reduced-motion: reduce)')) return false;
    if (c && /^(slow-2g|2g)$/.test(c.effectiveType || '')) return false;
  }
  return true;
}

/** Highlight clips [start,end] in seconds. */
export function planClips(dur) {
  if (!(dur > 0)) return [[0, 5]];
  if (dur <= 12) return [[0, Math.min(dur, 6)]];
  if (dur <= 90) return [0.2, 0.55].map((p) => [Math.floor(dur * p), Math.floor(dur * p) + 3]);
  return [0.12, 0.35, 0.6, 0.82].map((p) => [Math.floor(dur * p), Math.floor(dur * p) + 2.5]);
}

function getVideo(v) {
  let e = cache.get(v.id);
  if (e) { cache.delete(v.id); cache.set(v.id, e); return e; }
  const el = document.createElement('video');
  el.className = 'pv';
  el.muted = true; el.defaultMuted = true; el.loop = false;
  el.playsInline = true; el.setAttribute('playsinline', ''); el.setAttribute('webkit-playsinline', '');
  el.disablePictureInPicture = true;
  el.setAttribute('disableremoteplayback', '');
  el.preload = 'metadata';
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  el.src = v.stream_url;
  e = { el, failed: false };
  el.addEventListener('error', () => { e.failed = true; }, { once: true });
  cache.set(v.id, e);
  const max = hoverCapable() ? MAX_CACHE_MOUSE : MAX_CACHE_TOUCH;
  for (const [k, ent] of cache) {
    if (cache.size <= max) break;
    if (active && active.id === k) continue;
    ent.el.removeAttribute('src'); ent.el.load();
    ent.el.remove();
    cache.delete(k);
  }
  return e;
}

function stopActive() { if (active) active.stop(); }

function start(v, host, mode) {
  if (!v.stream_url || v.playable === false || !allowed(mode) || !host.isConnected) return;
  if (active && active.host === host) { if (mode === 'touch') active.mode = 'touch'; return; }
  stopActive();
  const ent = getVideo(v);
  if (ent.failed) return;
  const el = ent.el;
  let clips = planClips(v.duration || el.duration);
  let ci = 0;
  let done = false;
  let bar = host.querySelector(':scope > .pv-bar');
  if (!bar) { bar = document.createElement('i'); bar.className = 'pv-bar'; }
  bar.style.transform = 'scaleX(0)';
  bar.classList.add('wait'); // shimmer on the bottom edge while the first frames load

  const total = () => clips.reduce((s, c) => s + (c[1] - c[0]), 0);
  const seek = (t) => { try { el.currentTime = t; } catch { /* metadata not ready yet */ } };

  const onMeta = () => {
    if (!v.duration && isFinite(el.duration)) clips = planClips(el.duration);
    seek(clips[ci][0]);
  };
  const onTime = () => {
    if (done) return;
    if (!host.isConnected) { stop(); return; }
    if (el.currentTime >= clips[ci][1] - 0.05 || el.ended) {
      ci = (ci + 1) % clips.length;
      seek(clips[ci][0]);
    }
    const before = clips.slice(0, ci).reduce((a, c) => a + (c[1] - c[0]), 0);
    const p = (before + Math.max(0, el.currentTime - clips[ci][0])) / (total() || 1);
    bar.style.transform = `scaleX(${Math.min(1, p)})`;
  };
  const onPlaying = () => { if (!done) { el.classList.add('on'); bar.classList.remove('wait'); } };
  const onErr = () => stop();

  function stop() {
    if (done) return;
    done = true;
    clearTimeout(startTimer);
    const started = el.classList.contains('on');
    el.removeEventListener('loadedmetadata', onMeta);
    el.removeEventListener('timeupdate', onTime);
    el.removeEventListener('playing', onPlaying);
    el.removeEventListener('error', onErr);
    try { el.pause(); } catch { /* ignore */ }
    el.classList.remove('on');
    bar.style.transform = 'scaleX(0)'; bar.classList.remove('wait');
    el.remove();
    // Never got going (slow file, e.g. index at the end of the MP4): drop the request so it cannot clog the connection.
    if (!started) { try { el.removeAttribute('src'); el.load(); } catch { /* ignore */ } cache.delete(v.id); }
    if (active && active.stop === stop) active = null;
  }
  const startTimer = setTimeout(() => { if (!el.classList.contains('on')) stop(); }, 10000);

  active = { id: v.id, host, el, stop, mode };
  el.addEventListener('loadedmetadata', onMeta);
  el.addEventListener('timeupdate', onTime);
  el.addEventListener('playing', onPlaying);
  el.addEventListener('error', onErr);
  host.appendChild(el);
  host.appendChild(bar);
  if (el.readyState >= 1) onMeta();
  const p = el.play();
  if (p && p.catch) p.catch(() => stop());
}

// ---- scroll-driven previews (touch devices) ----
const visible = new Map(); // host -> ratio
let io = null;
let scrollTimer = 0;
let fingerDown = false;

function ensureScroll() {
  if (io || !('IntersectionObserver' in window)) return;
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const host = en.target;
      if (en.intersectionRatio > 0.05 && host.isConnected) visible.set(host, en.intersectionRatio);
      else { visible.delete(host); if (!host.isConnected) io.unobserve(host); }
      if (active && active.host === host && active.mode === 'scroll' && en.intersectionRatio < 0.4) stopActive();
    }
  }, { threshold: [0, 0.05, 0.4, 0.6, 0.9, 1] });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('touchstart', () => { fingerDown = true; }, { capture: true, passive: true });
  for (const ev of ['touchend', 'touchcancel']) window.addEventListener(ev, () => { fingerDown = false; }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopActive(); });
}

function onScroll() {
  if (hoverCapable()) return;
  if (active && active.mode === 'touch' && !fingerDown) stopActive(); // momentum scrolling after a hold
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(pickByScroll, SCROLL_IDLE);
}

function pickByScroll() {
  if (hoverCapable() || !allowed('scroll')) return;
  if (active && active.mode === 'touch') return; // the user is holding a card
  const my = innerHeight / 2, mx = innerWidth / 2;
  let best = null, bestD = Infinity;
  for (const [host, ratio] of visible) {
    if (!host.isConnected || ratio < 0.6) continue;
    const r = host.getBoundingClientRect();
    if (r.right < 0 || r.left > innerWidth) continue;
    const d = Math.abs(r.top + r.height / 2 - my) + 0.5 * Math.abs(r.left + r.width / 2 - mx);
    if (d < bestD) { bestD = d; best = host; }
  }
  if (!best) { if (active && active.mode === 'scroll') stopActive(); return; }
  start(best.__pv, best, 'scroll');
}

/**
 * Attach preview behaviour to a card.
 * card: the clickable element; v: video item; host: positioned, overflow-hidden element that receives the <video>.
 */
export function attachPreview(card, v, host = card) {
  if (!v || !v.stream_url || v.playable === false) return card;
  let hoverT = 0, holdT = 0, endT = 0, sx = 0, sy = 0, moved = false, touching = false;

  // Mouse hover (pointer events, so touch laptops behave too).
  card.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || !allowed('hover')) return;
    clearTimeout(hoverT);
    hoverT = setTimeout(() => start(v, host, 'hover'), HOVER_DELAY);
  });
  card.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(hoverT);
    if (active && active.host === host) stopActive();
  });

  // Touch: press-and-hold starts the preview quickly; it keeps playing for a few seconds after the finger lifts
  // (the first frames can take a moment to arrive) and stops when you scroll, touch another card or open the video.
  let lastTouch = 0;
  card.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; moved = false; touching = true; lastTouch = Date.now();
    clearTimeout(endT); clearTimeout(holdT);
    holdT = setTimeout(() => { if (!moved && touching) start(v, host, 'touch'); }, HOLD_DELAY);
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) + Math.abs(t.clientY - sy) > 10) {
      moved = true; clearTimeout(holdT);
      if (active && active.host === host && active.mode === 'touch') stopActive();
    }
  }, { passive: true });
  const touchEnd = () => {
    touching = false; clearTimeout(holdT); lastTouch = Date.now();
    if (active && active.host === host && active.mode === 'touch') {
      endT = setTimeout(() => { if (active && active.host === host && active.mode === 'touch') stopActive(); }, TOUCH_LINGER);
    }
  };
  card.addEventListener('touchend', touchEnd, { passive: true });
  card.addEventListener('touchcancel', touchEnd, { passive: true });
  // A long-press on a link opens the browser's context menu (and cancels the touch); keep it away from cards.
  card.addEventListener('contextmenu', (e) => { if (Date.now() - lastTouch < 1500 || (active && active.host === host)) e.preventDefault(); });
  card.addEventListener('click', () => { clearTimeout(hoverT); clearTimeout(holdT); if (active && active.host === host) stopActive(); });

  // Scroll-driven (only acts on devices without a hover-capable mouse).
  if (!hoverCapable()) {
    host.__pv = v;
    ensureScroll();
    if (io) io.observe(host);
  }
  return card;
}

export function stopAllPreviews() { stopActive(); }
