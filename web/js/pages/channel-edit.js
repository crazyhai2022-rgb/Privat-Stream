import { h, icon, setTitle, toast, statusPill } from '../util.js';
import { api, upload, state, applyMe } from '../api.js';
import { navigate } from '../router.js';
import { avatarEl } from '../cards.js';
import { openCropper } from '../cropper.js';

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

export default async function channelEdit({ root }) {
  if (!state.user) { navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return; }
  const editing = !!state.channel;
  setTitle(editing ? 'Edit channel' : 'Set up your channel');
  if (state.config?.email_verification_required && !state.user.email_verified) {
    root.append(h('div', { class: 'page narrow' }, h('div', { class: 'notice warn' }, h('b', null, 'Verify your email first. '), 'We sent a link to ', state.user.email, '. You can create your channel right after confirming it.',
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api.post('/api/auth/resend-verification'); toast('Verification email sent'); } catch (er) { toast(er.message, 'bad'); } e.target.disabled = false; } }, 'Resend email')))));
    return;
  }
  let existing = null;
  if (editing) { try { existing = (await api.get('/api/me/channel/details')).channel; } catch { /* fall back to summary */ } }
  const c = existing || state.channel || {};
  const selected = new Set((c.categories || []).map((x) => x.id));

  const name = h('input', { class: 'input', id: 'cname', value: c.name || '', maxlength: 50, required: true });
  const handle = h('input', { class: 'input', id: 'chandle', value: c.handle || '', maxlength: 30, required: true, autocapitalize: 'none', spellcheck: 'false' });
  let handleTouched = editing;
  handle.addEventListener('input', () => { handleTouched = true; });
  name.addEventListener('input', () => { if (!handleTouched) handle.value = slugify(name.value); });
  const bio = h('textarea', { class: 'textarea', id: 'cbio', maxlength: 500 }); bio.value = c.bio || '';
  const tg = h('input', { class: 'input', id: 'ctg', value: c.telegram_url || '', placeholder: 'https://t.me/yourchannel', maxlength: 300, inputmode: 'url' });
  const tgOn = h('input', { type: 'checkbox', id: 'ctgon' }); tgOn.checked = c.telegram_enabled !== false;
  // Images are cropped here, in the browser, to the exact size the platform stores:
  // avatar 400 x 400, banner 2560 x 1440 with a centred safe area that every device shows.
  const avatar = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', id: 'cavatar' });
  const banner = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', id: 'cbanner' });
  const cropped = { avatar: null, banner: null };
  const BANNER_SAFE = { x: (1 - 1546 / 2560) / 2, y: (1 - 423 / 1440) / 2, w: 1546 / 2560, h: 423 / 1440 };
  const CROPS = {
    avatar: { aspect: 1, outWidth: 400, outHeight: 400, round: true, title: 'Crop profile picture', maxBytes: 2 * 1024 * 1024,
      previews: [{ label: 'Channel page', aspect: 1 }] },
    banner: { aspect: 16 / 9, outWidth: 2560, outHeight: 1440, title: 'Crop banner', safe: BANNER_SAFE, maxBytes: 5 * 1024 * 1024,
      previews: [{ label: 'Desktop', aspect: 2560 / 423 }, { label: 'Mobile', aspect: 1546 / 423 }] },
  };
  const croppedNote = { avatar: h('div', { class: 'hint', hidden: true }), banner: h('div', { class: 'hint', hidden: true }) };
  for (const [input, kind] of [[avatar, 'avatar'], [banner, 'banner']]) {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      cropped[kind] = null; croppedNote[kind].hidden = true;
      if (!file) return;
      const blob = await openCropper({ source: file, ...CROPS[kind] });
      if (!blob) { input.value = ''; return; }
      cropped[kind] = blob;
      croppedNote[kind].textContent = `Ready: ${CROPS[kind].outWidth} × ${CROPS[kind].outHeight} px, ${(blob.size / 1024).toFixed(0)} KB. Choose the file again to re-crop.`;
      croppedNote[kind].hidden = false;
    });
  }
  const cats = h('div', { class: 'chips' }, (state.config.categories || []).map((cat) => {
    const chip = h('button', { type: 'button', class: `chip${selected.has(cat.id) ? ' on' : ''}`, 'aria-pressed': String(selected.has(cat.id)), onclick: () => {
      if (selected.has(cat.id)) selected.delete(cat.id); else if (selected.size < 5) selected.add(cat.id); else return toast('Pick up to 5 categories');
      chip.classList.toggle('on', selected.has(cat.id)); chip.setAttribute('aria-pressed', String(selected.has(cat.id)));
    } }, cat.name);
    return chip;
  }));
  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'submit', style: 'height:42px' }, editing ? 'Save changes' : 'Create channel');

  const f = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const form = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; save.disabled = true;
    try {
      const body = { name: name.value, handle: handle.value.toLowerCase(), bio: bio.value, category_ids: [...selected], telegram_url: tg.value.trim() || null, telegram_enabled: tgOn.checked };
      const r = editing ? await api.patch('/api/me/channel', { ...body, resubmit: state.channel?.status === 'rejected' }) : await api.post('/api/me/channel', body);
      applyMe(r);
      for (const [input, kind] of [[avatar, 'avatar'], [banner, 'banner']]) {
        if (cropped[kind]) {
          const fd = new FormData(); fd.append('image', cropped[kind], `${kind}.jpg`);
          applyMe(await upload(`/api/me/channel/${kind}`, fd));
        }
      }
      toast(editing ? 'Channel updated' : 'Channel created. It is now pending review.');
      navigate('/studio');
    } catch (er) { err.textContent = er.message; err.hidden = false; }
    save.disabled = false;
  } },
    editing ? h('div', { class: 'row', style: 'margin-bottom:12px' }, avatarEl(c, 'md'), h('div', null, h('b', null, c.name), h('div', null, statusPill(c.status)))) : null,
    f('Channel name', name), f('Handle', handle, 'Your unique username, e.g. @yourname. 3–30 letters, numbers or underscores.'), f('Bio', bio),
    h('div', { class: 'field' }, h('label', null, 'Video categories (up to 5)'), cats),
    f('Telegram link', tg, 'Shown on your videos as “Join Telegram”. Must be a https://t.me/… link.'),
    h('label', { class: 'row small', style: 'margin:-6px 0 14px' }, tgOn, 'Show my Telegram button'),
    f('Profile picture', avatar, 'JPEG, PNG or WebP. You will crop it to a 400 × 400 square.'), croppedNote.avatar,
    f('Banner image (optional)', banner, 'JPEG, PNG or WebP. You will crop it to 2560 × 1440; keep the important part inside the safe area so it shows on every screen.'), croppedNote.banner,
    err, h('div', { class: 'row' }, save, h('a', { class: 'btn', href: editing ? '/studio' : '/' }, 'Cancel')));
  root.append(h('div', { class: 'page narrow' }, h('h1', { class: 'title', style: 'margin-bottom:6px' }, editing ? 'Edit channel' : 'Set up your channel'),
    editing ? null : h('p', { class: 'muted', style: 'margin-bottom:14px' }, 'After you create it, our team reviews your creator application. You can upload once it is approved.'), form));
  void icon;
}
