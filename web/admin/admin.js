// Super Admin panel: separate login (admin session cookie), role-aware navigation, real data only.
import { h, icon, brandWordmark, passwordInput, toast, confirmDialog, openModal, fmtCount, fmtDateTime, timeAgo, statusPill, statusLabel, fmtDur, qs, initials } from '../js/util.js';
import { api, state, ApiError } from '../js/api.js';

const app = document.getElementById('app');
const BRAND = () => state.config?.brand?.name || 'viralX';
const S = { admin: null, perms: [], pending: {}, view: null };

const PAGES = [
  ['dashboard', 'Dashboard', 'grid', 'dashboard'],
  ['creators', 'Creator approvals', 'user', 'creators'],
  ['videos', 'Video moderation', 'film', 'videos'],
  ['reports', 'Reports', 'flag', 'reports'],
  ['popularity', 'Popularity', 'heart', 'popularity'],
  ['users', 'Users', 'user', 'users'],
  ['categories', 'Categories & tags', 'tag', 'categories'],
  ['settings', 'Platform settings', 'sliders', 'settings'],
  ['audit', 'Audit log', 'eye', 'audit'],
];
const can = (p) => S.perms.includes(p);
const route = () => (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
const go = (path) => { location.hash = '#/' + path; };

// ---------- small shared bits ----------
const err = (e) => toast(e instanceof ApiError ? e.message : String(e?.message || e), 'bad');
const field = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
const input = (props) => h('input', { class: 'input', ...props });
const select = (opts, value, props = {}) => h('select', { class: 'select', ...props }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
const section = (title, ...kids) => h('section', { class: 'panel' }, h('h3', null, title), ...kids);
const metrics = (m) => h('div', { class: 'mets' }, [['views', m.views], ['unique', m.unique_views], ['hearts', m.hearts], ['dislikes', m.dislikes],
  ['comments', m.comments], ['shares', m.shares], ['saves', m.saves]].filter(([, v]) => v !== undefined).map(([k, v]) => h('span', null, h('b', null, fmtCount(v)), ' ', k)));

function pager(res, onPage) {
  return h('div', { class: 'pager' },
    h('button', { class: 'btn sm', disabled: !res.page, onclick: () => onPage(res.page - 1) }, 'Previous'),
    h('span', { class: 'muted small', style: 'align-self:center' }, `Page ${res.page + 1}`),
    h('button', { class: 'btn sm', disabled: !res.has_more, onclick: () => onPage(res.page + 1) }, 'Next'));
}
function table(cols, rows) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: cols.length, style: 'text-align:center;color:var(--text-2);padding:28px' }, 'Nothing to show.')))));
}
const reasonAsk = (label = 'Reason (recorded in the moderation log)', placeholder = 'Why?') => ({ label, placeholder, required: true, multiline: true, min: 3, requiredMessage: 'Please write a short reason (at least 3 characters).' });

async function act(fn, okMsg, after) {
  try { await fn(); if (okMsg) toast(okMsg); await after?.(); } catch (e) { err(e); }
}

// ---------- first-time setup ----------
// Shown only while the server says no Super Admin exists and a bootstrap token is configured.
function setupView() {
  const name = input({ autocomplete: 'name', required: true, placeholder: 'Your name' });
  const email = input({ type: 'email', autocomplete: 'username', required: true });
  const tokenWrap = passwordInput({ autocomplete: 'off', required: true, placeholder: 'From your hosting environment variables' });
  const pwWrap = passwordInput({ autocomplete: 'new-password', required: true });
  const pw2Wrap = passwordInput({ autocomplete: 'new-password', required: true });
  const msg = h('div', { class: 'err', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;height:42px' }, 'Create administrator');

  app.replaceChildren(h('div', { class: 'adm-login' },
    h('div', { class: 'brand', style: 'justify-content:center;margin-bottom:6px;font-size:28px' }, brandWordmark(BRAND())),
    h('p', { class: 'muted', style: 'text-align:center;margin-bottom:18px' }, 'First-time setup'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); msg.hidden = true;
      if (pwWrap.input.value !== pw2Wrap.input.value) { msg.textContent = 'The two passwords do not match'; msg.hidden = false; return; }
      btn.disabled = true;
      try {
        await api.post('/api/admin/bootstrap', {
          token: tokenWrap.input.value.trim(),
          email: email.value.trim(),
          full_name: name.value.trim(),
          password: pwWrap.input.value,
        });
        // Log straight in with what was just created.
        const r = await api.post('/api/admin/auth/login', { email: email.value.trim(), password: pwWrap.input.value });
        state.adminCsrf = r.csrf_token; S.admin = r.admin; S.perms = r.permissions;
        toast('Administrator created. Remove ADMIN_BOOTSTRAP_TOKEN from your hosting settings.');
        render();
      } catch (e2) {
        msg.textContent = e2.status === 404
          ? 'Setup is not available: either an administrator already exists, or the token is wrong or missing.'
          : e2.status === 401
            ? 'The server is still running an older version of the app. Restart it in your hosting panel and try again.'
            : e2.message;
        msg.hidden = false;
        btn.disabled = false;
      }
    } },
      h('p', { class: 'muted small', style: 'margin-bottom:14px' },
        'No administrator exists yet. Paste the ADMIN_BOOTSTRAP_TOKEN you set in your hosting panel and choose your login details.'),
      field('Your name', name),
      field('Email', email),
      field('Setup token', tokenWrap),
      field('Password', pwWrap, 'At least 12 characters with letters and numbers'),
      field('Confirm password', pw2Wrap),
      msg, btn),
    h('p', { class: 'muted small', style: 'text-align:center;margin-top:14px' },
      'Delete the token once the administrator exists. ',
      h('a', { href: '#', style: 'text-decoration:underline', onclick: (e) => { e.preventDefault(); loginView(); } }, 'Back to log in'),
      '.')));
  name.focus();
}

// ---------- login ----------
function loginView() {
  const email = input({ type: 'email', autocomplete: 'username', required: true });
  const pwWrap = passwordInput({ autocomplete: 'current-password', required: true });
  const pw = pwWrap.input;
  const msg = h('div', { class: 'err', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;height:42px' }, 'Log in');
  app.replaceChildren(h('div', { class: 'adm-login' },
    h('div', { class: 'brand', style: 'justify-content:center;margin-bottom:6px;font-size:28px' }, brandWordmark(BRAND())),
    h('p', { class: 'muted', style: 'text-align:center;margin-bottom:18px' }, 'Administration'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); msg.hidden = true; btn.disabled = true;
      try {
        const r = await api.post('/api/admin/auth/login', { email: email.value, password: pw.value });
        state.adminCsrf = r.csrf_token; S.admin = r.admin; S.perms = r.permissions;
        render();
      } catch (e2) { msg.textContent = e2.message; msg.hidden = false; }
      btn.disabled = false;
    } }, field('Email', email), field('Password', pwWrap), msg, btn),
    h('p', { class: 'muted small', style: 'text-align:center;margin-top:14px' },
      'No administrator yet? ',
      h('a', { href: '#', style: 'text-decoration:underline', onclick: (e) => { e.preventDefault(); setupView(); } }, 'First-time setup'),
      '.')));
  email.focus();
}

// ---------- shell ----------
let sideEl, bodyEl, titleEl;
function shell() {
  const nav = h('nav', null, PAGES.filter(([, , , p]) => can(p)).map(([key, label, ic]) =>
    h('a', { href: `#/${key}`, dataset: { key } }, icon(ic), label, h('span', { class: 'count', dataset: { badge: key }, hidden: true }))));
  sideEl = h('aside', { class: 'adm-side' },
    h('div', { class: 'brand' }, brandWordmark(BRAND())), h('div', { class: 'tagline' }, 'Super Admin'), nav,
    h('div', { style: 'margin-top:14px;padding:0 10px' }, h('a', { href: '/', target: '_blank', rel: 'noopener', class: 'muted small' }, 'Open public site ↗')));
  titleEl = h('h1', { style: 'font-size:18px' }, 'Dashboard');
  bodyEl = h('div', { class: 'adm-body' });
  app.replaceChildren(h('div', { class: 'adm' }, sideEl, h('main', { class: 'adm-main' },
    h('header', { class: 'adm-top' },
      h('button', { class: 'icon-btn adm-burger', 'aria-label': 'Menu', onclick: () => sideEl.classList.toggle('open') }, icon('menu')),
      titleEl,
      h('div', { class: 'adm-who' },
        h('div', { class: 'avatar' }, initials(S.admin.name)),
        h('div', { class: 'small' }, h('b', null, S.admin.name), h('div', { class: 'muted' }, S.admin.role === 'super_admin' ? 'Super Admin' : 'Moderator')),
        h('button', { class: 'btn sm', onclick: async () => { await api.post('/api/admin/auth/logout').catch(() => {}); S.admin = null; state.adminCsrf = null; render(); } }, icon('logout'), 'Log out'))),
    bodyEl)));
  sideEl.addEventListener('click', (e) => { if (e.target.closest('a')) sideEl.classList.remove('open'); });
}

async function refreshBadges() {
  if (!can('dashboard')) return;
  try {
    const d = await api.get('/api/admin/dashboard');
    S.pending = { creators: d.creators.pending, videos: d.videos.pending_review, reports: d.reports.open_reports };
    for (const [k, v] of Object.entries(S.pending)) {
      const el = sideEl?.querySelector(`[data-badge="${k}"]`);
      if (el) { el.textContent = String(v); el.hidden = !v; }
    }
    return d;
  } catch { /* ignore */ }
}

// ---------- pages ----------
async function dashboard() {
  const d = await refreshBadges() || await api.get('/api/admin/dashboard');
  const kpi = (label, value, href, alert) => h(href ? 'a' : 'div', { class: `kpi${alert ? ' alert' : ''}`, href }, h('b', null, fmtCount(value)), h('span', null, label));
  bodyEl.replaceChildren(
    h('div', { class: 'kpis' },
      kpi('Registered users', d.users.total, '#/users'),
      kpi('New this week', d.users.new_7d),
      kpi('Pending creator approvals', d.creators.pending, '#/creators', d.creators.pending > 0),
      kpi('Active creators', d.creators.active, '#/creators'),
      kpi('Suspended users', d.users.suspended, '#/users'),
      kpi('Uploaded videos', d.videos.uploaded, '#/videos'),
      kpi('Pending video reviews', d.videos.pending_review, '#/videos/pending', d.videos.pending_review > 0),
      kpi('Published videos', d.videos.published, '#/videos'),
      kpi('Reported videos', d.reports.reported_videos, '#/reports', d.reports.reported_videos > 0),
      kpi('Total views', d.metrics.views),
      kpi('Total hearts', d.metrics.hearts),
      kpi('Total dislikes', d.metrics.dislikes)),
    h('div', { class: 'two' },
      section('Recent moderation activity',
        d.recent_activity.length ? h('ul', { class: 'log' }, d.recent_activity.map((a) => h('li', null,
          h('b', null, a.action.replace(/_/g, ' ')), a.video_title ? [' · ', h('a', { href: `#/videos/${a.video_id}`, style: 'text-decoration:underline' }, a.video_title)] : null,
          h('div', { class: 'muted' }, `${a.admin_name || 'system'} · ${timeAgo(a.created_at)}`),
          a.note ? h('div', { class: 'muted' }, a.note) : null))) : h('p', { class: 'muted' }, 'No moderation actions yet.')),
      section('Published mix',
        h('div', { class: 'kv' },
          h('dt', null, 'Shorts'), h('dd', null, fmtCount(d.videos.published_shorts)),
          h('dt', null, 'Long videos'), h('dd', null, fmtCount(d.videos.published_long)),
          h('dt', null, 'Comments'), h('dd', null, fmtCount(d.metrics.comments)),
          h('dt', null, 'Shares'), h('dd', null, fmtCount(d.metrics.shares)),
          h('dt', null, 'Rejected creators'), h('dd', null, fmtCount(d.creators.rejected)),
          h('dt', null, 'Suspended channels'), h('dd', null, fmtCount(d.creators.suspended))))));
}

async function creators(sub) {
  let status = sub || 'pending';
  const host = h('div');
  const tabs = h('div', { class: 'tabs' }, ['pending', 'approved', 'rejected', 'suspended', 'all'].map((s) =>
    h('button', { class: status === s ? 'on' : '', onclick: () => { status = s; go(`creators/${s}`); } }, s[0].toUpperCase() + s.slice(1))));
  bodyEl.replaceChildren(tabs, host);
  async function load(page = 0) {
    host.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
    const r = await api.get('/api/admin/creators' + qs({ status: status === 'all' ? '' : status, page }));
    const rows = r.items.map((c) => h('tr', null,
      h('td', null, h('div', { class: 'row' }, c.avatar_url ? h('img', { class: 'avatar', src: c.avatar_url, alt: '' }) : h('div', { class: 'avatar' }, initials(c.name)),
        h('div', null, h('b', null, c.name), h('div', { class: 'muted small' }, '@' + c.handle)))),
      h('td', null, h('div', null, c.full_name), h('div', { class: 'muted small mono' }, c.email), c.email_verified_at ? null : h('span', { class: 'status pending' }, 'Email not verified')),
      h('td', null, h('div', { class: 'clamp2 small muted', style: 'max-width:280px' }, c.bio || '—'),
        c.telegram_url ? h('div', { class: 'small mono muted' }, c.telegram_url) : null),
      h('td', { class: 'num' }, c.video_count),
      h('td', null, statusPill(c.status), c.status_reason ? h('div', { class: 'muted small clamp2' }, c.status_reason) : null),
      h('td', { class: 'muted small' }, fmtDateTime(c.created_at)),
      h('td', null, h('div', { class: 'row wrap' },
        c.status !== 'approved' ? h('button', { class: 'btn sm primary', onclick: () => approve(c) }, 'Approve') : null,
        c.status === 'pending' || c.status === 'approved' ? h('button', { class: 'btn sm', onclick: () => reject(c) }, 'Reject') : null,
        c.status === 'approved' ? h('button', { class: 'btn sm danger', onclick: () => suspend(c) }, 'Suspend') : null,
        h('a', { class: 'btn sm', href: `/c/${c.handle}`, target: '_blank', rel: 'noopener' }, 'View')))));
    host.replaceChildren(table([{ label: 'Channel' }, { label: 'Owner' }, { label: 'About' }, { label: 'Videos', num: true }, { label: 'Status' }, { label: 'Applied' }, { label: '' }], rows), pager(r, load));
  }
  const approve = (c) => act(() => api.post(`/api/admin/channels/${c.id}/approve`, {}), 'Creator approved', () => { load(); refreshBadges(); });
  const reject = async (c) => {
    const reason = await confirmDialog({ title: `Reject @${c.handle}?`, text: 'The creator sees this reason and can edit and resubmit.', confirmText: 'Reject', ask: reasonAsk() });
    if (reason) act(() => api.post(`/api/admin/channels/${c.id}/reject`, { reason }), 'Creator rejected', () => { load(); refreshBadges(); });
  };
  const suspend = async (c) => {
    const reason = await confirmDialog({ title: `Suspend @${c.handle}?`, text: 'Their videos stay but uploads are blocked.', confirmText: 'Suspend', danger: true, ask: reasonAsk() });
    if (reason) act(() => api.post(`/api/admin/channels/${c.id}/suspend`, { reason, confirm: true }), 'Channel suspended', load);
  };
  await load();
}

async function videosPage(sub) {
  if (sub && sub !== 'pending' && sub !== 'reported') return videoDetail(sub);
  const f = { status: sub === 'pending' ? 'pending_moderation' : '', kind: '', q: '', reported: sub === 'reported' ? '1' : '' };
  const host = h('div');
  const q = input({ placeholder: 'Title, creator, category or ID', value: f.q });
  const statusSel = select([['', 'All statuses'], ['pending_moderation', 'Pending moderation'], ['published', 'Published'], ['processing', 'Processing'], ['rejected', 'Rejected'], ['removed', 'Removed']], f.status);
  const kindSel = select([['', 'Shorts & long'], ['short', 'Shorts only'], ['long', 'Long only']], f.kind);
  const repOnly = h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: f.reported === '1' }), 'Reported only');
  const apply = () => { f.q = q.value.trim(); f.status = statusSel.value; f.kind = kindSel.value; f.reported = repOnly.querySelector('input').checked ? '1' : ''; load(0); };
  [statusSel, kindSel, repOnly].forEach((el) => el.addEventListener('change', apply));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  bodyEl.replaceChildren(h('div', { class: 'filters' }, q, h('button', { class: 'btn sm', onclick: apply }, icon('search'), 'Search'), statusSel, kindSel, repOnly), host);

  async function load(page = 0) {
    host.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
    const r = await api.get('/api/admin/videos' + qs({ ...f, page }));
    const rows = r.items.map((v) => h('tr', null,
      h('td', null, v.thumbnail_url ? h('img', { class: v.kind === 'short' ? 'thumb-s' : 'thumb-l', src: v.thumbnail_url, alt: '', loading: 'lazy' }) : h('div', { class: `${v.kind === 'short' ? 'thumb-s' : 'thumb-l'} ph` }, '—')),
      h('td', null, h('a', { href: `#/videos/${v.public_id}`, style: 'font-weight:600' }, v.title),
        h('div', { class: 'muted small' }, `@${v.channel_handle} · ${v.kind === 'short' ? 'Short' : 'Long'}${v.duration_seconds ? ' · ' + fmtDur(Number(v.duration_seconds)) : ''}${v.category_name ? ' · ' + v.category_name : ''}`),
        h('div', { class: 'mono muted small' }, v.public_id)),
      h('td', null, statusPill(v.status), v.featured ? h('span', { class: 'status', style: 'margin-left:4px' }, v.pinned_rank ? `Pinned #${v.pinned_rank}` : 'Featured') : null,
        v.open_reports ? h('div', null, h('a', { href: '#/reports', class: 'status open' }, `${v.open_reports} report${v.open_reports > 1 ? 's' : ''}`)) : null),
      h('td', null, metrics({ views: v.views_count, unique_views: v.unique_views_count, hearts: v.hearts_count, dislikes: v.dislikes_count, comments: v.comments_count, shares: v.shares_count, saves: v.saves_count })),
      h('td', { class: 'muted small' }, fmtDateTime(v.created_at)),
      h('td', null, h('div', { class: 'row wrap' },
        h('a', { class: 'btn sm', href: `#/videos/${v.public_id}` }, 'Review'),
        v.status === 'pending_moderation' ? h('button', { class: 'btn sm primary', onclick: () => quick(v, 'approve') } , 'Approve') : null))));
    host.replaceChildren(table([{ label: '' }, { label: 'Video' }, { label: 'Status' }, { label: 'Metrics (separate)' }, { label: 'Uploaded' }, { label: '' }], rows), pager(r, load));
  }
  const quick = (v, a) => act(() => api.post(`/api/admin/videos/${v.public_id}/${a}`, {}), 'Video published', () => { load(); refreshBadges(); });
  await load();
}

async function videoDetail(id) {
  bodyEl.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  const d = await api.get(`/api/admin/videos/${id}`);
  const v = d.video;
  const reload = () => videoDetail(id);
  const player = v.stream_url ? h('video', { class: 'player', src: v.stream_url, controls: '', preload: 'metadata', poster: v.thumbnail_url || '', style: `aspect-ratio:${v.kind === 'short' ? '9/16' : '16/9'};max-height:460px;width:auto;margin:0 auto` })
    : h('div', { class: 'notice' }, 'No playable file yet.');
  const actions = h('div', { class: 'row wrap', style: 'margin-top:12px' },
    ['pending_moderation', 'rejected'].includes(v.status) ? h('button', { class: 'btn primary sm', onclick: () => act(() => api.post(`/api/admin/videos/${id}/approve`, {}), 'Published', () => { reload(); refreshBadges(); }) }, icon('check'), 'Approve & publish') : null,
    v.status === 'pending_moderation' ? h('button', { class: 'btn sm', onclick: async () => {
      const reason = await confirmDialog({ title: 'Reject this video?', text: 'The creator sees this reason.', confirmText: 'Reject', ask: reasonAsk() });
      if (reason) act(() => api.post(`/api/admin/videos/${id}/reject`, { reason }), 'Rejected', () => { reload(); refreshBadges(); });
    } }, 'Reject') : null,
    v.status !== 'removed' ? h('button', { class: 'btn sm danger', onclick: async () => {
      const reason = await confirmDialog({ title: 'Remove this video?', text: 'It disappears from the platform immediately.', confirmText: 'Remove', danger: true, ask: reasonAsk() });
      if (reason) act(() => api.post(`/api/admin/videos/${id}/remove`, { reason, confirm: true }), 'Removed', reload);
    } }, icon('trash'), 'Remove') : null,
    v.status === 'removed' && v.removed_by === 'admin' ? h('button', { class: 'btn sm', onclick: () => act(() => api.post(`/api/admin/videos/${id}/restore`, {}), 'Restored', reload) }, icon('refresh'), 'Restore') : null,
    v.status === 'published' ? h('button', { class: 'btn sm', onclick: () => act(() => api.post(`/api/admin/videos/${id}/feature`, { featured: !v.featured }), v.featured ? 'Unfeatured' : 'Featured', reload) }, v.featured ? 'Unfeature' : 'Feature') : null,
    v.status === 'published' ? h('button', { class: 'btn sm', onclick: () => pinDialog(v, reload) }, v.pinned_rank ? `Pinned #${v.pinned_rank}` : 'Pin') : null,
    h('button', { class: 'btn sm', onclick: () => editDialog(v, reload) }, icon('edit'), 'Edit metadata'),
    h('a', { class: 'btn sm', href: `/${v.kind === 'short' ? 'shorts' : 'watch'}/${id}`, target: '_blank', rel: 'noopener' }, 'Open on site'));

  const integrity = h('div');
  bodyEl.replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('a', { class: 'btn sm', href: '#/videos' }, icon('back'), 'All videos'), statusPill(v.status)),
    h('div', { class: 'two' },
      h('div', null,
        player, h('h2', { style: 'margin:12px 0 4px;font-size:18px' }, v.title),
        h('div', { class: 'muted small' }, `@${v.channel.handle} · ${v.owner.name} · ${v.owner.email}`),
        actions,
        v.description ? section('Description', h('div', { style: 'white-space:pre-wrap' }, v.description)) : null,
        section('Reports on this video', d.reports.length ? h('ul', { class: 'log' }, d.reports.map((r) => h('li', null,
          h('b', null, r.reason), ' · ', statusPill(r.status), ' · ', h('span', { class: 'muted' }, `${r.target_type} · ${r.reporter_name} · ${fmtDateTime(r.created_at)}`),
          r.details ? h('div', null, r.details) : null))) : h('p', { class: 'muted' }, 'No reports.')),
        section('Moderation history', d.history.length ? h('ul', { class: 'log' }, d.history.map((a) => h('li', null,
          h('b', null, a.action.replace(/_/g, ' ')), h('span', { class: 'muted' }, ` · ${a.admin_name || 'system'} · ${fmtDateTime(a.created_at)}`),
          a.note ? h('div', { class: 'muted' }, a.note) : null))) : h('p', { class: 'muted' }, 'No actions recorded.'))),
      h('div', null,
        section('Metrics (tracked separately)',
          h('dl', { class: 'kv' },
            h('dt', null, 'Total views'), h('dd', null, fmtCount(v.metrics.views)),
            h('dt', null, 'Unique views'), h('dd', null, fmtCount(v.metrics.unique_views)),
            h('dt', null, 'Hearts'), h('dd', null, fmtCount(v.metrics.hearts)),
            h('dt', null, 'Dislikes'), h('dd', null, fmtCount(v.metrics.dislikes)),
            h('dt', null, 'Comments'), h('dd', null, fmtCount(v.metrics.comments)),
            h('dt', null, 'Shares'), h('dd', null, fmtCount(v.metrics.shares)),
            h('dt', null, 'Saves'), h('dd', null, fmtCount(v.metrics.saves)),
            h('dt', null, 'Trending score'), h('dd', null, Number(v.trending_score || 0).toFixed(2))),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Counts come from stored events and reactions. Administrators cannot type new numbers here.'),
          h('div', { class: 'row wrap', style: 'margin-top:8px' },
            h('button', { class: 'btn sm', onclick: () => act(async () => { const r = await api.post(`/api/admin/videos/${id}/recount`, {}); toast(`Recounted: views ${r.before.views}→${r.after.views}`); }, null, reload) }, icon('refresh'), 'Recount from source'),
            h('button', { class: 'btn sm', onclick: () => loadIntegrity() }, 'Check for suspicious activity'))),
        integrity,
        section('Details', h('dl', { class: 'kv' },
          h('dt', null, 'Video ID'), h('dd', { class: 'mono' }, id),
          h('dt', null, 'Kind'), h('dd', null, v.kind === 'short' ? 'Short (9:16)' : 'Long (16:9)'),
          h('dt', null, 'Duration'), h('dd', null, v.duration ? fmtDur(v.duration) : '—'),
          h('dt', null, 'Resolution'), h('dd', null, v.width ? `${v.width}×${v.height}` : '—'),
          h('dt', null, 'File size'), h('dd', null, v.size_bytes ? `${(Number(v.size_bytes) / 1048576).toFixed(1)} MB` : '—'),
          h('dt', null, 'Category'), h('dd', null, v.category?.name || '—'),
          h('dt', null, 'Tags'), h('dd', null, (v.tags || []).join(', ') || '—'),
          h('dt', null, 'Channel status'), h('dd', null, statusLabel(v.channel_status)),
          h('dt', null, 'Published'), h('dd', null, v.published_at ? fmtDateTime(v.published_at) : '—'),
          h('dt', null, 'Uploaded'), h('dd', null, fmtDateTime(v.created_at)))))));

  async function loadIntegrity() {
    integrity.replaceChildren(h('div', { class: 'loading' }, 'Checking…'));
    try {
      const r = await api.get(`/api/admin/videos/${id}/suspicious`);
      const rows = [
        ...r.anonymous_reactions_by_network.map((x) => ({ type: 'ip', key: x.ip_hash, label: `${x.reactions} anonymous reactions from one network` })),
        ...r.repeat_viewers.map((x) => ({ type: 'actor', key: x.actor_key, label: `${x.events} views in 24h from one viewer` })),
      ];
      integrity.replaceChildren(section('Suspicious engagement',
        rows.length ? h('ul', { class: 'log' }, rows.map((x) => h('li', null, h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', null, x.label), h('div', { class: 'mono muted' }, x.key.slice(0, 24) + '…')),
          h('button', { class: 'btn sm danger', onclick: async () => {
            const reason = await confirmDialog({ title: 'Invalidate this engagement?', text: 'Their reactions and view events for this video are deleted and all counters are recomputed. This is recorded in the audit log.', confirmText: 'Invalidate', danger: true, ask: reasonAsk() });
            if (reason) act(() => api.post(`/api/admin/videos/${id}/invalidate`, { type: x.type, key: x.key, reason, confirm: true }), 'Engagement invalidated', reload);
          } }, 'Invalidate'))))) : h('p', { class: 'muted' }, 'Nothing unusual found.')));
    } catch (e) { err(e); integrity.replaceChildren(); }
  }
}

function pinDialog(v, after) {
  openModal((box, close) => {
    const rank = h('input', { class: 'input rank', type: 'number', min: 1, max: 50, value: v.pinned_rank || 1 });
    box.append(h('h3', null, 'Pin this video'), h('p', { class: 'muted' }, 'Pinned videos appear first in Trending and Featured lists. Lower number = higher.'),
      h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, 'Rank'), rank),
      h('div', { class: 'btns' },
        v.pinned_rank ? h('button', { class: 'btn danger', onclick: () => { close(); act(() => api.post(`/api/admin/videos/${v.id}/pin`, { rank: null }), 'Unpinned', after); } }, 'Unpin') : null,
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); act(async () => {
          if (!v.featured) await api.post(`/api/admin/videos/${v.id}/feature`, { featured: true });
          await api.post(`/api/admin/videos/${v.id}/pin`, { rank: Number(rank.value) });
        }, 'Pinned', after); } }, 'Pin')));
  });
}

function editDialog(v, after) {
  openModal((box, close) => {
    const title = input({ value: v.title, maxlength: 100 });
    const desc = h('textarea', { class: 'textarea', maxlength: 5000 }); desc.value = v.description || '';
    const cat = select([['', 'No category'], ...(state.config?.categories || []).map((c) => [c.id, c.name])], (state.config?.categories || []).find((c) => c.slug === v.category?.slug)?.id || '');
    const tags = input({ value: (v.tags || []).join(', ') });
    const note = input({ placeholder: 'Internal note (optional)' });
    box.append(h('h3', null, 'Edit metadata'),
      field('Title', title), field('Description', desc), field('Category', cat), field('Tags', tags), field('Moderation note', note),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); act(() => api.patch(`/api/admin/videos/${v.id}`, {
          title: title.value, description: desc.value, category_id: cat.value || null, tags: tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), note: note.value,
        }), 'Saved', after); } }, 'Save')));
  });
}

async function reports(sub) {
  let status = sub || 'open';
  const host = h('div');
  bodyEl.replaceChildren(h('div', { class: 'tabs' }, ['open', 'investigating', 'actioned', 'dismissed', 'all'].map((s) =>
    h('button', { class: status === s ? 'on' : '', onclick: () => { status = s; go(`reports/${s}`); } }, s[0].toUpperCase() + s.slice(1)))), host);
  async function load(page = 0) {
    host.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
    const r = await api.get('/api/admin/reports' + qs({ status: status === 'all' ? '' : status, page }));
    const rows = r.items.map((x) => h('tr', null,
      h('td', null, h('b', null, x.reason), h('div', { class: 'muted small clamp3', style: 'max-width:260px' }, x.details || '—'), h('div', { class: 'muted small' }, x.target_type === 'comment' ? 'Comment report' : 'Video report')),
      h('td', null, x.video_id ? h('a', { href: `#/videos/${x.video_id}`, style: 'font-weight:600' }, x.video_title) : '—',
        h('div', { class: 'muted small' }, x.channel_handle ? `@${x.channel_handle} · ${statusLabel(x.video_status || '')}` : ''),
        x.comment_body ? h('div', { class: 'small', style: 'margin-top:4px;border-left:2px solid var(--line);padding-left:8px' }, x.comment_body) : null,
        x.channel_actioned_reports > 1 ? h('div', { class: 'status pending', style: 'margin-top:4px' }, `${x.channel_actioned_reports} prior actions on this channel`) : null),
      h('td', null, h('div', null, x.reporter_name), h('div', { class: 'muted small mono' }, x.reporter_email)),
      h('td', null, statusPill(x.status), x.resolution_note ? h('div', { class: 'muted small clamp2' }, x.resolution_note) : null),
      h('td', { class: 'muted small' }, fmtDateTime(x.created_at)),
      h('td', null, h('div', { class: 'row wrap' },
        ['open'].includes(x.status) ? h('button', { class: 'btn sm', onclick: () => act(() => api.post(`/api/admin/reports/${x.id}/investigate`, {}), 'Marked as investigating', () => { load(); refreshBadges(); }) }, 'Investigate') : null,
        ['open', 'investigating'].includes(x.status) ? h('button', { class: 'btn sm', onclick: async () => {
          const note = await confirmDialog({ title: 'Dismiss this report?', confirmText: 'Dismiss', ask: reasonAsk('Why is it invalid?') });
          if (note) act(() => api.post(`/api/admin/reports/${x.id}/dismiss`, { note }), 'Report dismissed', () => { load(); refreshBadges(); });
        } }, 'Dismiss') : null,
        ['open', 'investigating'].includes(x.status) ? h('button', { class: 'btn sm danger', onclick: async () => {
          const note = await confirmDialog({ title: 'Remove the reported content?', text: 'The video or comment is removed immediately.', confirmText: 'Remove content', danger: true, ask: reasonAsk() });
          if (note) act(() => api.post(`/api/admin/reports/${x.id}/action`, { action: 'remove_content', note, confirm: true }), 'Content removed', () => { load(); refreshBadges(); });
        } }, 'Remove content') : null,
        ['open', 'investigating'].includes(x.status) && x.channel_id ? h('button', { class: 'btn sm danger', onclick: async () => {
          const note = await confirmDialog({ title: `Suspend @${x.channel_handle}?`, text: 'Use this for repeat offenders.', confirmText: 'Suspend creator', danger: true, ask: reasonAsk() });
          if (note) act(() => api.post(`/api/admin/reports/${x.id}/action`, { action: 'suspend_creator', note, confirm: true }), 'Creator suspended', () => { load(); refreshBadges(); });
        } }, 'Suspend creator') : null))));
    host.replaceChildren(table([{ label: 'Reason' }, { label: 'Reported content' }, { label: 'Reporter' }, { label: 'Status' }, { label: 'Received' }, { label: '' }], rows), pager(r, load));
  }
  await load();
}

async function popularity() {
  let list = 'trending', kind = '';
  const host = h('div');
  const tabs = h('div', { class: 'tabs' });
  const kindSel = select([['', 'Shorts & long'], ['short', 'Shorts'], ['long', 'Long']], kind);
  kindSel.addEventListener('change', () => { kind = kindSel.value; load(); });
  const LISTS = [['trending', 'Trending'], ['viewed', 'Most viewed'], ['hearted', 'Most hearted'], ['disliked', 'Most disliked'], ['commented', 'Most commented'], ['shared', 'Most shared'], ['featured', 'Admin featured'], ['recent', 'Recent']];
  tabs.replaceChildren(...LISTS.map(([k, l]) => h('button', { class: list === k ? 'on' : '', dataset: { k }, onclick: () => { list = k; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k)); load(); } }, l)));
  bodyEl.replaceChildren(h('div', { class: 'filters' }, kindSel, h('a', { class: 'btn sm', href: '#/settings' }, icon('sliders'), 'Ranking settings')), tabs, host);
  async function load() {
    host.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
    const r = await api.get('/api/admin/popularity' + qs({ list, kind, limit: 25 }));
    const rows = r.items.map((v, i) => h('tr', null,
      h('td', { class: 'num' }, i + 1),
      h('td', null, v.thumbnail_url ? h('img', { class: v.kind === 'short' ? 'thumb-s' : 'thumb-l', src: v.thumbnail_url, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-l ph' }, '—')),
      h('td', null, h('a', { href: `#/videos/${v.id}`, style: 'font-weight:600' }, v.title), h('div', { class: 'muted small' }, `@${v.channel.handle} · ${v.kind}`)),
      h('td', null, metrics(v.metrics)),
      h('td', { class: 'num' }, Number(v.trending_score || 0).toFixed(1)),
      h('td', null, h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: () => act(() => api.post(`/api/admin/videos/${v.id}/feature`, { featured: !v.featured }), v.featured ? 'Unfeatured' : 'Featured', load) }, v.featured ? 'Unfeature' : 'Feature'),
        h('button', { class: 'btn sm', onclick: () => pinDialog({ ...v, pinned_rank: v.pinned_rank }, load) }, v.pinned_rank ? `#${v.pinned_rank}` : 'Pin')))));
    host.replaceChildren(table([{ label: '#', num: true }, { label: '' }, { label: 'Video' }, { label: 'Separate metrics' }, { label: 'Trend', num: true }, { label: '' }], rows));
  }
  await load();
}

async function users(sub) {
  if (sub) return userDetail(sub);
  const f = { q: '', status: '', role: '' };
  const q = input({ placeholder: 'Name, email or handle' });
  const st = select([['', 'All statuses'], ['active', 'Active'], ['suspended', 'Suspended']], '');
  const role = select([['', 'All roles'], ['user', 'Users'], ['moderator', 'Moderators'], ['super_admin', 'Super Admins']], '');
  const host = h('div');
  const apply = () => { f.q = q.value.trim(); f.status = st.value; f.role = role.value; load(0); };
  [st, role].forEach((e) => e.addEventListener('change', apply));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  bodyEl.replaceChildren(h('div', { class: 'filters' }, q, h('button', { class: 'btn sm', onclick: apply }, icon('search'), 'Search'), st, role), host);
  async function load(page = 0) {
    host.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
    const r = await api.get('/api/admin/users' + qs({ ...f, page }));
    const rows = r.items.map((u) => h('tr', null,
      h('td', null, h('a', { href: `#/users/${u.id}`, style: 'font-weight:600' }, u.full_name), h('div', { class: 'muted small mono' }, u.email)),
      h('td', null, u.handle ? h('a', { href: `/c/${u.handle}`, target: '_blank', rel: 'noopener' }, '@' + u.handle) : h('span', { class: 'muted' }, 'No channel'), u.channel_status ? h('div', null, statusPill(u.channel_status)) : null),
      h('td', null, statusPill(u.account_status), u.email_verified_at ? null : h('div', { class: 'muted small' }, 'Email unverified')),
      h('td', null, u.role === 'user' ? h('span', { class: 'muted' }, 'User') : h('b', null, u.role === 'super_admin' ? 'Super Admin' : 'Moderator')),
      h('td', { class: 'num' }, u.video_count || 0),
      h('td', { class: 'muted small' }, fmtDateTime(u.created_at)),
      h('td', null, h('a', { class: 'btn sm', href: `#/users/${u.id}` }, 'Open'))));
    host.replaceChildren(table([{ label: 'User' }, { label: 'Channel' }, { label: 'Status' }, { label: 'Role' }, { label: 'Videos', num: true }, { label: 'Registered' }, { label: '' }], rows), pager(r, load));
  }
  await load();
}

async function userDetail(id) {
  bodyEl.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  const d = await api.get(`/api/admin/users/${id}`);
  const u = d.user;
  const reload = () => userDetail(id);
  bodyEl.replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('a', { class: 'btn sm', href: '#/users' }, icon('back'), 'All users'), statusPill(u.account_status)),
    h('div', { class: 'two' },
      h('div', null,
        section('Account', h('dl', { class: 'kv' },
          h('dt', null, 'Name'), h('dd', null, u.full_name),
          h('dt', null, 'Email'), h('dd', { class: 'mono' }, u.email),
          h('dt', null, 'Email verified'), h('dd', null, u.email_verified_at ? fmtDateTime(u.email_verified_at) : 'No'),
          h('dt', null, 'Role'), h('dd', null, u.role),
          h('dt', null, 'Registered'), h('dd', null, fmtDateTime(u.created_at)),
          h('dt', null, 'Last login'), h('dd', null, u.last_login_at ? fmtDateTime(u.last_login_at) : '—'),
          u.suspended_reason ? h('dt', null, 'Suspension reason') : null, u.suspended_reason ? h('dd', null, u.suspended_reason) : null),
          h('div', { class: 'row wrap', style: 'margin-top:12px' },
            u.account_status === 'active'
              ? h('button', { class: 'btn sm danger', onclick: async () => {
                const reason = await confirmDialog({ title: `Suspend ${u.full_name}?`, text: 'They are logged out everywhere and cannot sign in.', confirmText: 'Suspend', danger: true, ask: reasonAsk() });
                if (reason) act(() => api.post(`/api/admin/users/${id}/suspend`, { reason, confirm: true }), 'User suspended', reload);
              } }, 'Suspend account')
              : h('button', { class: 'btn sm primary', onclick: () => act(() => api.post(`/api/admin/users/${id}/activate`, {}), 'User activated', reload) }, 'Activate account'),
            can('admins') ? h('button', { class: 'btn sm', onclick: () => roleDialog(u, reload) }, 'Change role') : null)),
        d.channel ? section('Channel', h('div', { class: 'row', style: 'margin-bottom:10px' },
          d.channel.avatar_url ? h('img', { class: 'avatar md', src: d.channel.avatar_url, alt: '' }) : h('div', { class: 'avatar md' }, initials(d.channel.name)),
          h('div', null, h('b', null, d.channel.name), h('div', { class: 'muted small' }, '@' + d.channel.handle)), statusPill(d.channel.status)),
          d.channel.bio ? h('p', { class: 'muted', style: 'white-space:pre-wrap' }, d.channel.bio) : null,
          d.channel.telegram_url ? h('p', { class: 'mono small muted' }, d.channel.telegram_url) : null,
          h('div', { class: 'row wrap', style: 'margin-top:10px' },
            d.channel.status !== 'approved' ? h('button', { class: 'btn sm primary', onclick: () => act(() => api.post(`/api/admin/channels/${d.channel.id}/approve`, {}), 'Approved', reload) }, 'Approve creator') : null,
            d.channel.status === 'approved' ? h('button', { class: 'btn sm danger', onclick: async () => {
              const reason = await confirmDialog({ title: 'Suspend this channel?', confirmText: 'Suspend', danger: true, ask: reasonAsk() });
              if (reason) act(() => api.post(`/api/admin/channels/${d.channel.id}/suspend`, { reason, confirm: true }), 'Channel suspended', reload);
            } }, 'Suspend channel') : null,
            h('a', { class: 'btn sm', href: `/c/${d.channel.handle}`, target: '_blank', rel: 'noopener' }, 'View channel'))) : section('Channel', h('p', { class: 'muted' }, 'This user has no channel.'))),
      h('div', null,
        section('Uploaded videos', d.videos.length ? h('ul', { class: 'log' }, d.videos.map((v) => h('li', null,
          h('a', { href: `#/videos/${v.public_id}`, style: 'font-weight:600' }, v.title), ' ', statusPill(v.status),
          h('div', { class: 'muted small' }, `${v.kind} · ${fmtCount(v.views_count)} views · ${fmtCount(v.hearts_count)} hearts`)))) : h('p', { class: 'muted' }, 'No videos.')),
        section('Reports against their content', h('p', null, `${d.reports.against_channel} total`)),
        section('Moderation history', d.history.length ? h('ul', { class: 'log' }, d.history.map((a) => h('li', null,
          h('b', null, a.action.replace(/_/g, ' ')), h('div', { class: 'muted' }, `${a.admin_name || 'system'} · ${fmtDateTime(a.created_at)}`), a.note ? h('div', null, a.note) : null))) : h('p', { class: 'muted' }, 'No actions.')))));
}

function roleDialog(u, after) {
  openModal((box, close) => {
    const sel = select([['user', 'User'], ['moderator', 'Moderator'], ['super_admin', 'Super Admin']], u.role);
    box.append(h('h3', null, 'Change role'), h('p', { class: 'muted' }, 'Moderators can review creators, videos, reports and popularity. Super Admins also manage users, settings, categories and the audit log. The account is logged out everywhere.'),
      h('div', { class: 'field', style: 'margin-top:12px' }, h('label', null, 'Role'), sel),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); act(() => api.post(`/api/admin/users/${u.id}/role`, { role: sel.value, confirm: true }), 'Role updated', after); } }, 'Save')));
  });
}

async function categoriesPage() {
  const host = h('div'), tagHost = h('div');
  bodyEl.replaceChildren(host, tagHost);
  async function load() {
    const r = await api.get('/api/admin/categories');
    const rows = r.items.map((c) => h('tr', null,
      h('td', null, h('b', null, c.name), h('div', { class: 'mono muted small' }, c.slug)),
      h('td', { class: 'num' }, c.sort_order),
      h('td', { class: 'num' }, c.videos),
      h('td', null, c.is_active ? h('span', { class: 'status published' }, 'Active') : h('span', { class: 'status rejected' }, 'Hidden')),
      h('td', null, h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: () => catDialog(c, load) }, icon('edit'), 'Edit'),
        h('button', { class: 'btn sm', onclick: () => act(() => api.patch(`/api/admin/categories/${c.id}`, { is_active: !c.is_active }), 'Updated', load) }, c.is_active ? 'Hide' : 'Show'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          const ok = await confirmDialog({ title: `Delete “${c.name}”?`, text: c.videos ? `${c.videos} published videos will lose this category.` : 'This cannot be undone.', confirmText: 'Delete', danger: true });
          if (ok) act(() => api.del(`/api/admin/categories/${c.id}`, { confirm: true }), 'Category deleted', load);
        } }, icon('trash'), 'Delete')))));
    host.replaceChildren(h('div', { class: 'filters' }, h('button', { class: 'btn sm primary', onclick: () => catDialog(null, load) }, 'Add category')),
      table([{ label: 'Category' }, { label: 'Order', num: true }, { label: 'Videos', num: true }, { label: 'Visible' }, { label: '' }], rows));
  }
  async function loadTags() {
    const r = await api.get('/api/admin/tags');
    tagHost.replaceChildren(section('Tags in use', r.items.length ? h('div', { class: 'chips' }, r.items.map((t) =>
      h('button', { class: 'chip', title: `${t.videos} videos — click to remove this tag everywhere`, onclick: async () => {
        const ok = await confirmDialog({ title: `Remove the tag “${t.tag}”?`, text: `It will be removed from ${t.videos} video(s).`, confirmText: 'Remove tag', danger: true });
        if (ok) act(() => api.post('/api/admin/tags/remove', { tag: t.tag, confirm: true }), 'Tag removed', loadTags);
      } }, `#${t.tag} · ${t.videos}`))) : h('p', { class: 'muted' }, 'No tags yet.')));
  }
  await Promise.all([load(), loadTags()]);
}

function catDialog(c, after) {
  openModal((box, close) => {
    const name = input({ value: c?.name || '', maxlength: 40 });
    const order = h('input', { class: 'input rank', type: 'number', min: 0, max: 999, value: c?.sort_order ?? 100 });
    box.append(h('h3', null, c ? 'Edit category' : 'Add category'), field('Name', name), field('Sort order', order, 'Lower numbers appear first'),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { close(); act(() => c ? api.patch(`/api/admin/categories/${c.id}`, { name: name.value, sort_order: Number(order.value) })
          : api.post('/api/admin/categories', { name: name.value, sort_order: Number(order.value) }), 'Saved', after); } }, 'Save')));
  });
}

async function settingsPage() {
  const { settings: s } = await api.get('/api/admin/settings');
  const save = (key, value, btn) => act(async () => { btn.disabled = true; await api.put(`/api/admin/settings/${key}`, { value }); btn.disabled = false; }, 'Saved');
  const num = (v, props = {}) => h('input', { class: 'input', type: 'number', value: v, ...props });
  const check = (v) => { const i = h('input', { type: 'checkbox' }); i.checked = !!v; return i; };
  const saveBtn = (fn) => { const b = h('button', { class: 'btn primary sm', style: 'margin-top:10px', onclick: () => fn(b) }, 'Save'); return b; };

  // Brand
  const bName = input({ value: s.brand.name, maxlength: 40 }), bTag = input({ value: s.brand.tagline, maxlength: 120 });
  // Telegram
  const tgUrl = input({ value: s.telegram.global_url, placeholder: 'https://t.me/yourchannel' });
  const tgOverride = check(s.telegram.allow_creator_override), tgLock = check(s.telegram.locked);
  // Upload
  const uShortSec = num(s.upload.short_max_seconds, { min: 5, max: 600 }), uShortMb = num(s.upload.short_max_mb, { min: 1, max: 2048 });
  const uLongSec = num(s.upload.long_max_seconds, { min: 30, max: 14400 }), uLongMb = num(s.upload.long_max_mb, { min: 1, max: 10240 });
  const uThumbMb = num(s.upload.thumbnail_max_mb, { min: 0.1, max: 20, step: 0.5 });
  const fmts = ['mp4', 'webm', 'mov'].map((f) => { const i = check(s.upload.allowed_formats.includes(f)); return { f, i, el: h('label', { class: 'row small' }, i, f.toUpperCase()) }; });
  // Moderation
  const mReview = check(s.moderation.require_video_moderation), mComments = check(s.moderation.comments_enabled);
  const mVerify = check(s.moderation.require_email_verification);
  // Trending
  const t = s.trending;
  const tw = { window_hours: num(t.window_hours, { min: 1, max: 720 }), half_life_hours: num(t.half_life_hours, { min: 1, max: 720 }),
    w_views: num(t.w_views, { min: 0, max: 100, step: 0.5 }), w_hearts: num(t.w_hearts, { min: 0, max: 100, step: 0.5 }), w_shares: num(t.w_shares, { min: 0, max: 100, step: 0.5 }),
    w_comments: num(t.w_comments, { min: 0, max: 100, step: 0.5 }), w_dislikes: num(t.w_dislikes, { min: 0, max: 100, step: 0.5 }), w_engagement: num(t.w_engagement, { min: 0, max: 100, step: 0.5 }) };
  // Ads
  const aReserve = check(s.ads.reserve_space), aLabel = check(s.ads.show_label), aW = num(s.ads.width, { min: 160, max: 400 }), aH = num(s.ads.min_height, { min: 100, max: 1200 });
  const aSlot = input({ value: s.ads.slot_id, placeholder: 'Your ad slot id (optional)' });
  // Policies
  const pContent = h('textarea', { class: 'textarea', maxlength: 5000 }); pContent.value = s.policies.content_policy;
  const pGuide = h('textarea', { class: 'textarea', maxlength: 5000 }); pGuide.value = s.policies.community_guidelines;

  bodyEl.replaceChildren(
    section('Platform branding', h('div', { class: 'setting-grid' }, field('Name', bName), field('Tagline', bTag)),
      saveBtn((b) => save('brand', { name: bName.value, tagline: bTag.value }, b))),
    section('Telegram', h('p', { class: 'muted small', style: 'margin-bottom:10px' }, 'Resolution order: a locked global link always wins; otherwise a creator’s own link (if overrides are allowed and they enabled it); otherwise the global link; otherwise the button is hidden.'),
      field('Global Telegram link', tgUrl, 'Only https://t.me/… links are accepted. Leave empty for none.'),
      h('label', { class: 'toggle' }, tgOverride, 'Allow creators to use their own Telegram link'),
      h('label', { class: 'toggle' }, tgLock, 'Lock the global link (creator links are ignored)'),
      saveBtn((b) => save('telegram', { global_url: tgUrl.value.trim(), allow_creator_override: tgOverride.checked, locked: tgLock.checked }, b))),
    section('Upload limits', h('div', { class: 'setting-grid' },
      field('Short max duration (seconds)', uShortSec), field('Short max size (MB)', uShortMb),
      field('Long max duration (seconds)', uLongSec), field('Long max size (MB)', uLongMb), field('Thumbnail max size (MB)', uThumbMb)),
      h('div', { class: 'field' }, h('label', null, 'Allowed video formats'), h('div', { class: 'row wrap' }, fmts.map((x) => x.el))),
      saveBtn((b) => save('upload', { short_max_seconds: +uShortSec.value, short_max_mb: +uShortMb.value, long_max_seconds: +uLongSec.value, long_max_mb: +uLongMb.value,
        thumbnail_max_mb: +uThumbMb.value, allowed_formats: fmts.filter((x) => x.i.checked).map((x) => x.f) }, b))),
    section('Moderation',
      h('label', { class: 'toggle' }, mReview, 'Every new upload must be approved before it is published'),
      h('label', { class: 'toggle' }, mVerify, 'Require a verified email address before creating a channel or commenting'),
      h('p', { class: 'muted small', style: 'margin:-4px 0 8px 26px' }, 'Leave this off until SMTP is configured, otherwise nobody can get past sign-up. Creator approval still gates uploading either way.'),
      h('label', { class: 'toggle' }, mComments, 'Comments enabled platform-wide'),
      saveBtn((b) => save('moderation', { require_video_moderation: mReview.checked, require_email_verification: mVerify.checked, comments_enabled: mComments.checked }, b))),
    section('Trending & ranking', h('p', { class: 'muted small', style: 'margin-bottom:10px' }, 'Score = (views×w + hearts×w + shares×w + comments×w − dislikes×w) × engagement bonus × time decay. The window limits which activity counts; the half-life controls how fast older videos fade, so old videos cannot dominate.'),
      h('div', { class: 'setting-grid' }, field('Time window (hours)', tw.window_hours), field('Half-life (hours)', tw.half_life_hours),
        field('Weight: views', tw.w_views), field('Weight: hearts', tw.w_hearts), field('Weight: shares', tw.w_shares),
        field('Weight: comments', tw.w_comments), field('Penalty: dislikes', tw.w_dislikes), field('Engagement-rate bonus', tw.w_engagement)),
      saveBtn((b) => save('trending', Object.fromEntries(Object.entries(tw).map(([k, el]) => [k, Number(el.value)])), b))),
    section('Advertisement area', h('p', { class: 'muted small', style: 'margin-bottom:10px' }, 'A reserved empty column on desktop watch pages. It never shows recommended videos and stays empty until you integrate an ad provider.'),
      h('label', { class: 'toggle' }, aReserve, 'Reserve the right-hand ad column on desktop'),
      h('label', { class: 'toggle' }, aLabel, 'Show an “Advertisement” label'),
      h('div', { class: 'setting-grid' }, field('Width (px)', aW), field('Minimum height (px)', aH), field('Slot id', aSlot)),
      saveBtn((b) => save('ads', { reserve_space: aReserve.checked, show_label: aLabel.checked, width: +aW.value, min_height: +aH.value, slot_id: aSlot.value.trim() }, b))),
    section('User and content policies', field('Content policy', pContent), field('Community guidelines', pGuide),
      saveBtn((b) => save('policies', { content_policy: pContent.value, community_guidelines: pGuide.value }, b))));
}

async function audit() {
  const q = input({ placeholder: 'Target id, admin email or name' });
  const action = input({ placeholder: 'Action, e.g. video.remove' });
  const host = h('div');
  const apply = () => load(0);
  [q, action].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); }));
  bodyEl.replaceChildren(h('div', { class: 'filters' }, q, action, h('button', { class: 'btn sm', onclick: apply }, icon('search'), 'Filter')), host);
  async function load(page = 0) {
    host.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
    const r = await api.get('/api/admin/audit' + qs({ q: q.value.trim(), action: action.value.trim(), page }));
    const rows = r.items.map((a) => h('tr', null,
      h('td', { class: 'muted small' }, fmtDateTime(a.created_at)),
      h('td', null, h('b', null, a.action)),
      h('td', null, a.actor_name || h('span', { class: 'muted' }, 'system'), a.actor_email ? h('div', { class: 'muted small mono' }, a.actor_email) : null),
      h('td', null, a.target_type ? h('div', null, a.target_type) : '—', a.target_id ? h('div', { class: 'mono muted small' }, a.target_id) : null),
      h('td', null, Object.keys(a.metadata || {}).length ? h('details', null, h('summary', { class: 'muted small' }, 'details'), h('pre', { class: 'json' }, JSON.stringify(a.metadata, null, 2))) : h('span', { class: 'muted' }, '—'))));
    host.replaceChildren(table([{ label: 'When' }, { label: 'Action' }, { label: 'Administrator' }, { label: 'Target' }, { label: 'Data' }], rows), pager(r, load));
  }
  await load();
}

const VIEWS = { dashboard, creators, videos: videosPage, reports, popularity, users, categories: categoriesPage, settings: settingsPage, audit };

async function render() {
  if (!state.config) { try { state.config = await api.get('/api/config'); } catch { /* optional */ } }
  if (!S.admin) {
    try {
      const me = await api.get('/api/admin/auth/me');
      if (!me.admin) {
        let setup = false;
        try { setup = (await api.get('/api/admin/bootstrap')).available; } catch { /* older server */ }
        return setup ? setupView() : loginView();
      }
      S.admin = me.admin; S.perms = me.permissions; state.adminCsrf = me.csrf_token;
    } catch { return loginView(); }
  }
  shell();
  const [key, sub] = route();
  const def = PAGES.find(([, , , p]) => can(p));
  const entry = PAGES.find(([k, , , p]) => k === key && can(p)) || def;
  if (!entry) { bodyEl.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'No access'), h('p', null, 'Your role has no permissions.'))); return; }
  titleEl.textContent = entry[1];
  document.title = `${entry[1]} · ${BRAND()} Admin`;
  sideEl.querySelectorAll('a[data-key]').forEach((a) => a.classList.toggle('on', a.dataset.key === entry[0]));
  refreshBadges();
  try { await VIEWS[entry[0]](sub); } catch (e) {
    if (e instanceof ApiError && e.status === 401) { S.admin = null; return loginView(); }
    bodyEl.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'Could not load this page'), h('p', null, e.message)));
  }
}

window.addEventListener('hashchange', render);
render();
