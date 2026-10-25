import { h, setTitle, toast } from '../util.js';
import { api, state, refreshMe } from '../api.js';
import { navigate } from '../router.js';
import { emptyState } from '../cards.js';
import { studioTabs } from '../creatorNav.js';
import { parseTags, tagProblem } from './upload.js';

const tagsToText = (a) => (a || []).join(', ');

export default async function uploadDefaults({ root }) {
  setTitle('Default upload settings');
  if (!state.user) { navigate('/login?next=/studio/upload-defaults', { replace: true }); return; }
  await refreshMe();
  const page = h('div', { class: 'page narrow' });
  root.append(page);
  if (!state.channel) {
    page.append(emptyState('Create your channel first', 'Default upload settings are available once you have a creator channel.', h('a', { class: 'btn primary', href: '/channel/setup', style: 'margin-top:12px' }, 'Set up channel')));
    return;
  }
  if (state.channel.status === 'approved') page.append(studioTabs('defaults'));
  page.append(h('h1', { class: 'title', style: 'margin-bottom:6px' }, 'Default upload settings'),
    h('p', { class: 'muted', style: 'margin-bottom:14px' }, 'These values are filled in automatically when you open the upload form. You can edit or replace every field for each video; nothing is published without you pressing Upload.'));

  let current;
  try { current = (await api.get('/api/me/upload-defaults')).defaults; } catch (e) { page.append(h('div', { class: 'err' }, e.message || 'Could not load your defaults')); return; }

  const cats = state.config?.categories || [];
  const sections = {};
  const section = (kind, label, descMax, descHint) => {
    const d = current[kind];
    const title = h('input', { class: 'input', id: `d-${kind}-title`, maxlength: 100, value: d.title, placeholder: kind === 'short' ? 'e.g. {filename} #shorts' : 'e.g. {filename} | My Channel' });
    const desc = h('textarea', { class: 'textarea', id: `d-${kind}-desc`, maxlength: descMax, placeholder: descHint }); desc.value = d.description;
    const tags = h('input', { class: 'input', id: `d-${kind}-tags`, value: tagsToText(d.tags), placeholder: '#hashtag, another hashtag (up to 10)', autocapitalize: 'none', spellcheck: 'false' });
    const cat = h('select', { class: 'select', id: `d-${kind}-cat` }, h('option', { value: '' }, 'No default category'), cats.map((c) => h('option', { value: c.id }, c.name)));
    cat.value = d.category_id || '';
    const tagErr = h('div', { class: 'err', hidden: true });
    tags.addEventListener('input', () => { const p = tagProblem(parseTags(tags.value)); tagErr.textContent = p; tagErr.hidden = !p; });
    const f = (lbl, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id }, lbl), input, hint ? h('div', { class: 'hint' }, hint) : null);
    sections[kind] = { title, desc, tags, cat };
    return h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { class: 'sec', style: 'margin-bottom:10px' }, label),
      f('Default title', title, 'Use {filename} to insert the video’s file name automatically.'),
      f(kind === 'short' ? 'Default caption' : 'Default description', desc),
      f('Default hashtags', tags, 'Separate with commas. The # is optional.'), tagErr,
      f('Default category', cat));
  };

  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'submit', style: 'height:42px' }, 'Save defaults');
  const reset = h('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!confirm('Clear all your default upload settings?')) return;
    try { const r = await api.del('/api/me/upload-defaults'); fill(r.defaults); toast('Defaults cleared'); } catch (e) { toast(e.message, 'bad'); }
  } }, 'Clear all defaults');

  function fill(d) {
    for (const k of ['long', 'short']) {
      const s = sections[k];
      s.title.value = d[k].title; s.desc.value = d[k].description; s.tags.value = tagsToText(d[k].tags); s.cat.value = d[k].category_id || '';
    }
  }
  const collect = (k) => ({ title: sections[k].title.value.trim(), description: sections[k].desc.value.trim(), tags: parseTags(sections[k].tags.value), category_id: sections[k].cat.value || null });

  const frm = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    const body = { long: collect('long'), short: collect('short') };
    const bad = tagProblem(body.long.tags) || tagProblem(body.short.tags);
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    save.disabled = true;
    try { const r = await api.put('/api/me/upload-defaults', body); fill(r.defaults); toast('Default upload settings saved'); }
    catch (er) { err.textContent = er.message || 'Could not save'; err.hidden = false; }
    save.disabled = false;
  } },
  section('long', 'Long videos', 5000, 'Description that is added to every new long video…'),
  section('short', 'Shorts', 500, 'Caption that is added to every new Short…'),
  err, h('div', { class: 'row wrap' }, save, reset, h('a', { class: 'btn', href: '/upload' }, 'Go to upload')));
  page.append(frm);
}
