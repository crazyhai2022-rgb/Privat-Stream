import { h, icon, fmtCount, timeAgo, setTitle, statusPill } from '../util.js';
import { api, state } from '../api.js';
import { navigate } from '../router.js';
import { avatarEl, longCard, emptyState, sectionHead } from '../cards.js';
import { react, toggleSave, shareVideo, reportDialog, subscribeBar, commentsPanel } from '../engage.js';

export default async function watch({ root, params }) {
  const page = h('div', { class: 'page' });
  root.append(page);
  let v;
  try {
    const d = await api.get(`/api/videos/${params.id}`);
    v = d.video;
    v.visible_to_public = d.visible_to_public;
  } catch (e) {
    page.append(emptyState('Video unavailable', e.status === 404 ? 'This video does not exist or is not available.' : e.message, h('a', { class: 'btn primary', href: '/', style: 'margin-top:12px' }, 'Back to home')));
    return;
  }
  if (v.kind === 'short') { navigate(`/shorts/${v.id}`, { replace: true }); return; }
  setTitle(v.title);

  const ads = state.config?.ads || {};
  const reserve = ads.reserve_space !== false;
  const grid = h('div', { class: `watch${reserve ? '' : ' noad'}`, style: `--ad-w:${ads.width || 300}px;--ad-h:${ads.min_height || 600}px` });
  const main = h('div', { style: 'min-width:0' });
  grid.append(main);
  if (reserve) grid.append(h('aside', { class: 'ad-slot', 'aria-label': 'Advertisement space', dataset: { slot: ads.slot_id || '' } }, ads.show_label ? 'Advertisement' : null));
  page.append(grid);

  // Player (never autoplays)
  const video = h('video', { controls: '', playsinline: '', preload: 'metadata', poster: v.thumbnail_url || '', 'aria-label': v.title, controlslist: 'nodownload' });
  if (v.stream_url) video.src = v.stream_url;
  main.append(h('div', { class: 'player' }, video));
  if (!v.visible_to_public) main.append(h('div', { class: `notice ${v.status === 'published' ? '' : 'warn'}`, style: 'margin-top:10px' }, 'Preview: this video is ', statusPill(v.status), ' and is only visible to you and moderators.'));

  let viewed = false;
  video.addEventListener('timeupdate', async () => {
    if (viewed || video.currentTime < 3 || !v.visible_to_public) return;
    viewed = true;
    try { const r = await api.post(`/api/videos/${v.id}/view`); if (r.counted) { v.metrics.views = r.views; stats.textContent = statsText(); } } catch { /* ignore */ }
  });

  main.append(h('h1', null, v.title));

  const mk = (name, label, fn) => {
    const t = h('span', null, label);
    const b = h('button', { class: 'act', onclick: fn }, icon(name), t);
    return { b, set(text, on) { t.textContent = text; b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  };
  const heart = mk('heart', '', async () => { await react(v, 'heart'); sync(); });
  const dis = mk('dislike', '', async () => { await react(v, 'dislike'); sync(); });
  const comBtn = mk('comment', '', () => toggleComments());
  const share = mk('share', 'Share', async () => { await shareVideo(v); sync(); });
  const save = mk('bookmark', 'Save', async () => { await toggleSave(v); sync(); });
  heart.b.setAttribute('aria-label', 'Heart'); dis.b.setAttribute('aria-label', 'Dislike');
  const report = h('button', { class: 'act', 'aria-label': 'Report', onclick: () => reportDialog(v) }, icon('flag'));
  function sync() {
    heart.set(fmtCount(v.metrics.hearts), v.my_reaction === 'heart');
    dis.set(fmtCount(v.metrics.dislikes), v.my_reaction === 'dislike');
    comBtn.set(`Comments ${fmtCount(v.metrics.comments)}`);
    share.set(v.metrics.shares ? `Share · ${fmtCount(v.metrics.shares)}` : 'Share');
    save.set(v.saved ? 'Saved' : 'Save', v.saved);
    if (viewBtn) viewBtn.textContent = `${commentsOpen ? 'Hide' : 'View'} Comments (${fmtCount(v.metrics.comments)})`;
  }

  const sbar = subscribeBar(v.channel, { subscribers: 0, subscribed: false }, { telegram: v.telegram, isOwner: state.channel?.handle === v.channel.handle });
  api.get(`/api/channels/${v.channel.handle}/subscription`).then((info) => {
    const fresh = subscribeBar(v.channel, info, { telegram: v.telegram, isOwner: state.channel?.handle === v.channel.handle });
    sbar.el.replaceWith(fresh.el); sbar.countEl.replaceWith(fresh.countEl);
  }).catch(() => {});
  main.append(h('div', { class: 'wmeta' },
    h('div', { class: 'wchan' },
      h('a', { href: `/c/${v.channel.handle}`, class: 'row wlink' }, avatarEl(v.channel, 'md'),
        h('div', { class: 'wname' }, h('div', { class: 'cname-sm' }, v.channel.name), h('div', { class: 'muted small' }, '@' + v.channel.handle))),
      sbar.countEl, sbar.el),
    h('div', { class: 'actions' }, heart.b, dis.b, comBtn.b, share.b, save.b, report)));

  const statsText = () => `${fmtCount(v.metrics.views)} views · ${v.published_at ? timeAgo(v.published_at) : 'not published'}`;
  const stats = h('span', null, statsText());
  main.append(h('div', { class: 'row wrap muted small', style: 'margin-top:12px' }, stats, v.category ? h('a', { class: 'chip', href: `/category/${v.category.slug}` }, v.category.name) : null,
    (v.tags || []).map((t) => h('a', { class: 'chip', href: `/search?q=${encodeURIComponent(t)}` }, '#' + t))));

  if (v.description) {
    const desc = h('div', { class: 'desc collapsed' }, v.description);
    const toggle = h('button', { class: 'btn sm', style: 'margin-top:8px', onclick: () => { const c = desc.classList.toggle('collapsed'); toggle.textContent = c ? 'Show more' : 'Show less'; } }, 'Show more');
    main.append(desc);
    requestAnimationFrame(() => { if (desc.scrollHeight <= desc.clientHeight + 2 && v.description.length < 220) { desc.classList.remove('collapsed'); toggle.remove(); } });
    main.append(toggle);
  }

  // Comments stay collapsed until the viewer opens them.
  let commentsOpen = false, panel = null;
  const viewBtn = h('button', { class: 'btn', style: 'margin-top:16px;width:100%;justify-content:space-between', 'aria-expanded': 'false', onclick: () => toggleComments() }, '');
  const commentsHost = h('div', { hidden: true });
  function toggleComments() {
    commentsOpen = !commentsOpen;
    if (commentsOpen && !panel) { panel = commentsPanel(v, { onCount: sync }); commentsHost.append(panel); }
    commentsHost.hidden = !commentsOpen;
    viewBtn.setAttribute('aria-expanded', String(commentsOpen));
    sync();
    if (commentsOpen) commentsHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  main.append(viewBtn, commentsHost);
  sync();

  // Related videos sit below the content, never in the ad column.
  const related = h('section', { style: 'margin-top:26px' }, sectionHead('More videos'));
  main.append(related);
  (async () => {
    try {
      const r = await api.get(`/api/videos/${v.id}/related?limit=12`);
      if (!r.items.length) { related.append(h('p', { class: 'muted' }, 'No other videos yet.')); return; }
      related.append(h('div', { class: 'lgrid all' }, r.items.map(longCard)));
    } catch { /* ignore */ }
  })();

  return { destroy() { video.pause(); video.removeAttribute('src'); video.load(); } };
}
