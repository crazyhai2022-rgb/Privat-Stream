import { h, icon, setTitle, toast, fmtDur, sleep } from '../util.js';
import { api, upload, state, refreshMe } from '../api.js';
import { navigate } from '../router.js';
import { emptyState } from '../cards.js';

function gate(root) {
  if (!state.user) { navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true }); return false; }
  if (state.canUpload) return true;
  const ch = state.channel;
  let text, action;
  if (state.config?.email_verification_required && !state.user.email_verified) { text = 'Verify your email address before uploading.'; action = h('a', { class: 'btn primary', href: '/studio' }, 'Go to studio'); }
  else if (!ch) { text = 'Create your channel first. After that, an administrator reviews your creator application.'; action = h('a', { class: 'btn primary', href: '/channel/setup' }, 'Set up channel'); }
  else if (ch.status === 'pending') { text = 'Your creator account is Pending Review. You can upload as soon as it is approved.'; action = h('a', { class: 'btn primary', href: '/studio' }, 'View status'); }
  else if (ch.status === 'rejected') { text = `Your creator application was rejected${ch.status_reason ? `: ${ch.status_reason}` : '.'}`; action = h('a', { class: 'btn primary', href: '/studio/channel' }, 'Edit & resubmit'); }
  else { text = `Your channel is ${ch.status}. Uploads are disabled.`; action = h('a', { class: 'btn', href: '/studio' }, 'Studio'); }
  root.append(h('div', { class: 'page narrow' }, emptyState('Uploads are not available yet', text, h('div', { style: 'margin-top:14px' }, action))));
  return false;
}

export default async function chooser({ root }) {
  setTitle('Upload');
  if (state.user) await refreshMe();
  if (!gate(root)) return;
  root.append(h('div', { class: 'page narrow' }, h('h1', { class: 'title', style: 'margin-bottom:14px' }, 'Upload'),
    h('div', { class: 'opt-grid' },
      h('a', { class: 'opt', href: '/upload/short' }, icon('shorts'), h('h3', null, 'Upload Short Video'), h('p', { class: 'muted' }, `Vertical 9:16, up to ${state.config.upload.short_max_seconds}s.`)),
      h('a', { class: 'opt', href: '/upload/long' }, icon('film'), h('h3', null, 'Upload Long Video'), h('p', { class: 'muted' }, `Landscape 16:9, up to ${Math.round(state.config.upload.long_max_seconds / 60)} min.`)))));
}
export const short = (ctx) => form(ctx, 'short');
export const long = (ctx) => form(ctx, 'long');

async function form({ root, query }, kind) {
  const isShort = kind === 'short';
  setTitle(isShort ? 'Upload Short' : 'Upload long video');
  if (state.user) await refreshMe();
  if (!gate(root)) return;
  const lim = state.config.upload;
  const maxMb = isShort ? lim.short_max_mb : lim.long_max_mb;
  const maxSec = isShort ? lim.short_max_seconds : lim.long_max_seconds;
  let draftId = query.get('draft') || null;
  let file = null, thumb = null, busy = false;

  const fileInput = h('input', { type: 'file', accept: lim.allowed_formats.map((f) => `.${f}`).join(',') + ',video/*', hidden: true, id: 'vfile' });
  const dropText = h('div', null, h('b', null, 'Choose a video file'), h('div', { class: 'muted small' }, `or drag it here · ${lim.allowed_formats.join(', ').toUpperCase()} · up to ${maxMb} MB · up to ${isShort ? maxSec + ' seconds' : fmtDur(maxSec)}`));
  const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Choose a video file', onclick: () => fileInput.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } }, icon('upload'), dropText);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));
  fileInput.addEventListener('change', () => pick(fileInput.files[0]));
  const fileErr = h('div', { class: 'err', hidden: true });

  async function pick(f) {
    fileErr.hidden = true; file = null;
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!lim.allowed_formats.includes(ext)) return showFileErr(`.${ext} files are not allowed. Allowed: ${lim.allowed_formats.join(', ')}.`);
    if (f.size > maxMb * 1048576) return showFileErr(`That file is ${(f.size / 1048576).toFixed(0)} MB. The limit is ${maxMb} MB.`);
    const url = URL.createObjectURL(f);
    const v = document.createElement('video'); v.preload = 'metadata'; v.src = url;
    const meta = await new Promise((res) => { v.onloadedmetadata = () => res({ d: v.duration, w: v.videoWidth, h: v.videoHeight }); v.onerror = () => res(null); setTimeout(() => res(null), 4000); });
    URL.revokeObjectURL(url);
    if (meta && meta.d > maxSec + 0.5) return showFileErr(`This video is ${fmtDur(meta.d)} long. The limit is ${isShort ? maxSec + ' seconds' : fmtDur(maxSec)}.`);
    file = f;
    dropText.replaceChildren(h('b', null, f.name), h('div', { class: 'muted small' }, `${(f.size / 1048576).toFixed(1)} MB${meta ? ` · ${fmtDur(meta.d)} · ${meta.w}×${meta.h}` : ''}`));
    if (meta && isShort && meta.w > meta.h) fileErr.replaceChildren(h('span', { class: 'muted' }, 'Tip: Shorts look best in portrait 9:16.')), fileErr.hidden = false, fileErr.className = 'hint';
    if (meta && !isShort && meta.h > meta.w) fileErr.replaceChildren(h('span', { class: 'muted' }, 'Tip: long videos look best in landscape 16:9.')), fileErr.hidden = false, fileErr.className = 'hint';
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100);
  }
  function showFileErr(m) { fileErr.className = 'err'; fileErr.textContent = m; fileErr.hidden = false; }

  const title = h('input', { class: 'input', id: 'vtitle', maxlength: 100, required: true });
  const desc = h('textarea', { class: 'textarea', id: 'vdesc', maxlength: isShort ? 500 : 5000, placeholder: isShort ? 'Write a caption…' : 'Describe your video…' });
  const cat = h('select', { class: 'select', id: 'vcat' }, h('option', { value: '' }, 'Choose a category'), (state.config.categories || []).map((c) => h('option', { value: c.id }, c.name)));
  const tags = h('input', { class: 'input', id: 'vtags', placeholder: 'comma separated (optional)' });
  const thumbInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', id: 'vthumb' });
  thumbInput.addEventListener('change', () => { thumb = thumbInput.files[0] || null; if (thumb && thumb.size > lim.thumbnail_max_mb * 1048576) { toast(`Thumbnail must be under ${lim.thumbnail_max_mb} MB`, 'bad'); thumb = null; thumbInput.value = ''; } });

  const bar = h('i'); const progress = h('div', { class: 'progress', hidden: true, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar);
  const statusLine = h('div', { class: 'muted', hidden: true, role: 'status' });
  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit', style: 'height:42px' }, 'Upload');
  const cancel = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => upload.current?.abort() }, 'Cancel upload');
  const done = h('div');

  const f = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const frm = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (busy) return;
    err.hidden = true;
    if (!file) return showFail('Choose a video file first.');
    if (title.value.trim().length < 2) return showFail('Add a title.');
    busy = true; submit.disabled = true; cancel.hidden = false; progress.hidden = false; statusLine.hidden = false; bar.style.width = '0%';
    try {
      if (!draftId) {
        statusLine.textContent = 'Saving details…';
        const r = await api.post('/api/videos', { kind, title: title.value, description: desc.value, category_id: cat.value || null, tags: tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) });
        draftId = r.video.id;
      }
      const fd = new FormData(); fd.append('video', file); if (thumb) fd.append('thumbnail', thumb);
      statusLine.textContent = 'Uploading… 0%';
      await upload(`/api/videos/${draftId}/upload`, fd, { onProgress: (p) => { bar.style.width = `${Math.round(p * 100)}%`; progress.setAttribute('aria-valuenow', String(Math.round(p * 100))); statusLine.textContent = `Uploading… ${Math.round(p * 100)}%`; } });
      cancel.hidden = true;
      bar.style.width = '100%';
      statusLine.textContent = 'Upload complete. Processing your video…';
      await poll();
    } catch (er) { showFail(er.message || 'Upload failed'); }
    busy = false; submit.disabled = false; cancel.hidden = true;
  } });

  function showFail(m) {
    err.textContent = m; err.hidden = false; progress.hidden = true; statusLine.hidden = true; submit.textContent = 'Try again'; submit.disabled = false; busy = false;
  }
  async function poll() {
    for (let i = 0; i < 600; i++) {
      const s = await api.get(`/api/videos/${draftId}/status`);
      if (s.status === 'processing' || s.status === 'uploading') { statusLine.textContent = 'Processing: generating thumbnail and streaming version…'; await sleep(1500); continue; }
      progress.hidden = true; statusLine.hidden = true;
      if (s.status === 'draft') {
        showFail(s.error_message || 'Processing failed.');
        if (s.job) done.replaceChildren(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await api.post(`/api/videos/${draftId}/retry`); err.hidden = true; progress.hidden = false; statusLine.hidden = false; await poll(); } catch (e) { showFail(e.message); } } }, icon('refresh'), 'Retry processing'));
        return;
      }
      const published = s.status === 'published';
      frm.replaceChildren(h('h2', { class: 'sec' }, published ? 'Your video is live' : 'Submitted for review'),
        h('p', { class: 'muted', style: 'margin:6px 0 14px' }, published ? 'It is now published on your channel.' : 'It is processed and waiting for moderator approval. You will see its status in your studio.'),
        h('div', { class: 'row wrap' }, h('a', { class: 'btn primary', href: '/studio' }, 'Go to studio'), h('a', { class: 'btn', href: `/upload/${kind}`, onclick: () => setTimeout(() => location.reload(), 0) }, 'Upload another')));
      return;
    }
    showFail('Processing is taking longer than expected. Check your studio for status.');
  }

  frm.append(
    fileInput, f(isShort ? 'Short video' : 'Video file', drop), fileErr,
    f('Title', title), f(isShort ? 'Caption' : 'Description', desc), f('Category', cat),
    isShort ? null : f('Tags (optional)', tags, 'Helps people find your video.'),
    isShort ? null : f('Custom thumbnail', thumbInput, `Optional. JPEG, PNG or WebP up to ${lim.thumbnail_max_mb} MB. We generate one if you skip this.`),
    progress, statusLine, err, done, h('div', { class: 'row' }, submit, cancel, h('a', { class: 'btn', href: '/upload' }, 'Back')));
  root.append(h('div', { class: 'page narrow' }, h('h1', { class: 'title', style: 'margin-bottom:6px' }, isShort ? 'Upload Short Video' : 'Upload Long Video'),
    h('p', { class: 'muted', style: 'margin-bottom:14px' }, 'New uploads are reviewed before they go live.'), frm));
  if (draftId) frm.prepend(h('div', { class: 'notice', style: 'margin-bottom:12px' }, 'Adding a file to an existing draft. Your saved title and details will be kept.'));
  void tags;
}
