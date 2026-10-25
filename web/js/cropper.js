// Interactive image cropper: drag to position, wheel / slider / pinch to zoom, live previews.
// Resolves with a JPEG Blob at exactly outWidth × outHeight, or null when cancelled.
//
//   openCropper({ source, aspect: 9/16, outWidth: 720, outHeight: 1280, title: 'Crop thumbnail',
//                 round: false, safe: { x, y, w, h } (fractions of the frame), previews: [{ label, aspect }] })
import { h, openModal, toast } from './util.js';

const MAX_ZOOM = 4;

async function loadImage(source) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try { await img.decode(); } catch { throw new Error('That image could not be opened. Try a JPEG, PNG or WebP file.'); }
  return { img, revoke: () => { if (typeof source !== 'string') URL.revokeObjectURL(url); } };
}

export function openCropper(opts) {
  const { source, aspect, outWidth, outHeight, title = 'Crop image', round = false, safe = null, previews = [], maxBytes = 0 } = opts;
  return openModal((box, close) => {
    box.classList.add('crop-modal');
    let loaded = null, img = null, zoom = 1, ox = 0, oy = 0, minScale = 1;
    const status = h('div', { class: 'muted small', role: 'status' }, 'Loading image…');
    const stage = h('div', { class: `crop-stage${round ? ' round' : ''}`, style: `aspect-ratio:${aspect};width:min(100%, calc(62vh * ${aspect}))`, tabindex: '0', 'aria-label': 'Drag to reposition. Use the arrow keys to nudge and plus or minus to zoom.' });
    const canvas = h('canvas', { class: 'crop-canvas' });
    stage.append(canvas);
    if (safe) stage.append(h('div', { class: 'crop-safe', style: `left:${safe.x * 100}%;top:${safe.y * 100}%;width:${safe.w * 100}%;height:${safe.h * 100}%` }, h('span', null, 'Safe area')));
    const slider = h('input', { type: 'range', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', 'aria-label': 'Zoom', class: 'crop-zoom' });
    const warn = h('div', { class: 'hint', hidden: true });
    const prevRow = h('div', { class: 'crop-previews' });
    const prevCanvases = previews.map((p) => {
      const c = h('canvas', { class: 'crop-prev', style: `aspect-ratio:${p.aspect}` });
      prevRow.append(h('figure', null, c, h('figcaption', { class: 'muted small' }, p.label)));
      return { c, aspect: p.aspect };
    });

    // Geometry: the image is drawn at `scale` image-px per output-px, so output math stays exact.
    const view = () => { const w = canvas.clientWidth || 300; return { w, h: w / aspect }; };
    const scaleNow = () => minScale * zoom;
    function clamp() {
      const v = view(), s = scaleNow();
      const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
      ox = Math.min(0, Math.max(v.w - iw, ox));
      oy = Math.min(0, Math.max(v.h - ih, oy));
    }
    function fit() {
      const v = view();
      minScale = Math.max(v.w / img.naturalWidth, v.h / img.naturalHeight);
      const s = scaleNow();
      ox = (v.w - img.naturalWidth * s) / 2; oy = (v.h - img.naturalHeight * s) / 2;
      clamp();
    }
    function draw() {
      if (!img) return;
      const v = view(), dpr = Math.min(2, window.devicePixelRatio || 1), s = scaleNow();
      canvas.width = Math.round(v.w * dpr); canvas.height = Math.round(v.h * dpr);
      canvas.style.height = `${v.h}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, v.w, v.h);
      ctx.drawImage(img, ox, oy, img.naturalWidth * s, img.naturalHeight * s);
      for (const p of prevCanvases) {
        // Centre-crop the current framing to the preview's shape, like the site does with object-fit: cover.
        const pw = Math.min(360, p.c.parentElement.clientWidth || 160), ph = pw / p.aspect;
        p.c.width = Math.round(pw * 2); p.c.height = Math.round(ph * 2); p.c.style.width = `${pw}px`;
        const pc = p.c.getContext('2d');
        let sw = v.w, sh = v.w / p.aspect;
        if (sh > v.h) { sh = v.h; sw = v.h * p.aspect; }
        const sx = (v.w - sw) / 2, sy = (v.h - sh) / 2;
        pc.drawImage(canvas, sx * dpr, sy * dpr, sw * dpr, sh * dpr, 0, 0, p.c.width, p.c.height);
      }
    }
    function setZoom(z, cx, cy) {
      const v = view();
      cx ??= v.w / 2; cy ??= v.h / 2;
      const old = scaleNow();
      zoom = Math.min(MAX_ZOOM, Math.max(1, z));
      const k = scaleNow() / old;
      ox = cx - (cx - ox) * k; oy = cy - (cy - oy) * k;
      clamp(); slider.value = String(zoom); draw();
    }

    // Pointer input: one finger drags, two fingers pinch.
    const pts = new Map();
    let pinch = 0;
    stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) pinch = dist(); });
    stage.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId); if (!p || !img) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const d = dist(); if (pinch) { const r = stage.getBoundingClientRect(); const [a, b] = [...pts.values()]; setZoom(zoom * (d / pinch), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); } pinch = d;
      } else { ox += dx; oy += dy; clamp(); draw(); }
    });
    const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 30 : 10;
      const k = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (k) { e.preventDefault(); ox += k[0]; oy += k[1]; clamp(); draw(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 1.1); }
      else if (e.key === '-') { e.preventDefault(); setZoom(zoom / 1.1); }
    });
    slider.addEventListener('input', () => setZoom(Number(slider.value)));

    async function render(quality) {
      const out = document.createElement('canvas'); out.width = outWidth; out.height = outHeight;
      const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      const v = view(), k = outWidth / v.w, s = scaleNow() * k;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, outWidth, outHeight);
      ctx.drawImage(img, ox * k, oy * k, img.naturalWidth * s, img.naturalHeight * s);
      return new Promise((res) => out.toBlob(res, 'image/jpeg', quality));
    }
    const apply = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: async () => {
      apply.disabled = true;
      let blob = null;
      for (const q of [0.92, 0.85, 0.75, 0.65]) { blob = await render(q); if (!blob || !maxBytes || blob.size <= maxBytes) break; }
      if (!blob) { toast('Could not create the image. Try again.', 'bad'); apply.disabled = false; return; }
      if (maxBytes && blob.size > maxBytes) { toast(`The cropped image is still over ${(maxBytes / 1048576).toFixed(1)} MB. Try a smaller image.`, 'bad'); apply.disabled = false; return; }
      loaded?.revoke(); close(blob);
    } }, 'Use this crop');
    const reset = h('button', { class: 'btn', type: 'button', onclick: () => { zoom = 1; slider.value = '1'; fit(); draw(); } }, 'Reset');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { loaded?.revoke(); close(null); } }, 'Cancel');

    box.append(h('h3', null, title),
      h('p', { class: 'muted small', style: 'margin-bottom:10px' }, `Output ${outWidth} × ${outHeight}. Drag to position, pinch or scroll to zoom.`),
      stage, h('div', { class: 'crop-controls' }, h('span', { class: 'muted small' }, 'Zoom'), slider, reset), warn,
      prevCanvases.length ? h('div', { class: 'crop-prev-wrap' }, h('div', { class: 'small', style: 'font-weight:600;margin:8px 0 4px' }, 'Preview'), prevRow) : null,
      status, h('div', { class: 'btns' }, cancel, apply));

    loadImage(source).then((l) => {
      loaded = l; img = l.img; status.hidden = true;
      requestAnimationFrame(() => {
        fit(); draw(); apply.disabled = false; stage.focus({ preventScroll: true });
        const small = img.naturalWidth < outWidth * 0.75 || img.naturalHeight < outHeight * 0.75;
        const off = Math.abs(img.naturalWidth / img.naturalHeight - aspect) / aspect > 0.08;
        const msgs = [];
        if (off) msgs.push('This image is not the recommended shape, so part of it will be cropped. Drag and zoom to choose what stays.');
        if (small) msgs.push(`This image is smaller than ${outWidth} × ${outHeight}, so it may look soft.`);
        if (msgs.length) { warn.textContent = msgs.join(' '); warn.hidden = false; }
      });
      window.addEventListener('resize', () => { if (img) { fit(); draw(); } });
    }).catch((e) => { status.textContent = e.message; status.className = 'err'; });
  });
}
