// Shared engagement behaviour (reactions, save, share, report, comments, Telegram) for Shorts and long videos.
import { h, icon, toast, openModal, fmtCount, timeAgo, initials } from './util.js';
import { api, state } from './api.js';
import { navigate } from './router.js';
import { avatarEl } from './cards.js';

export function requireLogin(message = 'Log in to continue') {
  if (state.user) return true;
  const next = location.pathname + location.search;
  openModal((box, close) => {
    box.append(h('h3', null, message), h('p', { class: 'muted' }, 'You need an account for this. Viewing, sharing, hearts and dislikes never require one.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => { close(); navigate(`/register?next=${encodeURIComponent(next)}`); } }, 'Create account'),
        h('button', { class: 'btn primary', onclick: () => { close(); navigate(`/login?next=${encodeURIComponent(next)}`); } }, 'Log in')));
  });
  return false;
}

export async function react(video, type) {
  const prev = { my: video.my_reaction || null, hearts: video.metrics.hearts, dislikes: video.metrics.dislikes };
  const next = prev.my === type ? null : type;
  const apply = (my, hearts, dislikes) => { video.my_reaction = my; video.metrics.hearts = hearts; video.metrics.dislikes = dislikes; };
  let hearts = prev.hearts - (prev.my === 'heart' ? 1 : 0) + (next === 'heart' ? 1 : 0);
  let dislikes = prev.dislikes - (prev.my === 'dislike' ? 1 : 0) + (next === 'dislike' ? 1 : 0);
  apply(next, hearts, dislikes);
  try {
    const r = await api.post(`/api/videos/${video.id}/react`, { type: next });
    apply(r.my_reaction, r.hearts, r.dislikes);
  } catch (e) {
    apply(prev.my, prev.hearts, prev.dislikes);
    toast(e.message, 'bad');
  }
}

export async function toggleSave(video) {
  if (!requireLogin('Log in to save videos')) return;
  const was = !!video.saved;
  video.saved = !was;
  try {
    const r = was ? await api.del(`/api/videos/${video.id}/save`) : await api.put(`/api/videos/${video.id}/save`);
    video.saved = r.saved; video.metrics.saves = r.saves;
    toast(r.saved ? 'Saved to your collection' : 'Removed from saved');
  } catch (e) { video.saved = was; toast(e.message, 'bad'); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = h('textarea', { style: 'position:fixed;left:-999px;top:0', readonly: true });
  ta.value = text; document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

export const canonicalUrl = (video) => `${location.origin}/${video.kind === 'short' ? 'shorts' : 'watch'}/${video.id}`;

export async function shareVideo(video) {
  const url = canonicalUrl(video);
  let shared = false;
  if (navigator.share) {
    try { await navigator.share({ title: video.title, url }); shared = true; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  if (!shared) {
    if (await copyText(url)) toast('Link copied');
    else { window.prompt('Copy this link', url); }
  }
  try {
    const r = await api.post(`/api/videos/${video.id}/share`, { method: shared ? 'native' : 'copy' });
    if (r.counted) video.metrics.shares = r.shares;
  } catch { /* sharing still worked */ }
}

export function reportDialog(video, comment) {
  if (!requireLogin('Log in to report content')) return;
  openModal((box, close) => {
    const reason = h('select', { class: 'select' }, [['spam', 'Spam or scam'], ['sexual', 'Sexual content'], ['violence', 'Violence'], ['hate', 'Hate speech'],
      ['harassment', 'Harassment'], ['copyright', 'Copyright'], ['misleading', 'Misleading'], ['other', 'Something else']].map(([v, l]) => h('option', { value: v }, l)));
    const details = h('textarea', { class: 'textarea', maxlength: 1000, placeholder: 'Add details (optional)' });
    const err = h('div', { class: 'err', hidden: true });
    box.append(h('h3', null, comment ? 'Report comment' : 'Report video'),
      h('div', { class: 'field' }, h('label', null, 'Reason'), reason), h('div', { class: 'field' }, h('label', null, 'Details'), details), err,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.post(comment ? `/api/comments/${comment}/report` : `/api/videos/${video.id}/report`, { reason: reason.value, details: details.value });
            close(); toast('Thanks, our team will review this.');
          } catch (er) { err.textContent = er.message; err.hidden = false; e.target.disabled = false; }
        } }, 'Submit report')));
  });
}

export function telegramButton(tg, cls = '') {
  if (!tg?.url) return null;
  return h('a', { class: `btn tg sm ${cls}`, href: tg.url, target: '_blank', rel: 'noopener noreferrer nofollow', onclick: (e) => e.stopPropagation() }, icon('send'), 'Join Telegram');
}

/** Comments panel; loads only when created (the caller creates it when the user opens the panel). */
export function commentsPanel(video, { onCount } = {}) {
  const list = h('div', { class: 'list-inner' });
  const more = h('button', { class: 'btn sm', hidden: true }, 'Show more');
  const status = h('div', { class: 'loading' }, 'Loading comments…');
  let page = 0;
  const wrap = h('div', { class: 'comments' });

  const item = (c) => {
    const row = h('div', { class: 'cm' },
      avatarEl({ name: c.author.name, avatar_url: c.author.avatar_url }, 'md'),
      h('div', { class: 'grow' },
        h('div', { class: 'small' }, h('b', null, c.author.handle ? `@${c.author.handle}` : c.author.name), ' ', h('span', { class: 'muted' }, timeAgo(c.created_at))),
        h('div', { class: 'body' }, c.body),
        h('div', { class: 'cm-actions' },
          c.mine ? h('button', { onclick: async () => {
            try { const r = await api.del(`/api/comments/${c.id}`); row.remove(); video.metrics.comments = r.comments; onCount?.(r.comments); } catch (e) { toast(e.message, 'bad'); }
          } }, 'Delete') : h('button', { onclick: () => reportDialog(video, c.id) }, 'Report'))));
    return row;
  };

  async function load() {
    try {
      const r = await api.get(`/api/videos/${video.id}/comments?page=${page}`);
      status.remove();
      if (page === 0 && !r.items.length) list.append(h('div', { class: 'loading' }, 'No comments yet. Be the first.'));
      r.items.forEach((c) => list.append(item(c)));
      more.hidden = !r.has_more;
    } catch (e) { status.textContent = e.message; }
  }
  more.addEventListener('click', () => { page++; load(); });

  let composer;
  if (!video.comments_enabled && video.comments_enabled !== undefined) {
    composer = h('div', { class: 'muted small' }, 'Comments are turned off.');
  } else if (!state.user) {
    composer = h('div', { class: 'notice small' }, h('a', { href: `/login?next=${encodeURIComponent(location.pathname)}`, style: 'text-decoration:underline' }, 'Log in'), ' to join the conversation.');
  } else if (state.config?.email_verification_required && !state.user.email_verified) {
    composer = h('div', { class: 'notice small' }, 'Verify your email address to comment.');
  } else {
    const ta = h('textarea', { class: 'textarea', maxlength: 1000, placeholder: 'Add a comment…', 'aria-label': 'Add a comment' });
    const err = h('div', { class: 'err', hidden: true });
    const post = h('button', { class: 'btn primary sm' }, 'Comment');
    post.addEventListener('click', async () => {
      const body = ta.value.trim();
      if (!body) return;
      post.disabled = true; err.hidden = true;
      try {
        const r = await api.post(`/api/videos/${video.id}/comments`, { body });
        ta.value = '';
        list.querySelector('.loading')?.remove();
        list.prepend(item(r.comment));
        video.metrics.comments = r.comments; onCount?.(r.comments);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
      post.disabled = false;
    });
    composer = h('div', null, h('div', { class: 'composer' }, avatarEl({ name: state.user.full_name }, 'md'), ta), err, h('div', { class: 'row', style: 'justify-content:flex-end' }, post));
  }
  wrap.append(composer, status, list, h('div', { class: 'row', style: 'justify-content:center;margin:8px 0' }, more));
  load();
  return wrap;
}
