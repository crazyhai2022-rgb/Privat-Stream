import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { wrap, badRequest, unauthorized, forbidden, conflict, HttpError } from '../lib/errors.js';
import { hashPassword, verifyPassword, dummyVerify } from '../lib/password.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { limiter, requireAuth } from '../middleware/core.js';
import { createSession, destroySession, revokeAllSessions } from '../services/sessions.js';
import { sendMail } from '../services/mail.js';
import { audit } from '../services/audit.js';
import { userDto, channelDto, canUpload } from '../services/serializers.js';

const r = Router();

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Password must be at least 10 characters').max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Password must contain letters and numbers');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

async function issueEmailToken(userId, type, ttlHours) {
  const token = randomToken(32);
  await db.query('update email_tokens set used_at = now() where user_id = $1 and type = $2 and used_at is null', [userId, type]);
  await db.query(
    `insert into email_tokens (user_id, type, token_hash, expires_at) values ($1,$2,$3, now() + make_interval(hours => $4::int))`,
    [userId, type, sha256(token), ttlHours],
  );
  return token;
}

async function sendVerification(user) {
  const token = await issueEmailToken(user.id, 'verify_email', 48);
  const link = `${config.baseUrl}/verify-email?token=${token}`;
  await sendMail({ to: user.email, subject: 'Verify your email address', link,
    text: `Hi ${user.full_name},\n\nConfirm your email address to finish setting up your account:\n${link}\n\nThis link expires in 48 hours. If you did not sign up, you can ignore this message.` });
}

export async function meSummary(req) {
  const channel = await db.one('select * from channels where user_id = $1', [req.user.id]);
  return {
    user: userDto(req.user),
    channel: channelDto(channel),
    can_upload: canUpload(req.user, channel),
    csrf_token: req.session?.csrf_token,
  };
}

r.post('/register', limiter({ windowMs: 3600e3, max: 15, message: 'Too many sign-ups from this network. Try again later.' }), wrap(async (req, res) => {
  const body = z.object({
    full_name: z.string().trim().min(2).max(80),
    email,
    password,
    password_confirm: z.string(),
  }).parse(req.body);
  if (body.password !== body.password_confirm) throw badRequest('Passwords do not match');
  if (body.password.toLowerCase().includes(body.email.split('@')[0]) && body.email.split('@')[0].length > 3) throw badRequest('Password must not contain your email name');
  const exists = await db.one('select 1 from users where lower(email) = $1', [body.email]);
  if (exists) throw conflict('An account with this email already exists', 'email_taken');
  const hash = await hashPassword(body.password);
  const user = await db.one(
    'insert into users (email, full_name, password_hash) values ($1,$2,$3) returning *', [body.email, body.full_name, hash],
  );
  await sendVerification(user);
  await audit(req, 'user.register', 'user', user.id, {}, user.id);
  // Not logged in until the user signs in; verification is required before creating a channel.
  res.status(201).json({ ok: true, message: 'Account created. Check your email to verify your address.' });
}));

r.post('/verify-email', limiter({ windowMs: 900e3, max: 30 }), wrap(async (req, res) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
  const row = await db.one(
    `select * from email_tokens where token_hash = $1 and type = 'verify_email' and used_at is null and expires_at > now()`, [sha256(token)],
  );
  if (!row) throw badRequest('This verification link is invalid or has expired');
  await db.tx(async (q) => {
    await q('update users set email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1', [row.user_id]);
    await q('update email_tokens set used_at = now() where id = $1', [row.id]);
  });
  await audit(req, 'user.verify_email', 'user', row.user_id, {}, row.user_id);
  res.json({ ok: true });
}));

r.post('/resend-verification', requireAuth, limiter({ windowMs: 3600e3, max: 5 }), wrap(async (req, res) => {
  if (req.user.email_verified_at) return res.json({ ok: true });
  await sendVerification(req.user);
  res.json({ ok: true });
}));

r.post('/login', limiter({ windowMs: 15 * 60e3, max: 30, message: 'Too many login attempts. Please wait a few minutes.' }), wrap(async (req, res) => {
  const body = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
  const user = await db.one('select * from users where lower(email) = $1', [body.email]);
  if (!user) { await dummyVerify(body.password); throw unauthorized('Incorrect email or password'); }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.', 'account_locked');
  }
  const ok = await verifyPassword(user.password_hash, body.password);
  if (!ok) {
    const fails = user.failed_logins + 1;
    await db.query(
      `update users set failed_logins = $2::int,
              locked_until = case when $2::int >= $3::int then now() + make_interval(mins => $4::int) else null end
        where id = $1`,
      [user.id, fails, MAX_FAILS, LOCK_MINUTES]);
    await audit(req, 'auth.login_failed', 'user', user.id, { fails }, user.id);
    throw unauthorized('Incorrect email or password');
  }
  if (user.account_status !== 'active') throw forbidden('This account has been suspended', 'account_suspended');
  await db.query('update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [user.id]);
  const { csrf } = await createSession(req, res, user.id, 'user');
  req.user = user; req.session = { csrf_token: csrf };
  await audit(req, 'auth.login', 'user', user.id, {}, user.id);
  res.json(await meSummary(req));
}));

r.post('/logout', wrap(async (req, res) => {
  await destroySession(req, res, 'user');
  res.json({ ok: true });
}));

r.get('/me', wrap(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json(await meSummary(req));
}));

r.post('/forgot-password', limiter({ windowMs: 3600e3, max: 8 }), wrap(async (req, res) => {
  const { email: e } = z.object({ email }).parse(req.body);
  const user = await db.one('select * from users where lower(email) = $1', [e]);
  if (user && user.account_status === 'active') {
    const token = await issueEmailToken(user.id, 'reset_password', 1);
    const link = `${config.baseUrl}/reset-password?token=${token}`;
    await sendMail({ to: user.email, subject: 'Reset your password', link,
      text: `Hi ${user.full_name},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not request this, you can ignore this email.` });
    await audit(req, 'auth.password_reset_requested', 'user', user.id, {}, user.id);
  }
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
}));

r.post('/reset-password', limiter({ windowMs: 900e3, max: 20 }), wrap(async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(200), password }).parse(req.body);
  const row = await db.one(
    `select * from email_tokens where token_hash = $1 and type = 'reset_password' and used_at is null and expires_at > now()`, [sha256(body.token)],
  );
  if (!row) throw badRequest('This reset link is invalid or has expired');
  const hash = await hashPassword(body.password);
  await db.tx(async (q) => {
    await q('update users set password_hash = $2, failed_logins = 0, locked_until = null, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1', [row.user_id, hash]);
    await q('update email_tokens set used_at = now() where id = $1', [row.id]);
    await q('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [row.user_id]);
  });
  await audit(req, 'auth.password_reset', 'user', row.user_id, {}, row.user_id);
  res.json({ ok: true });
}));

r.patch('/profile', requireAuth, wrap(async (req, res) => {
  const body = z.object({ full_name: z.string().trim().min(2).max(80) }).parse(req.body);
  await db.query('update users set full_name = $2, updated_at = now() where id = $1', [req.user.id, body.full_name]);
  req.user.full_name = body.full_name;
  res.json(await meSummary(req));
}));

r.post('/change-password', requireAuth, limiter({ windowMs: 900e3, max: 10 }), wrap(async (req, res) => {
  const body = z.object({ current_password: z.string().max(128), new_password: password }).parse(req.body);
  const u = await db.one('select password_hash from users where id = $1', [req.user.id]);
  if (!(await verifyPassword(u.password_hash, body.current_password))) throw badRequest('Current password is incorrect');
  await db.query('update users set password_hash = $2, updated_at = now() where id = $1', [req.user.id, await hashPassword(body.new_password)]);
  await revokeAllSessions(req.user.id, req.session.id);
  await audit(req, 'auth.password_changed', 'user', req.user.id);
  res.json({ ok: true });
}));

r.post('/logout-everywhere', requireAuth, wrap(async (req, res) => {
  await revokeAllSessions(req.user.id);
  await destroySession(req, res, 'user');
  res.json({ ok: true });
}));

export default r;
