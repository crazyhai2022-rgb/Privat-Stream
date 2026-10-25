import { Router } from 'express';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { db } from '../db/index.js';
import { wrap, badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { requireAuth, actorFor } from '../middleware/core.js';
import { listVideos, videoDto, getVideoRowByPublicId, isPubliclyVisible, SORTS } from '../services/videos.js';
import { resolveTelegram } from '../services/telegram.js';
import { getSetting } from '../services/settings.js';
import { getStorage } from '../storage/index.js';
import { uploader, cleanupFiles, extFor } from '../lib/uploads.js';
import { sniff, hasFfmpeg, makeThumbnail } from '../lib/media.js';
import { storeThumbnail } from '../services/thumbnails.js';
import path from 'node:path';
import { config } from '../config.js';
import { publicId, fileId } from '../lib/crypto.js';
import { enqueueProcessing } from '../services/processing.js';
import { canUpload } from '../services/serializers.js';

const r = Router();

const tagsSchema = z.array(z.string().trim().toLowerCase().min(1).max(30).regex(/^[\p{L}\p{N}_\- ]+$/u, 'Tags may only contain letters, numbers, spaces, - and _')).max(10);
const metaSchema = z.object({
  kind: z.enum(['short', 'long']),
  title: z.string().trim().min(2).max(100),
  description: z.string().trim().max(5000).default(''),
  category_id: z.string().uuid().optional().nullable(),
  tags: tagsSchema.default([]),
});

async function ownerChannel(req) {
  const ch = await db.one('select * from channels where user_id = $1', [req.user.id]);
  return ch;
}
// Re-checked against the database on every call, so client state can never grant upload rights.
export async function requireUploader(req, res, next) {
  try {
    const ch = await ownerChannel(req);
    if (!ch) return next(forbidden('Create your channel before uploading', 'no_channel'));
    const { require_email_verification: requireEmailVerification } = await getSetting('moderation');
    if (!canUpload(req.user, ch, { requireEmailVerification })) {
      const msg = (requireEmailVerification && !req.user.email_verified_at) ? 'Verify your email before uploading'
        : ch.status === 'pending' ? 'Your creator account is pending review'
        : ch.status === 'rejected' ? 'Your creator application was rejected'
        : ch.status === 'suspended' ? 'Your channel is suspended' : 'You cannot upload right now';
      const code = (requireEmailVerification && !req.user.email_verified_at) ? 'email_unverified' : `creator_${ch.status}`;
      return next(forbidden(msg, code));
    }
    req.channel = ch;
    next();
  } catch (e) { next(e); }
}

async function ownedVideo(req) {
  const row = await getVideoRowByPublicId(req.params.id);
  if (!row) throw notFound('Video not found');
  const ch = await ownerChannel(req);
  if (!ch || ch.id !== row.channel_id) throw notFound('Video not found');
  return { row, ch };
}

// ---------- Public listings ----------
const listQuery = z.object({
  kind: z.enum(['short', 'long']).optional(),
  sort: z.enum(SORTS).default('trending'),
  category: z.string().max(60).optional(),
  q: z.string().trim().max(100).optional(),
  channel: z.string().max(40).optional(),
  page: z.coerce.number().int().min(0).max(200).default(0),
  limit: z.coerce.number().int().min(1).max(40).default(20),
});

r.get('/videos', wrap(async (req, res) => {
  const p = listQuery.parse(req.query);
  const { rows, hasMore } = await listVideos({ ...p, offset: p.page * p.limit });
  res.json({ items: rows.map((v) => videoDto(v)), has_more: hasMore, page: p.page });
}));

// Home feed: Shorts section, then 4-5 long videos, then more Shorts ... (one pair per page).
r.get('/feed/home', wrap(async (req, res) => {
  const page = z.coerce.number().int().min(0).max(200).parse(req.query.page ?? 0);
  const SHORTS = 10, LONGS = 5;
  const [s, l] = await Promise.all([
    listVideos({ kind: 'short', sort: 'trending', limit: SHORTS, offset: page * SHORTS }),
    listVideos({ kind: 'long', sort: 'trending', limit: LONGS, offset: page * LONGS }),
  ]);
  res.json({ page, shorts: s.rows.map((v) => videoDto(v)), long: l.rows.map((v) => videoDto(v)), has_more: s.hasMore || l.hasMore });
}));

// ---------- Creator: own videos ----------
r.get('/me/videos', requireAuth, wrap(async (req, res) => {
  const ch = await ownerChannel(req);
  if (!ch) return res.json({ items: [] });
  const all = await db.query(`select v.*, c.name as channel_name, c.handle as channel_handle, c.avatar_key as channel_avatar_key,
        cat.slug as category_slug, cat.name as category_name
      from videos v join channels c on c.id = v.channel_id left join categories cat on cat.id = v.category_id
      where v.channel_id = $1 and v.status <> 'removed' order by v.created_at desc limit 200`, [ch.id]);
  res.json({ items: all.map((v) => videoDto(v, { detail: true, owner: true })) });
}));

r.post('/videos', requireAuth, requireUploader, wrap(async (req, res) => {
  const body = metaSchema.parse(req.body);
  if (body.category_id && !(await db.one('select 1 from categories where id = $1 and is_active', [body.category_id]))) throw badRequest('Unknown category');
  const row = await db.one(
    `insert into videos (public_id, channel_id, kind, title, description, category_id, tags, status)
     values ($1,$2,$3,$4,$5,$6,$7,'draft') returning public_id`,
    [publicId(), req.channel.id, body.kind, body.title, body.description, body.category_id || null, body.tags],
  );
  const v = await getVideoRowByPublicId(row.public_id);
  res.status(201).json({ video: videoDto(v, { detail: true, owner: true }) });
}));

async function uploadHandler(req, res) {
  const { row, ch } = await ownedVideo(req);
  if (!['draft'].includes(row.status)) throw conflict('This video has already been uploaded', 'already_uploaded');
  const video = req.files?.video?.[0];
  if (!video) throw badRequest('Choose a video file');
  const upload = await getSetting('upload');
  const maxBytes = (row.kind === 'short' ? upload.short_max_mb : upload.long_max_mb) * 1024 * 1024;
  const fail = async (msg) => {
    await db.query(`update videos set status = 'draft', error_message = $2, updated_at = now() where id = $1`, [row.id, msg]);
    throw badRequest(msg);
  };
  try {
    if (video.size > maxBytes) await fail(`File is too large. Maximum for a ${row.kind === 'short' ? 'Short' : 'long video'} is ${Math.round(maxBytes / 1048576)} MB.`);
    const kind = await sniff(video.path);
    if (!kind || kind.type !== 'video') await fail('That file is not a supported video.');
    if (!upload.allowed_formats.includes(kind.format)) await fail(`Format .${kind.format} is not allowed. Allowed: ${upload.allowed_formats.join(', ')}.`);

    await db.query(`update videos set status = 'uploading', error_message = null, updated_at = now() where id = $1`, [row.id]);
    const storage = await getStorage();
    const origKey = `originals/${fileId()}${extFor(kind.format)}`;
    await storage.put(origKey, video.path, kind.mime);

    let thumbKey = null;
    const thumb = req.files?.thumbnail?.[0];
    if (thumb) {
      try { thumbKey = await storeThumbnail(thumb, row.kind, storage); } catch (e) { await fail(e.message); }
    }
    await db.query(
      `update videos set original_key = $2, mime = $3, size_bytes = $4, thumbnail_key = coalesce($5, thumbnail_key),
              custom_thumbnail = $6, status = 'processing', error_message = null, updated_at = now() where id = $1`,
      [row.id, origKey, kind.mime, video.size, thumbKey, !!thumbKey],
    );
    await enqueueProcessing(row.id);
  } catch (e) {
    // Return the video to Draft if we failed after marking it uploading.
    await db.query(`update videos set status = 'draft', error_message = coalesce(error_message, $2), updated_at = now() where id = $1 and status = 'uploading'`,
      [row.id, 'Upload failed. Please try again.']);
    throw e;
  } finally {
    await cleanupFiles(req);
  }
  const v = await getVideoRowByPublicId(row.public_id);
  res.status(202).json({ video: videoDto(v, { detail: true, owner: true }) });
}

r.post('/videos/:id/upload', requireAuth, requireUploader, wrap(async (req, res, next) => {
  const upload = await getSetting('upload');
  const mb = Math.max(upload.short_max_mb, upload.long_max_mb);
  uploader([{ name: 'video', maxBytes: mb * 1024 * 1024 }, { name: 'thumbnail', maxBytes: upload.thumbnail_max_mb * 1024 * 1024 }])(req, res, (err) => {
    if (err) return next(err);
    uploadHandler(req, res).catch(async (e) => { await cleanupFiles(req); next(e); });
  });
}));

// ---------- Thumbnail changes (after the video exists) ----------
const thumbUpload = (req, res, next) => getSetting('upload').then((u) =>
  uploader([{ name: 'thumbnail', maxBytes: u.thumbnail_max_mb * 1024 * 1024 }])(req, res, next)).catch(next);

async function swapThumbnail(row, newKey) {
  const storage = await getStorage();
  const old = row.thumbnail_key;
  await db.query(`update videos set thumbnail_key = $2, custom_thumbnail = true, updated_at = now() where id = $1`, [row.id, newKey]);
  if (old && old !== newKey) await storage.remove(old).catch(() => {});
}

r.post('/videos/:id/thumbnail', requireAuth, requireUploader, thumbUpload, wrap(async (req, res) => {
  try {
    const { row } = await ownedVideo(req);
    if (row.status === 'removed') throw forbidden('This video was removed');
    const file = req.files?.thumbnail?.[0];
    if (!file) throw badRequest('Choose an image');
    await swapThumbnail(row, await storeThumbnail(file, row.kind, await getStorage()));
    const v = await getVideoRowByPublicId(row.public_id);
    res.json({ video: videoDto(v, { detail: true, owner: true }) });
  } finally {
    await cleanupFiles(req);
  }
}));

// Server-side frame grab (needs ffmpeg). Browsers normally capture the frame themselves.
r.post('/videos/:id/thumbnail/frame', requireAuth, requireUploader, wrap(async (req, res) => {
  const { row } = await ownedVideo(req);
  if (row.status === 'removed') throw forbidden('This video was removed');
  const at = z.object({ at: z.number().min(0).max(36000) }).parse(req.body).at;
  if (!row.original_key) throw conflict('Upload the video first', 'no_video');
  if (!(await hasFfmpeg())) throw conflict('This server cannot extract frames. Pick the frame in your browser or upload an image instead.', 'no_ffmpeg');
  const storage = await getStorage();
  const work = path.join(config.storage.tmpDir, `frame-${fileId()}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const src = path.join(work, `src${path.extname(row.original_key) || '.mp4'}`);
    await storage.download(row.original_key, src);
    const out = path.join(work, 'frame.jpg');
    const dur = Number(row.duration_seconds) || at + 1;
    try { await makeThumbnail(src, out, { kind: row.kind, at: Math.min(at, Math.max(0, dur - 0.2)) }); }
    catch { throw badRequest('Could not capture a frame at that time. Try a different moment.'); }
    const key = `thumbs/${fileId()}.jpg`;
    await storage.put(key, out, 'image/jpeg');
    await swapThumbnail(row, key);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
  const v = await getVideoRowByPublicId(row.public_id);
  res.json({ video: videoDto(v, { detail: true, owner: true }) });
}));

r.get('/videos/:id/status', requireAuth, wrap(async (req, res) => {
  const { row } = await ownedVideo(req);
  const job = await db.one(`select status, attempts, last_error from video_jobs where video_id = $1 order by created_at desc limit 1`, [row.id]);
  res.json({ status: row.status, error_message: row.error_message, job });
}));

r.post('/videos/:id/retry', requireAuth, requireUploader, wrap(async (req, res) => {
  const { row } = await ownedVideo(req);
  if (row.status !== 'draft' || !row.original_key) throw conflict('Nothing to retry; please upload the file again', 'cannot_retry');
  await db.query(`update videos set status = 'processing', error_message = null, updated_at = now() where id = $1`, [row.id]);
  await enqueueProcessing(row.id);
  res.json({ ok: true });
}));

r.patch('/videos/:id', requireAuth, wrap(async (req, res) => {
  const { row } = await ownedVideo(req);
  if (row.status === 'removed') throw forbidden('This video was removed');
  const body = metaSchema.omit({ kind: true }).partial().parse(req.body);
  if (body.category_id && !(await db.one('select 1 from categories where id = $1 and is_active', [body.category_id]))) throw badRequest('Unknown category');
  await db.query(
    `update videos set title = $2, description = $3, category_id = $4, tags = $5, updated_at = now() where id = $1`,
    [row.id, body.title ?? row.title, body.description ?? row.description,
      'category_id' in body ? body.category_id || null : (await db.one('select category_id from videos where id = $1', [row.id])).category_id,
      body.tags ?? row.tags],
  );
  const v = await getVideoRowByPublicId(row.public_id);
  res.json({ video: videoDto(v, { detail: true, owner: true }) });
}));

r.delete('/videos/:id', requireAuth, wrap(async (req, res) => {
  const { row } = await ownedVideo(req);
  const storage = await getStorage();
  if (row.status === 'draft') {
    for (const k of [row.original_key, row.thumbnail_key, row.playback_key]) if (k) await storage.remove(k).catch(() => {});
    await db.query('delete from videos where id = $1', [row.id]);
    return res.json({ ok: true, deleted: true });
  }
  await db.query(`update videos set status = 'removed', removed_at = now(), removed_by = 'creator', removed_reason = 'Removed by creator',
                    featured = false, pinned_rank = null, updated_at = now() where id = $1`, [row.id]);
  res.json({ ok: true });
}));

// ---------- Video detail ----------
async function canView(req, row) {
  if (isPubliclyVisible(row)) return true;
  if (req.user) {
    const ch = await db.one('select id from channels where user_id = $1', [req.user.id]);
    if (ch && ch.id === row.channel_id && row.status !== 'removed') return true;
    if (req.user.role === 'super_admin' || req.user.role === 'moderator') return true;
  }
  return false;
}
export { canView };

r.get('/videos/:id', wrap(async (req, res) => {
  const row = await getVideoRowByPublicId(req.params.id);
  if (!row || !(await canView(req, row))) throw notFound('Video not found');
  const channelRow = await db.one('select * from channels where id = $1', [row.channel_id]);
  const telegram = await resolveTelegram(channelRow);
  const actor = actorFor(req, res);
  let my_reaction = null, saved = false;
  if (actor) {
    my_reaction = (await db.one('select type from reactions where video_id = $1 and actor_key = $2', [row.id, actor.key]))?.type || null;
  }
  if (req.user) saved = !!(await db.one('select 1 from saved_videos where user_id = $1 and video_id = $2', [req.user.id, row.id]));
  const owner = req.user && channelRow.user_id === req.user.id;
  const settings = await getSetting('moderation');
  res.json({
    video: { ...videoDto(row, { detail: true, owner: !!owner }), telegram, my_reaction, saved, comments_enabled: settings.comments_enabled },
    visible_to_public: isPubliclyVisible(row),
  });
}));

r.get('/videos/:id/related', wrap(async (req, res) => {
  const row = await getVideoRowByPublicId(req.params.id);
  if (!row || !(await canView(req, row))) throw notFound('Video not found');
  const limit = Math.min(Number(req.query.limit) || 12, 24);
  const same = await listVideos({ kind: row.kind, category: row.category_slug || undefined, sort: 'trending', limit, excludeIds: [row.public_id] });
  let items = same.rows;
  if (items.length < limit) {
    const more = await listVideos({ kind: row.kind, sort: 'trending', limit: limit - items.length, excludeIds: [row.public_id, ...items.map((i) => i.public_id)] });
    items = items.concat(more.rows);
  }
  res.json({ items: items.map((v) => videoDto(v)) });
}));

export default r;
