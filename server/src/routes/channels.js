import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { wrap, badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { requireAuth, requireVerified } from '../middleware/core.js';
import { channelDto } from '../services/serializers.js';
import { normalizeTelegramUrl, resolveTelegram } from '../services/telegram.js';
import { getStorage } from '../storage/index.js';
import { uploader, cleanupFiles } from '../lib/uploads.js';
import { sniff, hasFfmpeg, processImage } from '../lib/media.js';
import { fileId } from '../lib/crypto.js';
import { audit } from '../services/audit.js';
import { meSummary } from './auth.js';

const r = Router();

const RESERVED = new Set(['admin', 'api', 'shorts', 'watch', 'c', 'upload', 'studio', 'login', 'register', 'settings', 'saved', 'category',
  'categories', 'search', 'media', 'stream', 'thumb', 'static', 'verify-email', 'forgot-password', 'reset-password', 'long', 'home', 'support', 'help']);

const handle = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/, 'Handle must be 3-30 characters: letters, numbers, underscore')
  .refine((h) => !RESERVED.has(h), 'This handle is reserved');
const telegram = z.string().trim().max(300).optional().nullable().transform((v) => (v ? v : null));

async function setCategories(q, channelId, ids) {
  if (!ids) return;
  const valid = ids.length ? await q('select id from categories where id = any($1::uuid[]) and is_active', [ids]) : [];
  await q('delete from channel_categories where channel_id = $1', [channelId]);
  for (const c of valid) await q('insert into channel_categories (channel_id, category_id) values ($1,$2)', [channelId, c.id]);
}

async function categoriesOf(channelId) {
  return db.query(`select c.id, c.slug, c.name from channel_categories cc join categories c on c.id = cc.category_id where cc.channel_id = $1 order by c.sort_order, c.name`, [channelId]);
}

// ---------- Owner endpoints ----------
r.post('/me/channel', requireVerified, wrap(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(50),
    handle,
    bio: z.string().trim().max(500).default(''),
    category_ids: z.array(z.string().uuid()).max(5).default([]),
    telegram_url: telegram,
  }).parse(req.body);
  if (await db.one('select 1 from channels where user_id = $1', [req.user.id])) throw conflict('You already have a channel', 'channel_exists');
  let tg = null;
  if (body.telegram_url) {
    tg = normalizeTelegramUrl(body.telegram_url);
    if (!tg) throw badRequest('Telegram link must be a valid https://t.me/... link');
  }
  let channel;
  try {
    channel = await db.tx(async (q) => {
      const [c] = await q(`insert into channels (user_id, name, handle, bio, telegram_url) values ($1,$2,$3,$4,$5) returning *`,
        [req.user.id, body.name, body.handle, body.bio, tg]);
      await setCategories(q, c.id, body.category_ids);
      return c;
    });
  } catch (e) {
    if (String(e.message).includes('channels_handle_lower_uq') || e.code === '23505') throw conflict('This handle is already taken', 'handle_taken');
    throw e;
  }
  await audit(req, 'channel.create', 'channel', channel.id, { handle: channel.handle });
  res.status(201).json(await meSummary(req));
}));

r.patch('/me/channel', requireAuth, wrap(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(50).optional(),
    handle: handle.optional(),
    bio: z.string().trim().max(500).optional(),
    category_ids: z.array(z.string().uuid()).max(5).optional(),
    telegram_url: telegram,
    telegram_enabled: z.boolean().optional(),
    resubmit: z.boolean().optional(),
  }).parse(req.body);
  const ch = await db.one('select * from channels where user_id = $1', [req.user.id]);
  if (!ch) throw notFound('You do not have a channel yet');
  let tg = ch.telegram_url;
  if ('telegram_url' in req.body) {
    tg = body.telegram_url ? normalizeTelegramUrl(body.telegram_url) : null;
    if (body.telegram_url && !tg) throw badRequest('Telegram link must be a valid https://t.me/... link');
  }
  const nextStatus = body.resubmit && ch.status === 'rejected' ? 'pending' : ch.status;
  try {
    await db.tx(async (q) => {
      await q(`update channels set name = $2, handle = $3, bio = $4, telegram_url = $5, telegram_enabled = $6, status = $7,
                 status_reason = case when $7 = 'pending' then null else status_reason end, updated_at = now() where id = $1`,
        [ch.id, body.name ?? ch.name, body.handle ?? ch.handle, body.bio ?? ch.bio, tg, body.telegram_enabled ?? ch.telegram_enabled, nextStatus]);
      await setCategories(q, ch.id, body.category_ids);
    });
  } catch (e) {
    if (e.code === '23505' || String(e.message).includes('channels_handle_lower_uq')) throw conflict('This handle is already taken', 'handle_taken');
    throw e;
  }
  res.json(await meSummary(req));
}));

async function saveImage(req, kind) {
  const file = req.files?.image?.[0];
  if (!file) throw badRequest('Choose an image file');
  try {
    const type = await sniff(file.path);
    if (!type || type.type !== 'image') throw badRequest('Only JPEG, PNG or WebP images are allowed');
    const storage = await getStorage();
    const key = `${kind === 'avatar' ? 'avatars' : 'banners'}/${fileId()}.jpg`;
    let src = file.path;
    let out = file.path;
    if (await hasFfmpeg()) {
      out = path.join(config.storage.tmpDir, `img-${fileId()}.jpg`);
      await processImage(src, out, kind === 'avatar' ? { width: 400, height: 400, crop: true } : { width: 1500, height: 500, crop: true });
    } else if (config.isProd) {
      throw badRequest('Image processing is unavailable');
    }
    await storage.put(key, out, out === file.path ? type.mime : 'image/jpeg');
    if (out !== file.path) await fsp.rm(out, { force: true });
    return key;
  } finally {
    await cleanupFiles(req);
  }
}

for (const kind of ['avatar', 'banner']) {
  const maxBytes = kind === 'avatar' ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
  r.post(`/me/channel/${kind}`, requireAuth, uploader([{ name: 'image', maxBytes }]), wrap(async (req, res) => {
    const ch = await db.one('select * from channels where user_id = $1', [req.user.id]);
    if (!ch) { await cleanupFiles(req); throw notFound('Create your channel first'); }
    const key = await saveImage(req, kind);
    const col = kind === 'avatar' ? 'avatar_key' : 'banner_key';
    const old = ch[col];
    await db.query(`update channels set ${col} = $2, updated_at = now() where id = $1`, [ch.id, key]);
    if (old) (await getStorage()).remove(old).catch(() => {});
    res.json(await meSummary(req));
  }));
  r.delete(`/me/channel/${kind}`, requireAuth, wrap(async (req, res) => {
    const col = kind === 'avatar' ? 'avatar_key' : 'banner_key';
    const ch = await db.one('select * from channels where user_id = $1', [req.user.id]);
    if (!ch) throw notFound();
    await db.query(`update channels set ${col} = null, updated_at = now() where id = $1`, [ch.id]);
    if (ch[col]) (await getStorage()).remove(ch[col]).catch(() => {});
    res.json(await meSummary(req));
  }));
}

r.get('/me/channel/details', requireAuth, wrap(async (req, res) => {
  const ch = await db.one('select * from channels where user_id = $1', [req.user.id]);
  if (!ch) return res.json({ channel: null });
  res.json({ channel: channelDto(ch, { categories: await categoriesOf(ch.id) }) });
}));

r.get('/me/channel/stats', requireAuth, wrap(async (req, res) => {
  const ch = await db.one('select id from channels where user_id = $1', [req.user.id]);
  if (!ch) return res.json({ totals: null });
  const t = await db.one(`select
      count(*)::int as videos,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where status = 'pending_moderation')::int as pending,
      coalesce(sum(views_count), 0)::int as views, coalesce(sum(unique_views_count), 0)::int as unique_views,
      coalesce(sum(hearts_count), 0)::int as hearts, coalesce(sum(dislikes_count), 0)::int as dislikes,
      coalesce(sum(comments_count), 0)::int as comments, coalesce(sum(shares_count), 0)::int as shares,
      coalesce(sum(saves_count), 0)::int as saves
    from videos where channel_id = $1 and status <> 'removed'`, [ch.id]);
  res.json({ totals: t });
}));

// ---------- Public channel ----------
r.get('/channels/:handle', wrap(async (req, res) => {
  const h = String(req.params.handle || '').toLowerCase();
  const ch = await db.one(`select c.*, u.account_status from channels c join users u on u.id = c.user_id where lower(c.handle) = $1`, [h]);
  const isOwner = req.user && ch && ch.user_id === req.user.id;
  if (!ch || (!isOwner && (ch.status !== 'approved' || ch.account_status !== 'active'))) throw notFound('Channel not found');
  const stats = await db.one(`select count(*) filter (where kind = 'short')::int as shorts, count(*) filter (where kind = 'long')::int as longs,
      coalesce(sum(views_count), 0)::int as views from videos where channel_id = $1 and status = 'published'`, [ch.id]);
  const tg = await resolveTelegram(ch);
  const sub = await subscriptionState(ch.id, req.user?.id);
  const dto = channelDto(ch, { categories: await categoriesOf(ch.id), stats, telegram: tg, subscribers: sub.subscribers, subscribed: sub.subscribed });
  if (!isOwner) { delete dto.telegram_url; delete dto.telegram_enabled; delete dto.status_reason; }
  res.json({ channel: dto, is_owner: !!isOwner });
}));

// ---------- Subscriptions ----------
async function subscriptionState(channelId, userId) {
  const { n } = await db.one('select count(*)::int as n from channel_subscriptions where channel_id = $1', [channelId]);
  const mine = userId ? await db.one('select 1 as x from channel_subscriptions where channel_id = $1 and user_id = $2', [channelId, userId]) : null;
  return { subscribers: n, subscribed: !!mine };
}

async function publicChannel(req) {
  const ch = await db.one(`select c.id, c.user_id, c.status, u.account_status from channels c join users u on u.id = c.user_id where lower(c.handle) = $1`,
    [String(req.params.handle || '').toLowerCase()]);
  if (!ch || ch.status !== 'approved' || ch.account_status !== 'active') throw notFound('Channel not found');
  return ch;
}

r.get('/channels/:handle/subscription', wrap(async (req, res) => {
  const ch = await publicChannel(req);
  res.json(await subscriptionState(ch.id, req.user?.id));
}));

// Subscribing and unsubscribing are idempotent: repeating either returns the same final state.
r.post('/channels/:handle/subscribe', requireAuth, wrap(async (req, res) => {
  const ch = await publicChannel(req);
  if (ch.user_id === req.user.id) throw badRequest('You cannot subscribe to your own channel');
  if (req.user.account_status !== 'active') throw forbidden('Your account cannot subscribe right now');
  await db.query('insert into channel_subscriptions (channel_id, user_id) values ($1,$2) on conflict do nothing', [ch.id, req.user.id]);
  res.json(await subscriptionState(ch.id, req.user.id));
}));

r.delete('/channels/:handle/subscribe', requireAuth, wrap(async (req, res) => {
  const ch = await publicChannel(req);
  await db.query('delete from channel_subscriptions where channel_id = $1 and user_id = $2', [ch.id, req.user.id]);
  res.json(await subscriptionState(ch.id, req.user.id));
}));

export default r;
