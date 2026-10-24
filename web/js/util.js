// Small DOM + formatting helpers. All user content goes through textContent (never innerHTML).

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Icons (24x24 stroke set) ----------
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  shorts: ['M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z', 'M10.5 9.2l4 2.8-4 2.8z'],
  film: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M10 9.3l5 2.7-5 2.7z'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  bookmark: 'M6 3h12v18l-6-4.2L6 21z',
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5'],
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.3-4.3'],
  menu: 'M3 6h18M3 12h18M3 18h18',
  heart: 'M12 21s-8.5-5.4-8.5-11.2A4.6 4.6 0 0 1 12 7.3a4.6 4.6 0 0 1 8.5 2.5C20.5 15.6 12 21 12 21z',
  dislike: 'M10 15v4a3 3 0 0 0 3 3l4-9V2H5.7a2 2 0 0 0-2 1.7l-1.4 9a2 2 0 0 0 2 2.3zM17 2h2.7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H17',
  comment: 'M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-5.5A8 8 0 1 1 21 12z',
  share: ['M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M8.6 13.5l6.8 4M15.4 6.5l-6.8 4'],
  volume: ['M11 5L6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14'],
  mute: ['M11 5L6 9H2v6h4l5 4z', 'M22 9l-6 6M16 9l6 6'],
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  x: 'M18 6L6 18M6 6l12 12',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  back: 'M19 12H5M12 19l-7-7 7-7',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  check: 'M5 12l5 5 9-10',
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16v-4M12 8h.01'],
  tag: ['M20 12l-8 8-9-9V3h8z', 'M7.5 7.5h.01'],
};
export function icon(name, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `i ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const defs = ICONS[name] || ICONS.info;
  for (const d of [].concat(defs)) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
/**
 * Renders the brand name as a wordmark. A trailing capital letter (the X in "viralX")
 * is drawn in the brand gradient, matching the logo.
 */
export function brandWordmark(name = 'viralX', cls = '') {
  const m = /^(.*\S)([A-Z])$/.exec(String(name || '').trim());
  const wrap = h('span', { class: `wordmark ${cls}`.trim() });
  if (m) wrap.append(m[1], h('span', { class: 'wm-x' }, m[2]));
  else wrap.append(String(name || ''));
  return wrap;
}

// ---------- Formatting ----------
export function fmtCount(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
}
export function fmtDur(s) {
  if (s === null || s === undefined || isNaN(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function timeAgo(d) {
  if (!d) return '';
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  const u = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [n, sec] of u) if (s >= sec) { const v = Math.floor(s / sec); return `${v} ${n}${v > 1 ? 's' : ''} ago`; }
  return 'just now';
}
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const initials = (s) => (s || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const statusLabel = (s) => ({
  draft: 'Draft', uploading: 'Uploading', processing: 'Processing', pending_moderation: 'Pending moderation', published: 'Published',
  rejected: 'Rejected', removed: 'Removed', pending: 'Pending Review', approved: 'Approved', suspended: 'Suspended',
  open: 'Open', investigating: 'Investigating', dismissed: 'Dismissed', actioned: 'Actioned', active: 'Active',
}[s] || s);
export const statusPill = (s) => h('span', { class: `status ${s}` }, statusLabel(s));

// ---------- Toast & dialogs ----------
let toastWrap;
export function toast(msg, kind = '') {
  toastWrap ||= document.body.appendChild(h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast ${kind}` }, msg);
  toastWrap.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function openModal(build) {
  const wrap = h('div', { class: 'modal-wrap', role: 'dialog', 'aria-modal': 'true' });
  const box = h('div', { class: 'modal' });
  wrap.append(box);
  const prev = document.activeElement;
  const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); resolve?.(v); };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
  document.addEventListener('keydown', onKey);
  build(box, close);
  document.body.append(wrap);
  box.querySelector('input,textarea,select,button')?.focus();
  return p;
}

export function confirmDialog({ title, text, confirmText = 'Confirm', danger = false, ask }) {
  return openModal((box, close) => {
    const input = ask ? h(ask.multiline ? 'textarea' : 'input', { class: ask.multiline ? 'textarea' : 'input', placeholder: ask.placeholder || '', maxlength: 1000 }) : null;
    const errEl = h('div', { class: 'err', hidden: true });
    box.append(h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null,
      ask ? h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, ask.label || ''), input) : null, errEl,
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => {
          if (ask) {
            const val = input.value.trim();
            if (ask.required && val.length < (ask.min || 1)) { errEl.textContent = ask.requiredMessage || 'This field is required'; errEl.hidden = false; return; }
            close(val || true);
          } else close(true);
        } }, confirmText)));
  });
}

export function setTitle(t) { document.title = t ? `${t} · ${window.__brand || 'viralX'}` : (window.__brand || 'viralX'); }
export const qs = (obj) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
