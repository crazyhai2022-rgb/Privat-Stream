// Thumbnail chooser used by the upload form and by "Change thumbnail" in the studio.
// Two sources: a frame picked from the video, or a custom image that is cropped to the right shape.
// Either way the result is a JPEG Blob already cut to the exact aspect (the server re-checks it).
import { h, toast, fmtDur } from './util.js';
import { openCropper } from './cropper.js';
import { state } from './api.js';

export const THUMB = {
  short: { w: 720, h: 1280, aspect: 9 / 16, label: '9:16 portrait', rec: '720 × 1280' },
  long: { w: 1280, h: 720, aspect: 16 / 9, label: '16:9 landscape', rec: '1280 × 720' },
};

/**
 * @param kind 'short' | 'long'
 * @param onChange called whenever the chosen thumbnail changes
 */
export function thumbnailPicker({ kind, onChange = () => {}, initial = null }) {
  const spec = THUMB[kind];
  const lim = state.config?.upload || { thumbnail_max_mb: 5 };
  const maxBytes = lim.thumbnail_max_mb * 1048576;
  let mode = 'frame';                 // 'frame' | 'custom'
  let result = initial;               // { blob, url, source: 'frame'|'custom', label }
  let videoUrl = null, duration = 0, videoOk = false;

  const previewBox = h('div', { class: `thumb-preview ${kind}`, 'aria-live': 'polite' });
  const previewNote = h('div', { class: 'muted small', style: 'margin-top:6px' });
  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const setErr = (m) => { err.textContent = m || ''; err.hidden = !m; };

  function showResult() {
    previewBox.replaceChildren(result ? h('img', { src: result.url, alt: 'Selected thumbnail' }) : h('div', { class: 'ph' }, 'No thumbnail yet'));
    previewNote.textContent = result ? result.label : 'Pick a frame or upload an image.';
  }
  function choose(blob, source, label) {
    if (result?.url) URL.revokeObjectURL(result.url);
    result = blob ? { blob, url: URL.createObjectURL(blob), source, label } : null;
    showResult(); onChange(result);
  }

  // ---- From video ----
  const video = h('video', { class: 'thumb-video', muted: true, playsinline: true, preload: 'auto', crossorigin: 'anonymous', 'aria-label': 'Video frame preview' });
  const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '0', class: 'thumb-seek', 'aria-label': 'Choose a moment in the video', disabled: true });
  const timeLabel = h('span', { class: 'muted small' }, '0:00');
  const frameMsg = h('div', { class: 'hint' }, 'Choose a video first to pick a frame from it.');
  const nudge = (d) => h('button', { type: 'button', class: 'btn sm', 'aria-label': d < 0 ? 'Back a little' : 'Forward a little', onclick: () => { slider.value = String(Math.min(duration, Math.max(0, Number(slider.value) + d))); seek(); } }, d < 0 ? '◀ 0.2s' : '0.2s ▶');
  const useFrame = h('button', { type: 'button', class: 'btn sm primary', disabled: true, onclick: () => capture() }, 'Use this frame');
  let seekT;
  function seek() { timeLabel.textContent = fmtDur(Number(slider.value)); clearTimeout(seekT); seekT = setTimeout(() => { try { video.currentTime = Number(slider.value); } catch { /* not ready */ } }, 40); }
  slider.addEventListener('input', seek);

  async function capture(auto = false) {
    if (!videoOk) return;
    setErr('');
    try {
      await new Promise((res) => { if (!video.seeking) res(); else video.addEventListener('seeked', res, { once: true }); });
      const c = document.createElement('canvas'); c.width = spec.w; c.height = spec.h;
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      const vw = video.videoWidth, vh = video.videoHeight;
      const k = Math.max(spec.w / vw, spec.h / vh);                       // cover-crop to the target shape
      ctx.drawImage(video, (spec.w - vw * k) / 2, (spec.h - vh * k) / 2, vw * k, vh * k);
      let blob = null;
      for (const q of [0.9, 0.8, 0.7]) { blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); if (!blob || blob.size <= maxBytes) break; }
      if (!blob) throw new Error('no frame');
      choose(blob, 'frame', `Frame at ${fmtDur(video.currentTime)}`);
      if (!auto) toast('Thumbnail set from the video');
    } catch {
      setErr('Could not capture a frame from this video. Try another moment, or upload an image instead.');
    }
  }

  function setVideo(src) {
    videoOk = false; slider.disabled = true; useFrame.disabled = true;
    if (videoUrl && videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
    videoUrl = null;
    if (!src) { frameMsg.textContent = 'Choose a video first to pick a frame from it.'; frameMsg.className = 'hint'; video.removeAttribute('src'); return; }
    videoUrl = typeof src === 'string' ? src : URL.createObjectURL(src);
    frameMsg.textContent = 'Loading preview…'; frameMsg.className = 'hint';
    video.src = videoUrl;
    video.load();
  }
  video.addEventListener('loadedmetadata', () => {
    duration = video.duration || 0;
    slider.max = String(Math.max(0.1, duration));
    const first = Math.min(1, duration / 2);
    slider.value = String(first); timeLabel.textContent = fmtDur(first);
    try { video.currentTime = first; } catch { /* ignore */ }
  });
  video.addEventListener('loadeddata', async () => {
    videoOk = true; slider.disabled = false; useFrame.disabled = false;
    frameMsg.textContent = `Drag the slider to a moment you like, then press “Use this frame”. (${fmtDur(duration)} long)`;
    if (!result) { await capture(true); }       // a sensible default so there is always a thumbnail
  });
  video.addEventListener('seeked', () => { /* preview updates itself */ });
  video.addEventListener('error', () => {
    videoOk = false; slider.disabled = true; useFrame.disabled = true;
    frameMsg.className = 'err';
    frameMsg.textContent = 'Your browser cannot preview this video file, so a frame cannot be picked here. Upload an image instead, or continue and the server will pick one.';
  });

  const framePane = h('div', { class: 'thumb-pane' },
    h('div', { class: `thumb-vwrap ${kind}` }, video),
    h('div', { class: 'row', style: 'gap:8px;margin-top:8px' }, nudge(-0.2), slider, nudge(0.2), timeLabel),
    h('div', { style: 'margin-top:8px' }, useFrame), frameMsg);

  // ---- Custom image ----
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', id: `thumb-file-${kind}`, class: 'thumb-file' });
  let lastFile = null;
  const recompose = h('button', { type: 'button', class: 'btn sm', hidden: true, onclick: () => crop(lastFile) }, 'Adjust crop');
  async function crop(f) {
    setErr('');
    const blob = await openCropper({
      source: f, aspect: spec.aspect, outWidth: spec.w, outHeight: spec.h, title: `Crop thumbnail (${spec.label})`, maxBytes,
      previews: [{ label: kind === 'short' ? 'In Shorts' : 'In feeds', aspect: spec.aspect }],
    });
    if (blob) { choose(blob, 'custom', `Custom image · ${spec.w} × ${spec.h}`); recompose.hidden = false; }
  }
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    setErr('');
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return setErr('Use a JPEG, PNG or WebP image.');
    if (f.size > 20 * 1048576) return setErr('That image is very large. Choose one under 20 MB.');
    lastFile = f;
    await crop(f);
  });
  const customPane = h('div', { class: 'thumb-pane', hidden: true },
    h('label', { class: 'btn', for: file.id }, 'Choose an image'), file, ' ', recompose,
    h('div', { class: 'hint', style: 'margin-top:8px' }, `Recommended ${spec.rec} (${spec.label}). JPEG, PNG or WebP, up to ${lim.thumbnail_max_mb} MB. You can crop, zoom and position it next.`));

  const tabs = h('div', { class: 'tabs', role: 'tablist', style: 'margin:0 0 10px' });
  const setMode = (m) => {
    mode = m; framePane.hidden = m !== 'frame'; customPane.hidden = m !== 'custom';
    tabs.replaceChildren(
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(m === 'frame'), class: m === 'frame' ? 'on' : '', onclick: () => setMode('frame') }, 'From video'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(m === 'custom'), class: m === 'custom' ? 'on' : '', onclick: () => setMode('custom') }, 'Upload image'));
  };
  setMode('frame');
  showResult();

  const el = h('div', { class: 'thumb-picker' }, tabs, h('div', { class: 'thumb-grid' }, h('div', null, framePane, customPane, err), h('div', null, previewBox, previewNote)));
  return {
    el, setVideo,
    get result() { return result; },
    getBlob: () => result?.blob || null,
    get mode() { return mode; },
    destroy() { if (result?.url) URL.revokeObjectURL(result.url); setVideo(null); },
  };
}
