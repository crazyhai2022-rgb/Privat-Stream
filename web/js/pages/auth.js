import { h, setTitle, toast, passwordInput } from '../util.js';
import { api, applyMe, state } from '../api.js';
import { navigate } from '../router.js';

function field(label, el, hint) {
  const target = el.input || el; // password boxes are wrapped with their show/hide control
  return h('div', { class: 'field' }, h('label', { for: target.id }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
}
const nextUrl = (query) => {
  const n = query.get('next') || '/';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
};

function formPage(root, { title, intro, fields, submitText, onSubmit, footer }) {
  const err = h('div', { class: 'err', role: 'alert', hidden: true });
  const ok = h('div', { class: 'ok-msg', role: 'status', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;height:42px' }, submitText);
  const form = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.hidden = true; ok.hidden = true; btn.disabled = true;
    try { await onSubmit({ error: (m) => { err.textContent = m; err.hidden = false; }, success: (m) => { ok.textContent = m; ok.hidden = false; } }); }
    catch (er) { err.textContent = er.message; err.hidden = false; }
    btn.disabled = false;
  } }, ...fields, err, ok, btn);
  root.append(h('div', { class: 'page form' }, h('h1', { class: 'title', style: 'margin-bottom:6px' }, title), intro ? h('p', { class: 'muted', style: 'margin-bottom:16px' }, intro) : null, form,
    footer ? h('p', { class: 'muted', style: 'margin-top:14px;text-align:center' }, footer) : null));
}

export function login({ root, query }) {
  setTitle('Log in');
  if (state.user) { navigate(nextUrl(query), { replace: true }); return; }
  const email = h('input', { class: 'input', id: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const pwWrap = passwordInput({ id: 'pw', autocomplete: 'current-password', required: true, maxlength: 128 });
  const pw = pwWrap.input;
  formPage(root, {
    title: 'Log in', fields: [field('Email', email), field('Password', pwWrap)], submitText: 'Log in',
    footer: [h('a', { href: '/forgot-password', style: 'text-decoration:underline' }, 'Forgot password?'), ' · ', h('a', { href: `/register${location.search}`, style: 'text-decoration:underline' }, 'Create an account')],
    onSubmit: async ({ error }) => {
      if (!email.value || !pw.value) return error('Enter your email and password');
      applyMe(await api.post('/api/auth/login', { email: email.value, password: pw.value }));
      navigate(nextUrl(query), { replace: true });
    },
  });
}

export function register({ root, query }) {
  setTitle('Create account');
  if (state.user) { navigate('/', { replace: true }); return; }
  const name = h('input', { class: 'input', id: 'name', autocomplete: 'name', required: true, maxlength: 80 });
  const email = h('input', { class: 'input', id: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const pwWrap = passwordInput({ id: 'pw', autocomplete: 'new-password', required: true, maxlength: 128 });
  const pw2Wrap = passwordInput({ id: 'pw2', autocomplete: 'new-password', required: true, maxlength: 128 });
  const pw = pwWrap.input, pw2 = pw2Wrap.input;
  formPage(root, {
    title: 'Create your account', intro: 'Free to watch. An account lets you save videos, comment and become a creator.',
    fields: [field('Full name', name), field('Email', email), field('Password', pwWrap, 'At least 10 characters with letters and numbers'), field('Confirm password', pw2Wrap)],
    submitText: 'Create account',
    footer: ['Already have an account? ', h('a', { href: `/login${location.search}`, style: 'text-decoration:underline' }, 'Log in')],
    onSubmit: async ({ error }) => {
      if (pw.value !== pw2.value) return error('Passwords do not match');
      await api.post('/api/auth/register', { full_name: name.value, email: email.value, password: pw.value, password_confirm: pw2.value });
      root.replaceChildren(h('div', { class: 'page form' }, h('div', { class: 'card' }, h('h1', { class: 'title' }, 'Check your email'),
        h('p', { class: 'muted', style: 'margin:8px 0 14px' }, `We sent a verification link to ${email.value}. Open it to activate your account, then log in.`),
        h('a', { class: 'btn primary', href: `/login${query.get('next') ? '?next=' + encodeURIComponent(query.get('next')) : ''}` }, 'Go to log in'))));
    },
  });
}

export async function verify({ root, query }) {
  setTitle('Verify email');
  const token = query.get('token');
  const box = h('div', { class: 'card' }, h('h1', { class: 'title' }, 'Verifying your email…'));
  root.append(h('div', { class: 'page form' }, box));
  const show = (title, text, ok) => box.replaceChildren(h('h1', { class: 'title' }, title), h('p', { class: ok ? 'ok-msg' : 'err', style: 'margin:8px 0 14px' }, text),
    h('a', { class: 'btn primary', href: state.user ? '/studio' : '/login' }, state.user ? 'Continue' : 'Log in'));
  if (!token) return show('Missing link', 'This verification link is incomplete.', false);
  try { await api.post('/api/auth/verify-email', { token }); const me = await api.get('/api/auth/me'); if (me.user) applyMe(me); show('Email verified', 'Your email address is confirmed.', true); }
  catch (e) { show('Could not verify', e.message, false); }
}

export function forgot({ root }) {
  setTitle('Forgot password');
  const email = h('input', { class: 'input', id: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  formPage(root, {
    title: 'Reset your password', intro: 'Enter your email and we will send you a reset link.', fields: [field('Email', email)], submitText: 'Send reset link',
    footer: h('a', { href: '/login', style: 'text-decoration:underline' }, 'Back to log in'),
    onSubmit: async ({ success }) => { const r = await api.post('/api/auth/forgot-password', { email: email.value }); success(r.message); },
  });
}

export function reset({ root, query }) {
  setTitle('Choose a new password');
  const token = query.get('token') || '';
  const pwWrap = passwordInput({ id: 'pw', autocomplete: 'new-password', required: true, maxlength: 128 });
  const pw2Wrap = passwordInput({ id: 'pw2', autocomplete: 'new-password', required: true, maxlength: 128 });
  const pw = pwWrap.input, pw2 = pw2Wrap.input;
  formPage(root, {
    title: 'Choose a new password', fields: [field('New password', pwWrap, 'At least 10 characters with letters and numbers'), field('Confirm password', pw2Wrap)], submitText: 'Update password',
    onSubmit: async ({ error }) => {
      if (pw.value !== pw2.value) return error('Passwords do not match');
      await api.post('/api/auth/reset-password', { token, password: pw.value });
      toast('Password updated. Please log in.');
      navigate('/login', { replace: true });
    },
  });
}
