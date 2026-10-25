import { h, icon, setTitle, toast, fmtCount, statusPill } from '../util.js';
import { api, state, refreshMe } from '../api.js';
import { navigate } from '../router.js';
import { emptyState } from '../cards.js';
import { studioTabs } from '../creatorNav.js';

const STATUS_HELP = {
  pending: 'Your creator application is Pending Review. An administrator will approve or reject it. You cannot upload until it is approved.',
  approved: 'Your channel is Approved. You can upload Shorts and long videos.',
  rejected: 'Your creator application was Rejected. You can update your channel details and resubmit.',
  suspended: 'Your channel is Suspended. Uploads are disabled.',
};

export default async function studio({ root }) {
  setTitle('Creator studio');
  if (!state.user) { navigate('/login?next=/studio', { replace: true }); return; }
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
  if (ch.status === 'approved') page.append(studioTabs('dashboard'));
  page.append(h('div', { class: `notice ${ch.status === 'approved' ? 'good' : ch.status === 'pending' ? 'warn' : 'bad'}`, style: 'margin-bottom:16px' },
    h('div', { class: 'row wrap' }, statusPill(ch.status), h('b', null, `${ch.name} · @${ch.handle}`)),
    h('p', { style: 'margin-top:6px' }, STATUS_HELP[ch.status]),
    ch.status_reason ? h('p', { class: 'muted', style: 'margin-top:4px' }, `Reason: ${ch.status_reason}`) : null,
    h('div', { class: 'row wrap', style: 'margin-top:10px' },
      ch.status === 'approved' ? h('a', { class: 'btn primary sm', href: '/upload' }, icon('upload'), 'Upload') : null,
      ch.status === 'approved' ? h('a', { class: 'btn sm', href: '/studio/videos' }, icon('film'), 'Manage videos') : null,
      h('a', { class: 'btn sm', href: '/studio/channel' }, icon('edit'), ch.status === 'rejected' ? 'Edit & resubmit' : 'Edit channel'),
      ch.status === 'approved' ? h('a', { class: 'btn sm', href: `/c/${ch.handle}` }, 'View channel') : null)));

  const statsHost = h('div', { class: 'stat-grid', style: 'margin-bottom:22px' });
  page.append(statsHost);
  try {
    const t = (await api.get('/api/me/channel/stats')).totals;
    if (t) {
      const cells = [['Videos', t.videos], ['Published', t.published], ['Views', t.views], ['Unique views', t.unique_views], ['Hearts', t.hearts], ['Dislikes', t.dislikes], ['Comments', t.comments], ['Shares', t.shares], ['Saves', t.saves]];
      statsHost.replaceChildren(...cells.map(([l, x]) => h('div', { class: 'stat' }, h('b', null, fmtCount(x)), h('span', null, l))));
    }
  } catch { /* ignore */ }
  if (ch.status === 'approved') page.append(h('a', { class: 'btn primary', href: '/studio/videos' }, icon('film'), 'Go to your videos'));
}
