import { h, icon, setTitle, toast, fmtDateTime, confirmDialog } from '../util.js';
import { api, state, refreshMe } from '../api.js';
import { navigate } from '../router.js';
import { emptyState } from '../cards.js';
import { creatorTabs } from '../creatorNav.js';
import { getResearch, setResearch, clearResearch, getDraft, patchDraft, draftFiles } from '../store.js';

// An analysis keeps running if the creator switches to Upload and back; the result is stored when it lands.
let running = null; // { url, count, promise }

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0', 'aria-hidden': 'true' }); ta.value = text;
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { ta.remove(); return toast('Copy failed. Select the text and copy it manually.', 'bad'); }
    ta.remove();
  }
  toast(`${what} copied`);
}

export default async function research({ root }) {
  setTitle('Research');
  if (!state.user) { navigate('/login?next=/research', { replace: true }); return; }
  await refreshMe();
  const page = h('div', { class: 'page narrow research' });
  root.append(page);
  page.append(creatorTabs('research'));
  if (!state.canUpload) {
    page.append(emptyState('Research is for approved creators', 'Once your channel is approved you can analyse a website and turn it into a video title, description and hashtags.',
      h('a', { class: 'btn primary', href: '/studio', style: 'margin-top:12px' }, 'View channel status')));
    return;
  }
  let alive = true;

  const s = getResearch();
  const url = h('input', { class: 'input', id: 'rurl', type: 'url', inputmode: 'url', placeholder: 'https://example.com/article', value: s.url, autocomplete: 'off', spellcheck: 'false', maxlength: 2000 });
  const count = h('select', { class: 'select', id: 'rcount' }, [1, 2, 3, 4, 5].map((n) => h('option', { value: n }, `${n} suggestion${n > 1 ? 's' : ''}`)));
  count.value = String(s.count || 3);
  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const go = h('button', { class: 'btn primary', type: 'submit', style: 'height:42px' }, icon('search'), 'Analyze website');
  const loader = h('div', { class: 'notice', hidden: true, role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Reading the page and preparing suggestions…');
  const results = h('div', { class: 'rresults' });

  const frm = h('form', { class: 'card', novalidate: true, onsubmit: (e) => { e.preventDefault(); analyze(); } },
    h('h1', { class: 'title', style: 'margin-bottom:4px' }, 'Research'),
    h('p', { class: 'muted', style: 'margin-bottom:14px' }, 'Paste a web page and get video title, description and hashtag ideas based on what is on it.'),
    h('div', { class: 'field' }, h('label', { for: 'rurl' }, 'Website URL'), url),
    h('div', { class: 'field' }, h('label', { for: 'rcount' }, 'Number of suggestions'), count),
    err, go);
  page.append(frm, loader, results);

  function setBusy(b) { go.disabled = b; url.disabled = b; count.disabled = b; loader.hidden = !b; }
  function fail(m) { err.textContent = m; err.hidden = false; }

  function analyze() {
    err.hidden = true;
    const value = url.value.trim();
    if (!value) return fail('Enter a website address first.');
    if (running) return;
    setBusy(true);
    const n = Number(count.value);
    running = { url: value, count: n, promise: api.post('/api/research/analyze', { url: value, count: n }) };
    const p = running.promise;
    p.then((r) => {
      // The old results are replaced only now, by a completed new analysis.
      setResearch({ url: value, count: n, result: r, analyzedAt: r.source.analyzed_at });
    }).catch(() => {}).finally(() => { if (running?.promise === p) running = null; });
    p.then(() => { if (alive) { setBusy(false); render(); } }, (e) => { if (alive) { setBusy(false); fail(e.message || 'The analysis failed. Try again.'); } });
  }

  function useIt(sug) {
    const d = getDraft();
    const fill = () => {
      patchDraft({ title: sug.title, description: sug.description, tags: sug.hashtags.join(', '), fromResearch: true });
      navigate(draftFiles.file && draftFiles.fileKind ? `/upload/${draftFiles.fileKind}` : '/upload');
    };
    if ((d.title || d.description || d.tags) && !d.fromResearch) {
      confirmDialog({ title: 'Replace your upload details?', text: 'Your upload form already has a title, description or hashtags. They will be replaced by this suggestion. Your chosen video file is kept.', confirmText: 'Replace and continue' })
        .then((ok) => { if (ok) fill(); });
    } else fill();
  }

  function card(sug, i) {
    const tags = sug.hashtags.join(' ');
    const all = `${sug.title}\n\n${sug.description}\n\n${tags}`;
    const btn = (label, fn, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick: fn }, label);
    return h('article', { class: 'card rcard', 'aria-label': `Suggestion ${i + 1}` },
      h('div', { class: 'muted small' }, `Suggestion ${i + 1}`),
      h('h2', { class: 'rtitle' }, sug.title),
      h('p', { class: 'rdesc' }, sug.description),
      h('div', { class: 'chips', 'aria-label': 'Hashtags' }, sug.hashtags.map((t) => h('span', { class: 'chip' }, t))),
      sug.keywords?.length ? h('div', { class: 'muted small', style: 'margin-top:8px' }, h('b', null, 'Suggested keywords: '), sug.keywords.join(', ')) : null,
      h('div', { class: 'row wrap ractions' },
        btn('Copy title', () => copy(sug.title, 'Title')), btn('Copy description', () => copy(sug.description, 'Description')),
        btn('Copy hashtags', () => copy(tags, 'Hashtags')), btn('Copy all', () => copy(all, 'Suggestion')),
        btn([icon('upload'), 'Upload This'], () => useIt(sug), 'primary')));
  }

  function render() {
    const r = getResearch();
    if (!r.result) { results.replaceChildren(); return; }
    results.replaceChildren(
      h('div', { class: 'card rmeta' },
        h('div', { class: 'row between wrap' },
          h('div', { style: 'min-width:0' }, h('div', { class: 'muted small' }, 'Analysed'), h('div', { class: 'rurl' }, r.result.source.final_url), h('div', { class: 'muted small' }, fmtDateTime(r.analyzedAt))),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            if (!(await confirmDialog({ title: 'Clear research?', text: 'The suggestions below will be removed. Your upload form is not affected.', confirmText: 'Clear' }))) return;
            clearResearch(); url.value = ''; count.value = '3'; render();
          } }, 'Clear research')),
        h('ul', { class: 'rnotes' }, r.result.notes.map((n) => h('li', { class: 'muted small' }, n)))),
      ...r.result.suggestions.map(card),
      r.result.page_keywords?.length ? h('div', { class: 'card' }, h('b', null, 'Keywords found on the page'),
        h('div', { class: 'chips', style: 'margin-top:8px' }, r.result.page_keywords.map((k) => h('span', { class: 'chip' }, k))),
        h('p', { class: 'muted small', style: 'margin-top:8px' }, 'These are terms that appear on the page, not verified high-volume search terms.')) : null);
  }

  render();
  if (running) { setBusy(true); url.value = running.url; count.value = String(running.count); running.promise.then(() => { if (alive) { setBusy(false); render(); } }, (e) => { if (alive) { setBusy(false); fail(e.message); } }); }
  return { destroy() { alive = false; } };
}
