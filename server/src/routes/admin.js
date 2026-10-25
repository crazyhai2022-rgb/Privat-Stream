import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { wrap, badRequest, notFound, forbidden, conflict, unauthorized } from '../lib/errors.js';
import { requireAdmin, limiter } from '../middleware/core.js';
import { verifyPassword, dummyVerify } from '../lib/password.js';
import { createSession, destroySession, revokeAllSessions } from '../services/sessions.js';
import { audit, recordModeration } from '../services/audit.js';
import { getSettings, setSetting, SETTING_SCHEMAS, DEFAULTS } from '../services/settings.js';
import { normalizeTelegramUrl } from '../services/telegram.js';
import { listVideos, videoDto, getVideoRowByPublicId, recountVideo, trendingScoreFor, SORTS } from '../services/videos.js';
import { imageUrl } from '../services/serializers.js';
import { getStorage } from '../storage/index.js';

const r = Router();

const confirmed = (req) => { if (req.body?.confirm !== true) throw badRequest('Please confirm this action', { code: 'confirmation_required' }); };
const paging = (req, def = 25) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || def, 1), 100);
  const page = Math.max(Number(req.query.page) || 0, 0);
  return { limit, page, offset: page * limit };
};
const note = z.string().trim().max(1000).optional().default('');
const reasonRequired = z.string().trim().min(3, 'A reason is required').max(1000);
const like = (s) => `%${String(s).replace(/[%_\\]/g, (m) => '\\' + m)}%`;

// ---------------- First-administrator bootstrap ----------------
// Available only while no Super Admin exists AND ADMIN_BOOTSTRAP_TOKEN is set, so it closes
// itself the moment it has been used. For hosts without a shell; prefer `npm run create-admin`.
// Tells the panel whether to show its first-time setup form. It reveals only that setup is
// still pending; creating the account still needs the token.
r.get('/bootstrap', wrap(async (req, res) => {
  const { config } = await import('../config.js');
  const { n } = await db.one(`select count(*)::int as n from users where role = 'super_admin'`);
  res.json({ available: !!(config.adminBootstrapToken && config.adminBootstrapToken.length >= 24) && n === 0 });
}));

r.post('/bootstrap', limiter({ windowMs: 15 * 60e3, max: 5, message: 'Too many attempts.' }), wrap(async (req, res) => {
  const { config } = await import('../config.js');
  const token = config.adminBootstrapToken;
  const notFoundErr = notFound('Not found');
  if (!token || token.length < 24) throw notFoundErr;
  const { n } = await db.one(`select count(*)::int as n from users where role = 'super_admin'`);
  if (n > 0) throw notFoundErr; // already bootstrapped: behave as if the route does not exist

  const body = z.object({
    token: z.string().max(200),
    email: z.string().trim().toLowerCase().email().max(254),
    full_name: z.string().trim().min(2).max(80),
    password: z.string().min(12, 'Use at least 12 characters').max(128)
      .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Use letters and numbers'),
  }).parse(req.body);

  const { safeEqual } = await import('../lib/crypto.js');
  if (!safeEqual(body.token, token)) {
    await audit(req, 'admin.bootstrap_denied', 'user', null, {}, null);
    throw notFoundErr;
  }

  const { hashPassword } = await import('../lib/password.js');
  const existing = await db.one('select id from users where lower(email) = $1', [body.email]);
  let id;
  if (existing) {
    await db.query(`update users set role = 'super_admin', full_name = $2, password_hash = $3,
                      email_verified_at = coalesce(email_verified_at, now()), account_status = 'active',
                      failed_logins = 0, locked_until = null, updated_at = now() where id = $1`,
      [existing.id, body.full_name, await hashPassword(body.password)]);
    id = existing.id;
  } else {
    const u = await db.one(
      `insert into users (email, full_name, password_hash, role, email_verified_at)
       values ($1,$2,$3,'super_admin', now()) returning id`,
      [body.email, body.full_name, await hashPassword(body.password)]);
    id = u.id;
  }
  await audit(req, 'admin.bootstrap', 'user', id, { email: body.email, promoted: !!existing }, id);
  res.status(201).json({ ok: true, message: 'Super Admin created. Remove ADMIN_BOOTSTRAP_TOKEN and restart, then log in.' });
}));

// ---------------- Admin authentication (separate session scope + cookie) ----------------
r.post('/auth/login', limiter({ windowMs: 15 * 60e3, max: 10, message: 'Too many admin login attempts.' }), wrap(async (req, res) => {
  const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(128) }).parse(req.body);
  const user = await db.one('select * from users where lower(email) = $1', [body.email]);
  const generic = unauthorized('Incorrect email or password');
  if (!user) { await dummyVerify(body.password); throw generic; }
  if (user.locked_until && new Date(user.locked_until) > new Date()) throw forbidden('Account temporarily locked', 'account_locked');
  const ok = await verifyPassword(user.password_hash, body.password);
  if (!ok) {
    await db.query(
      `update users set failed_logins = failed_logins + 1,
              locked_until = case when failed_logins + 1 >= 5 then now() + interval '15 minutes' else null end
        where id = $1`, [user.id]);
    await audit(req, 'admin.login_failed', 'user', user.id, {}, user.id);
    throw generic;
  }
  if (!['super_admin', 'moderator'].includes(user.role) || user.account_status !== 'active') {
    await audit(req, 'admin.login_denied', 'user', user.id, {}, user.id);
    throw generic; // do not reveal whether the account exists / lacks the role
  }
  await db.query('update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [user.id]);
  const { csrf } = await createSession(req, res, user.id, 'admin');
  await audit(req, 'admin.login', 'user', user.id, {}, user.id);
  const perms = await db.one('select permissions from admin_roles where role = $1', [user.role]);
  res.json({ admin: { id: user.id, name: user.full_name, email: user.email, role: user.role }, permissions: perms.permissions, csrf_token: csrf });
}));

r.post('/auth/logout', wrap(async (req, res) => {
  if (req.admin) await audit(req, 'admin.logout', 'user', req.admin.id);
  await destroySession(req, res, 'admin');
  res.json({ ok: true });
}));

r.get('/auth/me', wrap(async (req, res) => {
  if (!req.admin) return res.json({ admin: null });
  const perms = await db.one('select permissions from admin_roles where role = $1', [req.admin.role]);
  res.json({ admin: { id: req.admin.id, name: req.admin.full_name, email: req.admin.email, role: req.admin.role }, permissions: perms.permissions, csrf_token: req.adminSession.csrf_token });
}));

// Everything below needs an authenticated admin session.
r.use(requireAdmin());

// ---------------- Dashboard ----------------
r.get('/dashboard', requireAdmin('dashboard'), wrap(async (req, res) => {
  const [u, c, v, m, rep, activity] = await Promise.all([
    db.one(`select count(*)::int as total, count(*) filter (where created_at > now() - interval '7 days')::int as new_7d,
                   count(*) filter (where account_status = 'suspended')::int as suspended from users`),
    db.one(`select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'approved')::int as active,
                   count(*) filter (where status = 'rejected')::int as rejected, count(*) filter (where status = 'suspended')::int as suspended from channels`),
    db.one(`select count(*) filter (where status <> 'draft')::int as uploaded, count(*) filter (where status = 'pending_moderation')::int as pending_review,
                   count(*) filter (where status = 'published')::int as published, count(*) filter (where status = 'published' and kind = 'short')::int as published_shorts,
                   count(*) filter (where status = 'published' and kind = 'long')::int as published_long from videos`),
    db.one(`select coalesce(sum(views_count),0)::int as views, coalesce(sum(hearts_count),0)::int as hearts, coalesce(sum(dislikes_count),0)::int as dislikes,
                   coalesce(sum(comments_count),0)::int as comments, coalesce(sum(shares_count),0)::int as shares from videos where status = 'published'`),
    db.one(`select count(distinct video_id) filter (where status in ('open','investigating'))::int as reported_videos,
                   count(*) filter (where status in ('open','investigating'))::int as open_reports from reports`),
    db.query(`select a.id, a.action, a.note, a.created_at, u.full_name as admin_name, v.public_id as video_id, v.title as video_title
                from moderation_actions a left join users u on u.id = a.admin_id left join videos v on v.id = a.video_id
               order by a.id desc limit 10`),
  ]);
  res.json({ users: u, creators: c, videos: v, metrics: m, reports: rep, recent_activity: activity });
}));

// ---------------- Users ----------------
r.get('/users', requireAdmin('users'), wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const params = [];
  const where = [];
  if (req.query.q) { params.push(like(req.query.q)); where.push(`(u.email ilike $${params.length} or u.full_name ilike $${params.length} or c.handle ilike $${params.length})`); }
  if (['active', 'suspended'].includes(req.query.status)) { params.push(req.query.status); where.push(`u.account_status = $${params.length}`); }
  if (['user', 'moderator', 'super_admin'].includes(req.query.role)) { params.push(req.query.role); where.push(`u.role = $${params.length}`); }
  params.push(limit + 1, offset);
  const rows = await db.query(
    `select u.id, u.email, u.full_name, u.role, u.account_status, u.email_verified_at, u.created_at, u.last_login_at,
            c.handle, c.status as channel_status,
            (select count(*)::int from videos v where v.channel_id = c.id and v.status <> 'draft') as video_count
       from users u left join channels c on c.user_id = u.id
      ${where.length ? 'where ' + where.join(' and ') : ''} order by u.created_at desc limit $${params.length - 1} offset $${params.length}`, params);
  res.json({ items: rows.slice(0, limit), has_more: rows.length > limit, page });
}));

r.get('/users/:id', requireAdmin('users'), wrap(async (req, res) => {
  const u = await db.one('select id, email, full_name, role, account_status, suspended_reason, email_verified_at, created_at, last_login_at from users where id = $1', [req.params.id]);
  if (!u) throw notFound('User not found');
  const channel = await db.one('select * from channels where user_id = $1', [u.id]);
  const history = await db.query(`select a.id, a.action, a.note, a.created_at, adm.full_name as admin_name from moderation_actions a left join users adm on adm.id = a.admin_id
                                   where a.user_id = $1 order by a.id desc limit 50`, [u.id]);
  const reports = channel ? await db.one(`select count(*)::int as against_channel from reports r join videos v on v.id = r.video_id where v.channel_id = $1`, [channel.id]) : { against_channel: 0 };
  const videos = channel ? await db.query(`select public_id, kind, title, status, views_count, hearts_count from videos where channel_id = $1 order by created_at desc limit 20`, [channel.id]) : [];
  res.json({ user: u, channel: channel && { ...channel, avatar_url: imageUrl(channel.avatar_key) }, history, reports, videos });
}));

async function guardTargetUser(req) {
  const u = await db.one('select * from users where id = $1', [req.params.id]);
  if (!u) throw notFound('User not found');
  if (u.id === req.admin.id) throw forbidden('You cannot do that to your own account');
  if (u.role === 'super_admin') throw forbidden('Demote this administrator before changing their account status');
  return u;
}

r.post('/users/:id/suspend', requireAdmin('users'), wrap(async (req, res) => {
  confirmed(req);
  const { reason } = z.object({ reason: reasonRequired }).parse(req.body);
  const u = await guardTargetUser(req);
  await db.query(`update users set account_status = 'suspended', suspended_reason = $2, updated_at = now() where id = $1`, [u.id, reason]);
  await revokeAllSessions(u.id);
  await recordModeration({ adminId: req.admin.id, userId: u.id, action: 'user_suspended', note: reason });
  await audit(req, 'user.suspend', 'user', u.id, { reason });
  res.json({ ok: true });
}));
r.post('/users/:id/activate', requireAdmin('users'), wrap(async (req, res) => {
  const { note: n } = z.object({ note }).parse(req.body);
  const u = await guardTargetUser(req);
  await db.query(`update users set account_status = 'active', suspended_reason = null, failed_logins = 0, locked_until = null, updated_at = now() where id = $1`, [u.id]);
  await recordModeration({ adminId: req.admin.id, userId: u.id, action: 'user_activated', note: n });
  await audit(req, 'user.activate', 'user', u.id, { note: n });
  res.json({ ok: true });
}));

r.post('/users/:id/role', requireAdmin('admins'), wrap(async (req, res) => {
  confirmed(req);
  const { role } = z.object({ role: z.enum(['user', 'moderator', 'super_admin']) }).parse(req.body);
  const u = await db.one('select * from users where id = $1', [req.params.id]);
  if (!u) throw notFound('User not found');
  if (u.id === req.admin.id) throw forbidden('You cannot change your own role');
  if (!u.email_verified_at && role !== 'user') throw badRequest('The account must have a verified email first');
  if (u.role === 'super_admin' && role !== 'super_admin') {
    const { n } = await db.one(`select count(*)::int as n from users where role = 'super_admin' and account_status = 'active'`);
    if (n <= 1) throw conflict('At least one active Super Admin must remain');
  }
  await db.query('update users set role = $2, updated_at = now() where id = $1', [u.id, role]);
  await revokeAllSessions(u.id); // force re-login with the new privileges
  await recordModeration({ adminId: req.admin.id, userId: u.id, action: `role_${role}`, note: `from ${u.role}` });
  await audit(req, 'user.role_change', 'user', u.id, { from: u.role, to: role });
  res.json({ ok: true });
}));

// ---------------- Creator approvals ----------------
r.get('/creators', requireAdmin('creators'), wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const status = ['pending', 'approved', 'rejected', 'suspended'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.query(
    `select c.id, c.name, c.handle, c.bio, c.status, c.status_reason, c.created_at, c.telegram_url, c.avatar_key,
            u.id as user_id, u.email, u.full_name, u.email_verified_at,
            (select count(*)::int from videos v where v.channel_id = c.id and v.status <> 'draft') as video_count,
            (select count(*)::int from reports r join videos v on v.id = r.video_id where v.channel_id = c.id and r.status = 'actioned') as actioned_reports
       from channels c join users u on u.id = c.user_id
      where ($1::text is null or c.status = $1) order by (c.status = 'pending') desc, c.created_at desc limit $2 offset $3`, [status, limit + 1, offset]);
  res.json({ items: rows.slice(0, limit).map((c) => ({ ...c, avatar_url: imageUrl(c.avatar_key), avatar_key: undefined })), has_more: rows.length > limit, page });
}));

async function setChannelStatus(req, res, next_status, { requireReason = false, needConfirm = false, from } = {}) {
  if (needConfirm) confirmed(req);
  const body = z.object({ reason: requireReason ? reasonRequired : note }).parse(req.body);
  const ch = await db.one('select c.*, u.id as uid from channels c join users u on u.id = c.user_id where c.id = $1', [req.params.id]);
  if (!ch) throw notFound('Channel not found');
  if (from && !from.includes(ch.status)) throw conflict(`Channel is ${ch.status}; cannot move to ${next_status}`);
  await db.query(`update channels set status = $2, status_reason = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now() where id = $1`,
    [ch.id, next_status, body.reason || null, req.admin.id]);
  await recordModeration({ adminId: req.admin.id, userId: ch.uid, action: `creator_${next_status}`, note: body.reason });
  await audit(req, `creator.${next_status}`, 'channel', ch.id, { handle: ch.handle, reason: body.reason, from: ch.status });
  res.json({ ok: true, status: next_status });
}
r.post('/channels/:id/approve', requireAdmin('creators'), wrap((req, res) => setChannelStatus(req, res, 'approved', { from: ['pending', 'rejected'] })));
r.post('/channels/:id/reject', requireAdmin('creators'), wrap((req, res) => setChannelStatus(req, res, 'rejected', { requireReason: true, from: ['pending', 'approved'] })));
r.post('/channels/:id/suspend', requireAdmin('creators'), wrap((req, res) => setChannelStatus(req, res, 'suspended', { requireReason: true, needConfirm: true, from: ['approved', 'pending'] })));
r.post('/channels/:id/activate', requireAdmin('creators'), wrap((req, res) => setChannelStatus(req, res, 'approved', { from: ['suspended', 'rejected'] })));

// ---------------- Videos ----------------
const adminVideoSelect = `
  select v.id, v.public_id, v.kind, v.title, v.status, v.featured, v.pinned_rank, v.created_at, v.published_at, v.duration_seconds,
         v.views_count, v.unique_views_count, v.hearts_count, v.dislikes_count, v.comments_count, v.shares_count, v.saves_count,
         v.error_message, v.rejected_reason, v.removed_reason, v.removed_by, v.thumbnail_key,
         c.handle as channel_handle, c.name as channel_name, c.status as channel_status, cat.name as category_name,
         (select count(*)::int from reports r where r.video_id = v.id and r.status in ('open','investigating')) as open_reports
    from videos v join channels c on c.id = v.channel_id left join categories cat on cat.id = v.category_id`;

r.get('/videos', requireAdmin('videos'), wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const params = [];
  const where = [`v.status <> 'draft'`];
  const kind = ['short', 'long'].includes(req.query.kind) ? req.query.kind : null;
  if (kind) { params.push(kind); where.push(`v.kind = $${params.length}`); }
  const status = ['uploading', 'processing', 'pending_moderation', 'published', 'rejected', 'removed', 'draft'].includes(req.query.status) ? req.query.status : null;
  if (status) { where.splice(0, 1, `v.status = $${params.push(status)}`); }
  if (req.query.reported === '1') where.push(`exists (select 1 from reports r where r.video_id = v.id and r.status in ('open','investigating'))`);
  if (req.query.q) {
    params.push(like(req.query.q));
    const p = `$${params.length}`;
    where.push(`(v.title ilike ${p} or c.handle ilike ${p} or cat.name ilike ${p} or v.public_id ilike ${p} or v.id::text ilike ${p})`);
  }
  params.push(limit + 1, offset);
  const rows = await db.query(`${adminVideoSelect} where ${where.join(' and ')} order by v.created_at desc limit $${params.length - 1} offset $${params.length}`, params);
  res.json({ items: rows.slice(0, limit).map((v) => ({ ...v, thumbnail_url: v.thumbnail_key ? `/thumb/${v.public_id}` : null, thumbnail_key: undefined })), has_more: rows.length > limit, page });
}));

r.get('/videos/:id', requireAdmin('videos'), wrap(async (req, res) => {
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  const full = await db.one(`select v.size_bytes, v.mime, v.removed_by, ch.user_id as owner_id, u.email as owner_email, u.full_name as owner_name
                               from videos v join channels ch on ch.id = v.channel_id join users u on u.id = ch.user_id where v.id = $1`, [v.id]);
  const history = await db.query(`select a.id, a.action, a.note, a.created_at, u.full_name as admin_name from moderation_actions a left join users u on u.id = a.admin_id
                                   where a.video_id = $1 order by a.id desc limit 100`, [v.id]);
  const reports = await db.query(`select r.id, r.reason, r.details, r.status, r.target_type, r.created_at, u.full_name as reporter_name, u.email as reporter_email
                                    from reports r join users u on u.id = r.reporter_id where r.video_id = $1 order by r.created_at desc limit 100`, [v.id]);
  res.json({
    video: { ...videoDto(v, { detail: true, owner: true }), pinned_rank: v.pinned_rank, size_bytes: full.size_bytes, mime: full.mime, removed_by: full.removed_by,
      owner: { id: full.owner_id, email: full.owner_email, name: full.owner_name }, channel_status: v.channel_status,
      trending_score: await trendingScoreFor(v.id) },
    history, reports,
  });
}));

r.patch('/videos/:id', requireAdmin('videos'), wrap(async (req, res) => {
  const body = z.object({
    title: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(5000).optional(),
    category_id: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10).optional(),
    note,
  }).parse(req.body);
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  const before = { title: v.title, description: v.description, tags: v.tags, category: v.category_slug };
  await db.query(`update videos set title = $2, description = $3, tags = $4, category_id = case when $6 then $5::uuid else category_id end, updated_at = now() where id = $1`,
    [v.id, body.title ?? v.title, body.description ?? v.description, body.tags ?? v.tags, body.category_id ?? null, 'category_id' in body]);
  await recordModeration({ adminId: req.admin.id, videoId: v.id, action: 'metadata_edited', note: body.note });
  await audit(req, 'video.edit', 'video', v.public_id, { before, fields: Object.keys(body).filter((k) => k !== 'note') });
  res.json({ ok: true });
}));

async function videoAction(req, res, { action, from, to, reason = false, needConfirm = false, extra }) {
  if (needConfirm) confirmed(req);
  const body = z.object({ reason: reason ? reasonRequired : note }).parse(req.body);
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  if (from && !from.includes(v.status)) throw conflict(`Video is ${v.status}; cannot ${action}`);
  await db.query(`update videos set status = $2, updated_at = now() ${extra ? ',' + extra : ''} where id = $1`, [v.id, to, ...(extra?.includes('$3') ? [body.reason] : [])]);
  await recordModeration({ adminId: req.admin.id, videoId: v.id, action, note: body.reason });
  await audit(req, `video.${action}`, 'video', v.public_id, { from: v.status, reason: body.reason });
  res.json({ ok: true, status: to });
}
r.post('/videos/:id/approve', requireAdmin('videos'), wrap((req, res) => videoAction(req, res, {
  action: 'approved', from: ['pending_moderation', 'rejected'], to: 'published', extra: `published_at = coalesce(published_at, now()), rejected_reason = null, error_message = null` })));
r.post('/videos/:id/reject', requireAdmin('videos'), wrap((req, res) => videoAction(req, res, {
  action: 'rejected', from: ['pending_moderation'], to: 'rejected', reason: true, extra: `rejected_reason = $3` })));
r.post('/videos/:id/remove', requireAdmin('videos'), wrap((req, res) => videoAction(req, res, {
  action: 'removed', from: ['pending_moderation', 'published', 'rejected'], to: 'removed', reason: true, needConfirm: true,
  extra: `removed_at = now(), removed_by = 'admin', removed_reason = $3, featured = false, pinned_rank = null` })));

r.post('/videos/:id/restore', requireAdmin('videos'), wrap(async (req, res) => {
  const { note: n } = z.object({ note }).parse(req.body);
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  const full = await db.one('select removed_by, published_at from videos where id = $1', [v.id]);
  if (v.status !== 'removed' || full.removed_by !== 'admin') throw conflict('Only videos removed by an administrator can be restored');
  const to = full.published_at ? 'published' : 'pending_moderation';
  await db.query(`update videos set status = $2, removed_at = null, removed_reason = null, removed_by = null, updated_at = now() where id = $1`, [v.id, to]);
  await recordModeration({ adminId: req.admin.id, videoId: v.id, action: 'restored', note: n });
  await audit(req, 'video.restore', 'video', v.public_id, { to });
  res.json({ ok: true, status: to });
}));

r.post('/videos/:id/feature', requireAdmin('videos'), wrap(async (req, res) => {
  const { featured } = z.object({ featured: z.boolean() }).parse(req.body);
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  if (featured && v.status !== 'published') throw conflict('Only published videos can be featured');
  await db.query(`update videos set featured = $2, featured_at = case when $2 then now() else null end, pinned_rank = case when $2 then pinned_rank else null end, updated_at = now() where id = $1`, [v.id, featured]);
  await recordModeration({ adminId: req.admin.id, videoId: v.id, action: featured ? 'featured' : 'unfeatured' });
  await audit(req, featured ? 'video.feature' : 'video.unfeature', 'video', v.public_id);
  res.json({ ok: true });
}));

r.post('/videos/:id/pin', requireAdmin('videos'), wrap(async (req, res) => {
  const { rank } = z.object({ rank: z.number().int().min(1).max(50).nullable() }).parse(req.body);
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  if (rank !== null && v.status !== 'published') throw conflict('Only published videos can be pinned');
  await db.query(`update videos set pinned_rank = $2, updated_at = now() where id = $1`, [v.id, rank]);
  await recordModeration({ adminId: req.admin.id, videoId: v.id, action: rank ? `pinned_${rank}` : 'unpinned' });
  await audit(req, 'video.pin', 'video', v.public_id, { rank });
  res.json({ ok: true });
}));

// Counters can only be *repaired* from source rows or reduced by removing proven-abusive actors; never inflated.
r.post('/videos/:id/recount', requireAdmin('videos'), wrap(async (req, res) => {
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  const before = { views: v.views_count, hearts: v.hearts_count, dislikes: v.dislikes_count, comments: v.comments_count, shares: v.shares_count, saves: v.saves_count };
  await db.tx((q) => recountVideo(q, v.id));
  const a = await getVideoRowByPublicId(req.params.id);
  const after = { views: a.views_count, hearts: a.hearts_count, dislikes: a.dislikes_count, comments: a.comments_count, shares: a.shares_count, saves: a.saves_count };
  await audit(req, 'video.recount', 'video', v.public_id, { before, after });
  res.json({ before, after });
}));

r.get('/videos/:id/suspicious', requireAdmin('videos'), wrap(async (req, res) => {
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  const anonByIp = await db.query(`select ip_hash, count(*)::int as reactions from reactions where video_id = $1 and user_id is null and ip_hash is not null
                                    group by ip_hash having count(*) >= 5 order by count(*) desc limit 20`, [v.id]);
  const heavyViewers = await db.query(`select actor_key, count(*)::int as events from video_events where video_id = $1 and type = 'view' and created_at > now() - interval '24 hours'
                                        group by actor_key having count(*) >= 8 order by count(*) desc limit 20`, [v.id]);
  res.json({ anonymous_reactions_by_network: anonByIp, repeat_viewers: heavyViewers });
}));

r.post('/videos/:id/invalidate', requireAdmin('videos'), wrap(async (req, res) => {
  confirmed(req);
  const body = z.object({ type: z.enum(['ip', 'actor']), key: z.string().min(8).max(100), reason: reasonRequired }).parse(req.body);
  const v = await getVideoRowByPublicId(req.params.id);
  if (!v) throw notFound('Video not found');
  const before = { hearts: v.hearts_count, dislikes: v.dislikes_count, views: v.views_count, shares: v.shares_count };
  await db.tx(async (q) => {
    if (body.type === 'ip') await q('delete from reactions where video_id = $1 and user_id is null and ip_hash = $2', [v.id, body.key]);
    else {
      await q('delete from reactions where video_id = $1 and actor_key = $2', [v.id, body.key]);
      await q('delete from video_events where video_id = $1 and actor_key = $2', [v.id, body.key]);
    }
    await recountVideo(q, v.id);
  });
  const a = await getVideoRowByPublicId(req.params.id);
  await recordModeration({ adminId: req.admin.id, videoId: v.id, action: 'engagement_invalidated', note: `${body.type}: ${body.reason}` });
  await audit(req, 'video.invalidate_engagement', 'video', v.public_id, { type: body.type, reason: body.reason, before, after: { hearts: a.hearts_count, dislikes: a.dislikes_count, views: a.views_count, shares: a.shares_count } });
  res.json({ ok: true, before, after: { hearts: a.hearts_count, dislikes: a.dislikes_count, views: a.views_count, shares: a.shares_count } });
}));

// ---------------- Reports ----------------
r.get('/reports', requireAdmin('reports'), wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const status = ['open', 'investigating', 'dismissed', 'actioned'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.query(
    `select r.id, r.target_type, r.reason, r.details, r.status, r.created_at, r.resolved_at, r.resolution_note,
            rep.full_name as reporter_name, rep.email as reporter_email,
            v.public_id as video_id, v.title as video_title, v.status as video_status, v.kind as video_kind,
            ch.handle as channel_handle, ch.id as channel_id,
            m.body as comment_body, m.status as comment_status,
            (select count(*)::int from reports r2 join videos v2 on v2.id = r2.video_id where v2.channel_id = ch.id and r2.status = 'actioned') as channel_actioned_reports
       from reports r join users rep on rep.id = r.reporter_id left join videos v on v.id = r.video_id
       left join channels ch on ch.id = v.channel_id left join comments m on m.id = r.comment_id
      where ($1::text is null or r.status = $1) order by (r.status in ('open','investigating')) desc, r.created_at desc limit $2 offset $3`, [status, limit + 1, offset]);
  res.json({ items: rows.slice(0, limit), has_more: rows.length > limit, page });
}));

async function loadReport(id) {
  const rep = await db.one(`select r.*, v.public_id, ch.id as channel_id, ch.user_id as channel_user_id from reports r left join videos v on v.id = r.video_id left join channels ch on ch.id = v.channel_id where r.id = $1`, [id]);
  if (!rep) throw notFound('Report not found');
  return rep;
}
async function resolveReport(req, rep, status, noteText) {
  await db.query(`update reports set status = $2, resolved_by = $3, resolution_note = $4, resolved_at = case when $2 in ('dismissed','actioned') then now() else null end where id = $1`,
    [rep.id, status, req.admin.id, noteText || null]);
  // Close sibling open reports about the same target.
  if (['dismissed', 'actioned'].includes(status)) {
    await db.query(`update reports set status = $2, resolved_by = $3, resolution_note = coalesce(resolution_note, 'Resolved together with report ' || $4), resolved_at = now()
                     where id <> $1 and status in ('open','investigating') and target_type = $5 and (($5 = 'video' and video_id = $6) or ($5 = 'comment' and comment_id = $7))`,
      [rep.id, status, req.admin.id, rep.id, rep.target_type, rep.video_id, rep.comment_id]);
  }
}
r.post('/reports/:id/investigate', requireAdmin('reports'), wrap(async (req, res) => {
  const rep = await loadReport(req.params.id);
  await resolveReport(req, rep, 'investigating', '');
  await audit(req, 'report.investigate', 'report', rep.id);
  res.json({ ok: true });
}));
r.post('/reports/:id/dismiss', requireAdmin('reports'), wrap(async (req, res) => {
  const { note: n } = z.object({ note: reasonRequired }).parse(req.body);
  const rep = await loadReport(req.params.id);
  await resolveReport(req, rep, 'dismissed', n);
  await recordModeration({ adminId: req.admin.id, videoId: rep.video_id, commentId: rep.comment_id, action: 'report_dismissed', note: n });
  await audit(req, 'report.dismiss', 'report', rep.id, { note: n });
  res.json({ ok: true });
}));
r.post('/reports/:id/action', requireAdmin('reports'), wrap(async (req, res) => {
  confirmed(req);
  const body = z.object({ action: z.enum(['remove_content', 'suspend_creator']), note: reasonRequired }).parse(req.body);
  const rep = await loadReport(req.params.id);
  if (body.action === 'remove_content') {
    if (rep.target_type === 'video') {
      await db.query(`update videos set status = 'removed', removed_at = now(), removed_by = 'admin', removed_reason = $2, featured = false, pinned_rank = null, updated_at = now() where id = $1 and status <> 'removed'`, [rep.video_id, body.note]);
      await recordModeration({ adminId: req.admin.id, videoId: rep.video_id, action: 'removed_via_report', note: body.note });
    } else {
      await db.tx(async (q) => {
        await q(`update comments set status = 'removed' where id = $1`, [rep.comment_id]);
        await recountVideo(q, rep.video_id);
      });
      await recordModeration({ adminId: req.admin.id, videoId: rep.video_id, commentId: rep.comment_id, action: 'comment_removed', note: body.note });
    }
  } else {
    if (!rep.channel_id) throw badRequest('No creator is associated with this report');
    await db.query(`update channels set status = 'suspended', status_reason = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() where id = $1`, [rep.channel_id, body.note, req.admin.id]);
    await recordModeration({ adminId: req.admin.id, userId: rep.channel_user_id, videoId: rep.video_id, action: 'creator_suspended_via_report', note: body.note });
  }
  await resolveReport(req, rep, 'actioned', `${body.action}: ${body.note}`);
  await audit(req, `report.${body.action}`, 'report', rep.id, { note: body.note });
  res.json({ ok: true });
}));

// ---------------- Popularity ----------------
const LISTS = { viewed: 'views', hearted: 'hearts', disliked: 'dislikes', commented: 'comments', shared: 'shares', trending: 'trending', featured: 'featured', recent: 'recent' };
r.get('/popularity', requireAdmin('popularity'), wrap(async (req, res) => {
  const list = LISTS[req.query.list] ? req.query.list : 'trending';
  const kind = ['short', 'long'].includes(req.query.kind) ? req.query.kind : undefined;
  const { rows } = await listVideos({ kind, sort: LISTS[list], limit: Math.min(Number(req.query.limit) || 25, 50), admin: false });
  const items = [];
  for (const row of rows) items.push({ ...videoDto(row, { owner: true }), pinned_rank: row.pinned_rank, trending_score: await trendingScoreFor(row.id) });
  res.json({ list, items });
}));

// ---------------- Settings ----------------
r.get('/settings', requireAdmin('settings'), wrap(async (req, res) => {
  res.json({ settings: await getSettings(), defaults: DEFAULTS });
}));
r.put('/settings/:key', requireAdmin('settings'), wrap(async (req, res) => {
  const key = req.params.key;
  if (!SETTING_SCHEMAS[key]) throw notFound('Unknown setting');
  const value = req.body?.value;
  if (key === 'telegram') {
    const t = SETTING_SCHEMAS.telegram.parse(value);
    if (t.global_url) {
      const n = normalizeTelegramUrl(t.global_url);
      if (!n) throw badRequest('Telegram link must be a valid https://t.me/... link');
      value.global_url = n;
    }
    if (t.locked && !t.global_url) throw badRequest('Set a global Telegram link before locking it');
  }
  const old = (await getSettings())[key];
  const saved = await setSetting(key, value, req.admin.id);
  await audit(req, 'settings.update', 'setting', key, { before: old, after: saved });
  res.json({ ok: true, value: saved });
}));

// ---------------- Categories & tags ----------------
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
r.get('/categories', requireAdmin('categories'), wrap(async (req, res) => {
  const rows = await db.query(`select c.*, (select count(*)::int from videos v where v.category_id = c.id and v.status = 'published') as videos from categories c order by sort_order, name`);
  res.json({ items: rows });
}));
r.post('/categories', requireAdmin('categories'), wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(40), sort_order: z.number().int().min(0).max(999).default(100) }).parse(req.body);
  const slug = slugify(b.name);
  if (!slug) throw badRequest('Invalid name');
  try {
    const c = await db.one('insert into categories (slug, name, sort_order) values ($1,$2,$3) returning *', [slug, b.name, b.sort_order]);
    await audit(req, 'category.create', 'category', c.id, { name: b.name });
    res.status(201).json({ category: c });
  } catch (e) {
    if (e.code === '23505') throw conflict('A category with this name already exists');
    throw e;
  }
}));
r.patch('/categories/:id', requireAdmin('categories'), wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(40).optional(), sort_order: z.number().int().min(0).max(999).optional(), is_active: z.boolean().optional() }).parse(req.body);
  const c = await db.one('select * from categories where id = $1', [req.params.id]);
  if (!c) throw notFound('Category not found');
  await db.query('update categories set name = $2, sort_order = $3, is_active = $4 where id = $1', [c.id, b.name ?? c.name, b.sort_order ?? c.sort_order, b.is_active ?? c.is_active]);
  await audit(req, 'category.update', 'category', c.id, { before: { name: c.name, is_active: c.is_active }, after: b });
  res.json({ ok: true });
}));
r.delete('/categories/:id', requireAdmin('categories'), wrap(async (req, res) => {
  confirmed(req);
  const c = await db.one('select * from categories where id = $1', [req.params.id]);
  if (!c) throw notFound('Category not found');
  await db.query('delete from categories where id = $1', [c.id]);
  await audit(req, 'category.delete', 'category', c.id, { name: c.name });
  res.json({ ok: true });
}));
r.get('/tags', requireAdmin('categories'), wrap(async (req, res) => {
  const rows = await db.query(`select tag, count(*)::int as videos from videos, unnest(tags) as tag where status = 'published' group by tag order by count(*) desc, tag limit 100`);
  res.json({ items: rows });
}));
r.post('/tags/remove', requireAdmin('categories'), wrap(async (req, res) => {
  confirmed(req);
  const { tag } = z.object({ tag: z.string().trim().toLowerCase().min(1).max(30) }).parse(req.body);
  const out = await db.query(`update videos set tags = array_remove(tags, $1) where $1 = any(tags) returning id`, [tag]);
  await audit(req, 'tag.remove', 'tag', tag, { affected: out.length });
  res.json({ ok: true, affected: out.length });
}));

// ---------------- Audit log ----------------
r.get('/audit', requireAdmin('audit'), wrap(async (req, res) => {
  const { limit, offset, page } = paging(req, 50);
  const params = [];
  const where = [];
  if (req.query.action) { params.push(like(req.query.action)); where.push(`a.action ilike $${params.length}`); }
  if (req.query.q) { params.push(like(req.query.q)); where.push(`(a.target_id ilike $${params.length} or u.email ilike $${params.length} or u.full_name ilike $${params.length})`); }
  params.push(limit + 1, offset);
  const rows = await db.query(
    `select a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at, u.full_name as actor_name, u.email as actor_email
       from audit_logs a left join users u on u.id = a.actor_id ${where.length ? 'where ' + where.join(' and ') : ''}
      order by a.id desc limit $${params.length - 1} offset $${params.length}`, params);
  res.json({ items: rows.slice(0, limit), has_more: rows.length > limit, page });
}));

export default r;
