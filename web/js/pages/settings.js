import { h, icon, setTitle, toast, fmtDate } from '../util.js';
import { api, state, applyMe, logout } from '../api.js';
import { navigate } from '../router.js';

export default async function settings({ root }) {
  setTitle('Settings');
  if (!state.user) { navigate('/login?next=/settings', { replace: true }); return; }
  const u = state.user;
  const page = h('div', { class: 'page narrow' }, h('h1', { class: 'title', style: 'margin-bottom:14px' }, 'Settings'));
  root.append(page);

  const msg = (el, text, ok) => { el.textContent = text; el.className = ok ? 'ok-msg' : 'err'; el.hidden = false; };

  // Profile
  const name = h('input', { class: 'input', id: 'sname', value: u.full_name, maxlength: 80 });
  const pmsg = h('div', { hidden: true });
  page.append(h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { class: 'sec', style: 'margin-bottom:10px' }, 'Account'),
    h('div', { class: 'field' }, h('label', { for: 'sname' }, 'Full name'), name),
    h('div', { class: 'field' }, h('label', null, 'Email'), h('div', { class: 'row wrap' }, h('span', null, u.email), u.email_verified ? h('span', { class: 'status published' }, 'Verified') : h('span', { class: 'status pending' }, 'Not verified'),
      u.email_verified ? null : h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api.post('/api/auth/resend-verification'); toast('Verification email sent'); } catch (er) { toast(er.message, 'bad'); } e.target.disabled = false; } }, 'Resend'))),
    h('div', { class: 'muted small', style: 'margin-bottom:10px' }, `Member since ${fmtDate(u.created_at)}`), pmsg,
    h('button', { class: 'btn primary sm', onclick: async () => { try { applyMe(await api.patch('/api/auth/profile', { full_name: name.value })); msg(pmsg, 'Saved', true); } catch (e) { msg(pmsg, e.message, false); } } }, 'Save')));

  // Password
  const cur = h('input', { class: 'input', id: 'cur', type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { class: 'input', id: 'nw', type: 'password', autocomplete: 'new-password' });
  const wmsg = h('div', { hidden: true });
  page.append(h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { class: 'sec', style: 'margin-bottom:10px' }, 'Password'),
    h('div', { class: 'field' }, h('label', { for: 'cur' }, 'Current password'), cur),
    h('div', { class: 'field' }, h('label', { for: 'nw' }, 'New password'), nw, h('div', { class: 'hint' }, 'At least 10 characters with letters and numbers. Changing it logs out your other devices.')), wmsg,
    h('button', { class: 'btn primary sm', onclick: async () => { try { await api.post('/api/auth/change-password', { current_password: cur.value, new_password: nw.value }); cur.value = ''; nw.value = ''; msg(wmsg, 'Password updated', true); } catch (e) { msg(wmsg, e.message, false); } } }, 'Update password')));

  // Channel & session
  page.append(h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { class: 'sec', style: 'margin-bottom:10px' }, 'Creator'),
    state.channel ? h('p', { class: 'muted', style: 'margin-bottom:10px' }, `${state.channel.name} (@${state.channel.handle}) · ${state.channel.status}`) : h('p', { class: 'muted', style: 'margin-bottom:10px' }, 'You have not created a channel yet.'),
    h('div', { class: 'row wrap' }, h('a', { class: 'btn sm', href: state.channel ? '/studio/channel' : '/channel/setup' }, icon('edit'), state.channel ? 'Edit channel' : 'Create channel'), h('a', { class: 'btn sm', href: '/studio' }, 'Creator studio'))));
  page.append(h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { class: 'sec', style: 'margin-bottom:10px' }, 'Sessions'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn sm', onclick: async () => { await logout(); navigate('/'); } }, icon('logout'), 'Log out'),
      h('button', { class: 'btn sm danger', onclick: async () => { try { await api.post('/api/auth/logout-everywhere'); applyMe(null); navigate('/login'); } catch (e) { toast(e.message, 'bad'); } } }, 'Log out of all devices'))));

  const pol = state.config.policies || {};
  page.append(h('section', { class: 'card' }, h('h2', { class: 'sec', style: 'margin-bottom:10px' }, 'Policies'),
    h('h3', { style: 'font-size:14px' }, 'Content policy'), h('p', { class: 'muted', style: 'margin:4px 0 12px;white-space:pre-wrap' }, pol.content_policy),
    h('h3', { style: 'font-size:14px' }, 'Community guidelines'), h('p', { class: 'muted', style: 'margin-top:4px;white-space:pre-wrap' }, pol.community_guidelines)));
}
