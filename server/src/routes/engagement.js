import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { wrap, badRequest, notFound, forbidden, HttpError } from '../lib/errors.js';
import { requireAuth, requireVerified, actorFor, limiter } from '../middleware/core.js';
import { getVideoRowByPublicId, isPubliclyVisible } from '../services/videos.js';
import { getSetting } from '../services/settings.js';
import { ipHash } from '../lib/crypto.js';
import { videoDto } from '../services/videos.js';

const r = Router();

async function publishedVideo(publicId) {
  const row = await getVideoRowByPublicId(publicId);
  if (!row || !isPubliclyVisible(row)) throw notFound('Video not found');
  return row;
}

const ANON_REACTIONS_PER_IP_HOUR = 120;

// ---- Heart / Dislike (no login required; one reaction per actor per video) ----
r.post('/videos/:id/react', limiter({ windowMs: 60e3, max: 60 }), wrap(async (req, res) => {
  const { type } = z.object({ type: z.enum(['heart', 'dislike']).nullable() }).parse(req.body);
  const video = await publishedVideo(req.params.id);
  const actor = actorFor(req, res, { create: true });
  const iph = ipHash(req.ip);
  if (type && !actor.userId) {
    const existing = await db.one('select 1 from reactions where video_id = $1 and actor_key = $2', [video.id, actor.key]);
    if (!existing) {
      const { n } = await db.one(`select count(*)::int as n from reactions where user_id is null and ip_hash = $1 and created_at > now() - interval '1 hour'`, [iph]);
      if (n >= ANON_REACTIONS_PER_IP_HOUR) throw new HttpError(429, 'Too many reactions from this network. Log in to keep reacting.', 'rate_limited');
    }
  }
  const counts = await db.tx(async (q) => {
    if (type === null) await q('delete from reactions where video_id = $1 and actor_key = $2', [video.id, actor.key]);
    else await q(
      `insert into reactions (video_id, actor_key, user_id, type, ip_hash) values ($1,$2,$3,$4,$5)
       on conflict (video_id, actor_key) do update set type = excluded.type, updated_at = now(),
         created_at = case when reactions.type = excluded.type then reactions.created_at else now() end`,
      [video.id, actor.key, actor.userId, type, iph]);
    const [c] = await q(
      `update videos set
         hearts_count = (select count(*) from reactions where video_id = $1 and type = 'heart'),
         dislikes_count = (select count(*) from reactions where video_id = $1 and type = 'dislike')
       where id = $1 returning hearts_count, dislikes_count`, [video.id]);
    return c;
  });
  res.json({ my_reaction: type, hearts: counts.hearts_count, dislikes: counts.dislikes_count });
}));

// ---- Views: de-duplicated per actor (30 min), creators' own views are ignored ----
r.post('/videos/:id/view', limiter({ windowMs: 60e3, max: 120 }), wrap(async (req, res) => {
  const video = await publishedVideo(req.params.id);
  const actor = actorFor(req, res, { create: true });
  if (req.user) {
    const own = await db.one('select 1 from channels where id = $1 and user_id = $2', [video.channel_id, req.user.id]);
    if (own) return res.json({ counted: false, views: video.views_count });
  }
  const out = await db.tx(async (q) => {
    const [recent] = await q(`select 1 as x from video_events where video_id = $1 and type = 'view' and actor_key = $2 and created_at > now() - interval '30 minutes' limit 1`, [video.id, actor.key]);
    if (recent) return { counted: false, views: video.views_count };
    const [ever] = await q(`select 1 as x from video_events where video_id = $1 and type = 'view' and actor_key = $2 limit 1`, [video.id, actor.key]);
    await q(`insert into video_events (video_id, type, actor_key, ip_hash) values ($1,'view',$2,$3)`, [video.id, actor.key, ipHash(req.ip)]);
    const [v] = await q(`update videos set views_count = views_count + 1, unique_views_count = unique_views_count + $2 where id = $1 returning views_count`, [video.id, ever ? 0 : 1]);
    return { counted: true, views: v.views_count };
  });
  res.json(out);
}));

// ---- Share (no login). Count once per actor per hour. ----
r.post('/videos/:id/share', limiter({ windowMs: 60e3, max: 30 }), wrap(async (req, res) => {
  const video = await publishedVideo(req.params.id);
  const actor = actorFor(req, res, { create: true });
  const out = await db.tx(async (q) => {
    const [recent] = await q(`select 1 as x from video_events where video_id = $1 and type = 'share' and actor_key = $2 and created_at > now() - interval '1 hour' limit 1`, [video.id, actor.key]);
    if (recent) return { counted: false, shares: video.shares_count };
    await q(`insert into video_events (video_id, type, actor_key, ip_hash) values ($1,'share',$2,$3)`, [video.id, actor.key, ipHash(req.ip)]);
    const [v] = await q('update videos set shares_count = shares_count + 1 where id = $1 returning shares_count', [video.id]);
    return { counted: true, shares: v.shares_count };
  });
  res.json({ ...out, url: `${req.protocol}://${req.get('host')}/${video.kind === 'short' ? 'shorts' : 'watch'}/${video.public_id}` });
}));

// ---- Save (login required) ----
r.put('/videos/:id/save', requireAuth, wrap(async (req, res) => {
  const video = await publishedVideo(req.params.id);
  const saves = await db.tx(async (q) => {
    await q('insert into saved_videos (user_id, video_id) values ($1,$2) on conflict do nothing', [req.user.id, video.id]);
    const [v] = await q('update videos set saves_count = (select count(*) from saved_videos where video_id = $1) where id = $1 returning saves_count', [video.id]);
    return v.saves_count;
  });
  res.json({ saved: true, saves });
}));
r.delete('/videos/:id/save', requireAuth, wrap(async (req, res) => {
  const video = await getVideoRowByPublicId(req.params.id);
  if (!video) throw notFound('Video not found');
  const saves = await db.tx(async (q) => {
    await q('delete from saved_videos where user_id = $1 and video_id = $2', [req.user.id, video.id]);
    const [v] = await q('update videos set saves_count = (select count(*) from saved_videos where video_id = $1) where id = $1 returning saves_count', [video.id]);
    return v.saves_count;
  });
  res.json({ saved: false, saves });
}));

r.get('/me/saved', requireAuth, wrap(async (req, res) => {
  const kind = req.query.kind === 'short' || req.query.kind === 'long' ? req.query.kind : null;
  const rows = await db.query(
    `select v.*, c.name as channel_name, c.handle as channel_handle, c.avatar_key as channel_avatar_key,
            cat.slug as category_slug, cat.name as category_name
       from saved_videos sv join videos v on v.id = sv.video_id join channels c on c.id = v.channel_id
       left join categories cat on cat.id = v.category_id
      where sv.user_id = $1 and v.status = 'published' and c.status = 'approved' and ($2::text is null or v.kind = $2)
      order by sv.created_at desc limit 100`, [req.user.id, kind]);
  res.json({ items: rows.map((v) => videoDto(v)) });
}));

// ---- Comments: loaded only when the panel is opened ----
r.get('/videos/:id/comments', wrap(async (req, res) => {
  const video = await publishedVideo(req.params.id);
  const page = Math.max(0, Number(req.query.page) || 0);
  const limit = 20;
  const rows = await db.query(
    `select m.id, m.body, m.created_at, m.user_id, u.full_name, ch.handle, ch.avatar_key
       from comments m join users u on u.id = m.user_id left join channels ch on ch.user_id = u.id and ch.status = 'approved'
      where m.video_id = $1 and m.status = 'visible' order by m.created_at desc limit $2 offset $3`,
    [video.id, limit + 1, page * limit]);
  res.json({
    items: rows.slice(0, limit).map((m) => ({
      id: m.id, body: m.body, created_at: m.created_at, mine: !!req.user && m.user_id === req.user.id,
      author: { name: m.full_name, handle: m.handle || null, avatar_url: m.avatar_key ? `/media/img/${m.avatar_key}` : null },
    })),
    has_more: rows.length > limit,
    total: video.comments_count,
  });
}));

r.post('/videos/:id/comments', requireVerified, limiter({ windowMs: 60e3, max: 10, message: 'You are commenting too fast.' }), wrap(async (req, res) => {
  const { body } = z.object({ body: z.string().trim().min(1, 'Write something first').max(1000) }).parse(req.body);
  const settings = await getSetting('moderation');
  if (!settings.comments_enabled) throw forbidden('Comments are disabled', 'comments_disabled');
  const video = await publishedVideo(req.params.id);
  const out = await db.tx(async (q) => {
    const [c] = await q('insert into comments (video_id, user_id, body) values ($1,$2,$3) returning id, created_at', [video.id, req.user.id, body]);
    const [v] = await q(`update videos set comments_count = (select count(*) from comments where video_id = $1 and status = 'visible') where id = $1 returning comments_count`, [video.id]);
    return { c, count: v.comments_count };
  });
  res.status(201).json({ comment: { id: out.c.id, body, created_at: out.c.created_at, mine: true, author: { name: req.user.full_name } }, comments: out.count });
}));

r.delete('/comments/:id', requireAuth, wrap(async (req, res) => {
  const c = await db.one('select * from comments where id = $1', [req.params.id].map(String));
  if (!c || c.user_id !== req.user.id) throw notFound('Comment not found');
  const count = await db.tx(async (q) => {
    await q(`update comments set status = 'removed' where id = $1`, [c.id]);
    const [v] = await q(`update videos set comments_count = (select count(*) from comments where video_id = $1 and status = 'visible') where id = $1 returning comments_count`, [c.video_id]);
    return v.comments_count;
  });
  res.json({ ok: true, comments: count });
}));

// ---- Reports ----
const REASONS = ['spam', 'sexual', 'violence', 'hate', 'harassment', 'copyright', 'misleading', 'other'];
const reportBody = z.object({ reason: z.enum(REASONS), details: z.string().trim().max(1000).default('') });

r.post('/videos/:id/report', requireVerified, limiter({ windowMs: 3600e3, max: 20 }), wrap(async (req, res) => {
  const b = reportBody.parse(req.body);
  const video = await publishedVideo(req.params.id);
  try {
    await db.query(`insert into reports (reporter_id, target_type, video_id, reason, details) values ($1,'video',$2,$3,$4)`, [req.user.id, video.id, b.reason, b.details]);
  } catch (e) {
    if (e.code === '23505' || /reports_one_per/.test(String(e.message))) return res.json({ ok: true, duplicate: true });
    throw e;
  }
  res.status(201).json({ ok: true });
}));

r.post('/comments/:id/report', requireVerified, limiter({ windowMs: 3600e3, max: 30 }), wrap(async (req, res) => {
  const b = reportBody.parse(req.body);
  const c = await db.one(`select id, video_id from comments where id = $1 and status = 'visible'`, [String(req.params.id)]);
  if (!c) throw notFound('Comment not found');
  try {
    await db.query(`insert into reports (reporter_id, target_type, video_id, comment_id, reason, details) values ($1,'comment',$2,$3,$4,$5)`, [req.user.id, c.video_id, c.id, b.reason, b.details]);
  } catch (e) {
    if (e.code === '23505' || /reports_one_per/.test(String(e.message))) return res.json({ ok: true, duplicate: true });
    throw e;
  }
  res.status(201).json({ ok: true });
}));

export default r;
