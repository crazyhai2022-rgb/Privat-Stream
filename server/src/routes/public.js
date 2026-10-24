import { Router } from 'express';
import { db } from '../db/index.js';
import { wrap, notFound } from '../lib/errors.js';
import { getSettings } from '../services/settings.js';
import { normalizeTelegramUrl } from '../services/telegram.js';
import { getVideoRowByPublicId, isPubliclyVisible } from '../services/videos.js';
import { getStorage } from '../storage/index.js';
import { canView } from './videos.js';

export const api = Router();
export const media = Router();

api.get('/config', wrap(async (req, res) => {
  const s = await getSettings();
  const categories = await db.query(`select id, slug, name from categories where is_active order by sort_order, name`);
  res.json({
    brand: s.brand,
    ads: s.ads,
    upload: {
      short_max_seconds: s.upload.short_max_seconds, short_max_mb: s.upload.short_max_mb,
      long_max_seconds: s.upload.long_max_seconds, long_max_mb: s.upload.long_max_mb,
      allowed_formats: s.upload.allowed_formats, thumbnail_max_mb: s.upload.thumbnail_max_mb,
    },
    comments_enabled: s.moderation.comments_enabled,
    policies: s.policies,
    telegram_default: normalizeTelegramUrl(s.telegram.global_url),
    categories,
  });
}));

api.get('/categories', wrap(async (req, res) => {
  const rows = await db.query(
    `select c.id, c.slug, c.name,
            count(v.id) filter (where v.kind = 'short')::int as shorts,
            count(v.id) filter (where v.kind = 'long')::int as longs
       from categories c
       left join videos v on v.category_id = c.id and v.status = 'published'
         and exists (select 1 from channels ch where ch.id = v.channel_id and ch.status = 'approved')
      where c.is_active group by c.id order by c.sort_order, c.name`);
  res.json({ items: rows });
}));

// ---- Media: playback / thumbnails go through an access check; images are public ----
async function serveVideoFile(req, res, next, field, contentType) {
  try {
    const row = await getVideoRowByPublicId(req.params.id);
    if (!row || !row[field]) throw notFound();
    const visible = isPubliclyVisible(row);
    if (!visible && !(await canView(req, row))) throw notFound();
    const storage = await getStorage();
    await storage.serve(req, res, row[field], {
      contentType: contentType || row.mime,
      cache: visible ? 'public, max-age=3600' : 'private, no-store',
    });
  } catch (e) {
    if (e.code === 'ENOENT' || e.status === 404) return next(notFound());
    next(e);
  }
}

media.get('/stream/:id', (req, res, next) => serveVideoFile(req, res, next, 'playback_key', null));
media.get('/thumb/:id', (req, res, next) => serveVideoFile(req, res, next, 'thumbnail_key', 'image/jpeg'));

media.get(/^\/media\/img\/((?:avatars|banners)\/[a-z0-9]+\.jpg)$/, async (req, res, next) => {
  try {
    const storage = await getStorage();
    await storage.serve(req, res, req.params[0], { contentType: 'image/jpeg', cache: 'public, max-age=86400' });
  } catch (e) {
    if (e.code === 'ENOENT') return next(notFound());
    next(e);
  }
});
