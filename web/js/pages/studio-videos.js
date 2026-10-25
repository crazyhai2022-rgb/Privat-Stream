import { h, icon, setTitle, toast, fmtCount, fmtDur, timeAgo, statusPill, confirmDialog, openModal } from '../util.js';
import { api, state, refreshMe, upload } from '../api.js';
import { navigate } from '../router.js';
import { emptyState } from '../cards.js';
import { thumbnailPicker } from '../thumbnailPicker.js';
import { studioTabs } from '../creatorNav.js';

const STATUS_HELP = {
  pending: 'Your creator application is Pending Review. An administrator will approve or reject it. You cannot upload until it is approved.',
  approved: 'Your channel is Approved. You can upload Shorts and long videos.',
  rejected: 'Your creator application was Rejected. You can update your channel details and resubmit.',
  suspended: 'Your channel is Suspended. Uploads are disabled.',
};

export default async function studio({ root }) {
  setTitle('Videos · Creator studio');
  if (!state.user) { navigate('/login?next=/studio/videos', { replace: true }); return; }
  await refreshMe();
  const page = h('div', { class: 'page' });
  root.append(page);
  page.append(h('h1', { class: 'title', style: 'margin-bottom:12px' }, 'Creator studio'));

  if (state.config?.email_verification_required && !state.user.email_verified) {
    page.append(h('div', { class: 'notice warn' }, h('b', null, 'Verify your email address. '), `We sent a link to ${state.user.email}.`,
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api.post('/api/auth/resend-verification'); toast('Verification email sent'); } catch (er) { toast(er.message, 'bad'); } e.target.disabled = false; } }, 'Resend email'))));
    return;
  }
  if (!state.channel) {
    page.append(emptyState('Create your channel', 'Set up your creator channel to start the approval process.', h('a', { class: 'btn primary', href: '/channel/setup', style: 'margin-top:12px' }, 'Set up channel')));
    return;
  }
  const ch = state.channel;
  if (ch.status === 'approved') page.append(studioTabs('videos'));
  else page.append(h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, 'Your channel must be approved before you can upload. ', h('a', { href: '/studio' }, 'See status')));

  page.append(h('div', { class: 'row wrap', style: 'justify-content:space-between;margin-bottom:12px' },
    h('h2', { class: 'sec', style: 'margin:0' }, 'Your videos'),
    ch.status === 'approved' ? h('a', { class: 'btn primary sm', href: '/upload' }, icon('upload'), 'Upload') : null));
  const filters = h('div', { class: 'chips', style: 'margin-bottom:12px', role: 'tablist', 'aria-label': 'Filter videos' });
  page.append(filters);
  const list = h('div');
  page.append(list);

  let timer = null, destroyed = false, all = [], filter = 'all';
  const FILTERS = [['all', 'All', () => true], ['public', 'Published', (x) => x.status === 'published' && x.visibility === 'public'],
    ['unlisted', 'Unlisted', (x) => x.visibility === 'unlisted'], ['private', 'Private', (x) => x.visibility === 'private'],
    ['other', 'Processing / review', (x) => ['draft', 'uploading', 'processing', 'pending_moderation', 'rejected'].includes(x.status)]];
  function paintFilters() {
    filters.replaceChildren(...FILTERS.map(([k, label, fn]) => h('button', { class: `chip btn sm ${k === filter ? 'on' : ''}`, type: 'button', 'aria-pressed': k === filter ? 'true' : 'false',
      onclick: () => { filter = k; paintFilters(); render(); } }, `${label} (${all.filter(fn).length})`)));
  }
  function render() {
    const fn = FILTERS.find((f) => f[0] === filter)[2];
    const shown = all.filter(fn);
    if (!all.length) {
      list.replaceChildren(emptyState('No videos yet', ch.status === 'approved' ? 'Upload your first Short or long video.' : 'Videos you upload after approval will appear here.',
        ch.status === 'approved' ? h('a', { class: 'btn primary', href: '/upload', style: 'margin-top:12px' }, 'Upload') : null));
    } else if (!shown.length) list.replaceChildren(h('p', { class: 'muted' }, 'No videos in this view.'));
    else list.replaceChildren(...shown.map(row));
  }
  async function loadVideos() {
    let items;
    try { items = (await api.get('/api/me/videos')).items; all = items; } catch (e) { list.replaceChildren(h('p', { class: 'err' }, e.message)); return; }
    if (destroyed) return;
    paintFilters(); render();
    backfillDurations(items);
    clearTimeout(timer);
    if (items.some((v) => ['uploading', 'processing'].includes(v.status))) timer = setTimeout(loadVideos, 3000);
  }

  function row(v) {
    const href = v.status === 'published' || v.status === 'pending_moderation' ? (v.kind === 'short' ? `/shorts/${v.id}` : `/watch/${v.id}`) : null;
    const thumb = v.thumbnail_url ? h('img', { class: v.kind === 'short' ? 'thumb-s' : 'thumb-l', src: v.thumbnail_url, alt: '', loading: 'lazy' }) : h('div', { class: `${v.kind === 'short' ? 'thumb-s' : 'thumb-l'} ph` }, v.status === 'processing' ? '…' : '');
    return h('div', { class: 'vitem' }, thumb,
      h('div', { class: 'grow' },
        h('div', { class: 'row wrap' }, href ? h('a', { href, style: 'font-weight:700' }, v.title) : h('b', null, v.title), statusPill(v.status), h('span', { class: 'chip' }, v.kind === 'short' ? 'Short' : 'Long'), v.visibility !== 'public' ? h('span', { class: 'chip vis' }, v.visibility === 'private' ? 'Private' : 'Unlisted') : null),
        v.status === 'rejected' && v.rejected_reason ? h('div', { class: 'err' }, `Rejected: ${v.rejected_reason}`) : null,
        v.status === 'draft' && v.error_message ? h('div', { class: 'err' }, v.error_message) : null,
        v.status === 'pending_moderation' ? h('div', { class: 'muted small' }, 'Waiting for moderator approval.') : null,
        h('div', { class: 'mets', style: 'margin-top:6px' },
          ['views', 'unique_views', 'hearts', 'dislikes', 'comments', 'shares', 'saves'].map((k) => h('span', null, h('b', null, fmtCount(v.metrics[k] ?? 0)), ' ', k.replace('_', ' ')))),
        h('div', { class: 'muted small', style: 'margin-top:4px' }, `Created ${timeAgo(v.created_at)}${v.duration ? ' · ' + fmtDur(v.duration) : ''}`),
        h('div', { class: 'row wrap', style: 'margin-top:8px' },
          visibilitySelect(v),
          h('button', { class: 'btn sm', onclick: () => edit(v) }, icon('edit'), 'Edit'),
          v.playable !== false && v.status !== 'draft' && v.status !== 'removed' ? h('button', { class: 'btn sm', onclick: () => changeThumb(v) }, icon('film'), 'Thumbnail') : null,
          v.status === 'draft' ? h('a', { class: 'btn sm', href: `/upload/${v.kind}?draft=${v.id}` }, icon('upload'), 'Upload file') : null,
          v.status === 'draft' && v.error_message ? h('button', { class: 'btn sm', onclick: () => retry(v) }, icon('refresh'), 'Retry processing') : null,
          h('button', { class: 'btn sm danger', onclick: () => remove(v) }, icon('trash'), 'Delete'))));
  }

  // Older uploads (made on a server without ffprobe) have no length; read it from the file in the browser and save it once.
  const probed = new Set();
  function backfillDurations(items) {
    for (const v of items) {
      if (v.duration || !v.stream_url || v.playable === false || probed.has(v.id) || ['draft', 'uploading', 'processing', 'removed'].includes(v.status)) continue;
      probed.add(v.id);
      const el = document.createElement('video'); el.preload = 'metadata'; el.muted = true;
      const done = () => { el.removeAttribute('src'); el.load(); };
      el.onloadedmetadata = async () => {
        const d = el.duration; done();
        if (!(d > 0.5) || !isFinite(d) || destroyed) return;
        try { await api.patch(`/api/videos/${v.id}/duration`, { seconds: d }); loadVideos(); } catch { /* ignore */ }
      };
      el.onerror = done;
      el.src = v.stream_url;
    }
  }

  function visibilitySelect(v) {
    const sel = h('select', { class: 'select vis-select', 'aria-label': `Visibility of ${v.title}`, title: 'Who can watch this video',
      onchange: async () => {
        const next = sel.value; sel.disabled = true;
        try {
          await api.patch(`/api/videos/${v.id}/visibility`, { visibility: next });
          toast(next === 'public' ? 'Published — everyone can find it' : next === 'unlisted' ? 'Unlisted — only people with the link' : 'Private — only you can watch it');
          await loadVideos();
        } catch (e) { toast(e.message, 'bad'); sel.value = v.visibility || 'public'; sel.disabled = false; }
      } },
      h('option', { value: 'public' }, 'Published'), h('option', { value: 'unlisted' }, 'Unlisted'), h('option', { value: 'private' }, 'Private'));
    sel.value = v.visibility || 'public';
    return sel;
  }

  function changeThumb(v) {
    openModal((box, close) => {
      box.classList.add('thumb-modal');
      const picker = thumbnailPicker({ kind: v.kind });
      picker.setVideo(v.stream_url || null);
      const err = h('div', { class: 'err', hidden: true });
      const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        const blob = picker.getBlob();
        if (!blob) { err.textContent = 'Pick a frame or upload an image first.'; err.hidden = false; return; }
        save.disabled = true; err.hidden = true;
        try {
          const fd = new FormData(); fd.append('thumbnail', blob, 'thumbnail.jpg');
          await upload(`/api/videos/${v.id}/thumbnail`, fd);
          toast('Thumbnail updated'); picker.destroy(); close(true); loadVideos();
        } catch (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; }
      } }, 'Save thumbnail');
      box.append(h('h3', null, 'Change thumbnail'), picker.el, err,
        h('div', { class: 'btns' }, h('button', { class: 'btn', type: 'button', onclick: () => { picker.destroy(); close(null); } }, 'Cancel'), save));
    });
  }
  async function retry(v) {
    try { await api.post(`/api/videos/${v.id}/retry`); toast('Processing restarted'); loadVideos(); } catch (e) { toast(e.message, 'bad'); }
  }
  async function remove(v) {
    const ok = await confirmDialog({ title: 'Delete this video?', text: `“${v.title}” will be removed from the platform.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api.del(`/api/videos/${v.id}`); toast('Video deleted'); loadVideos(); } catch (e) { toast(e.message, 'bad'); }
  }
  function edit(v) {
    openModal((box, close) => {
      const title = h('input', { class: 'input', value: v.title, maxlength: 100 });
      const desc = h('textarea', { class: 'textarea', maxlength: 5000 }); desc.value = v.description || '';
      const cat = h('select', { class: 'select' }, h('option', { value: '' }, 'No category'), (state.config.categories || []).map((c) => h('option', { value: c.id, selected: v.category?.slug === c.slug }, c.name)));
      const tags = h('input', { class: 'input', value: (v.tags || []).join(', '), placeholder: 'comma separated' });
      const err = h('div', { class: 'err', hidden: true });
      box.append(h('h3', null, 'Edit video'),
        h('div', { class: 'field' }, h('label', null, 'Title'), title),
        h('div', { class: 'field' }, h('label', null, v.kind === 'short' ? 'Caption' : 'Description'), desc),
        h('div', { class: 'field' }, h('label', null, 'Category'), cat),
        h('div', { class: 'field' }, h('label', null, 'Tags'), tags), err,
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api.patch(`/api/videos/${v.id}`, { title: title.value, description: desc.value, category_id: cat.value || null, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) });
              close(); toast('Saved'); loadVideos();
            } catch (er) { err.textContent = er.message; err.hidden = false; e.target.disabled = false; }
          } }, 'Save')));
    });
  }

 
  await loadVideos();
  return { destroy() { destroyed = true; clearTimeout(timer); } };
}
