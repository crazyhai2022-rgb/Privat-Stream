import { config } from '../config.js';
import { db } from '../db/index.js';
import { getSetting } from './settings.js';
import { imageUrl } from './serializers.js';

export const SORTS = ['trending', 'views', 'hearts', 'dislikes', 'comments', 'shares', 'recent', 'featured'];

const BASE_SELECT = `
  v.id, v.public_id, v.visibility, v.kind, v.title, v.description, v.tags, v.status, v.error_message,
  v.duration_seconds, v.width, v.height, v.featured, v.pinned_rank, v.published_at, v.created_at,
  v.views_count, v.unique_views_count, v.hearts_count, v.dislikes_count, v.comments_count, v.shares_count, v.saves_count,
  v.thumbnail_key, v.playback_key, v.rejected_reason, v.removed_reason,
  c.id as channel_id, c.name as channel_name, c.handle as channel_handle, c.avatar_key as channel_avatar_key,
  c.telegram_url as channel_telegram_url, c.telegram_enabled as channel_telegram_enabled, c.status as channel_status,
  cat.slug as category_slug, cat.name as category_name`;
const BASE_FROM = `
  from videos v
  join channels c on c.id = v.channel_id
  left join categories cat on cat.id = v.category_id`;

const mediaUrl = (path, row) => (config.cdn.baseUrl && row.status === 'published' && row.channel_status === 'approved' ? config.cdn.baseUrl + path : path);

export const videoDto = (row, { detail = false, owner = false } = {}) => ({
  id: row.public_id,
  kind: row.kind,
  title: row.title,
  description: detail || row.kind === 'short' ? row.description : undefined,
  caption: row.kind === 'short' ? row.description : undefined,
  tags: row.tags || [],
  status: row.status,
  duration: row.duration_seconds === null ? null : Number(row.duration_seconds),
  width: row.width,
  height: row.height,
  featured: row.featured,
  published_at: row.published_at,
  created_at: row.created_at,
  // Published videos come from the CDN when one is configured; anything not public stays on the origin.
  thumbnail_url: row.thumbnail_key ? mediaUrl(`/thumb/${row.public_id}`, row) : null,
  stream_url: row.playback_key ? mediaUrl(`/stream/${row.public_id}`, row) : null,
  category: row.category_slug ? { slug: row.category_slug, name: row.category_name } : null,
  channel: {
    name: row.channel_name,
    handle: row.channel_handle,
    avatar_url: imageUrl(row.channel_avatar_key),
  },
  // Every metric is its own number; nothing is merged into a single "score".
  metrics: {
    views: row.views_count,
    hearts: row.hearts_count,
    dislikes: row.dislikes_count,
    comments: row.comments_count,
    shares: row.shares_count,
    saves: row.saves_count,
    ...(owner ? { unique_views: row.unique_views_count } : {}),
  },
  ...(owner ? { visibility: row.visibility, error_message: row.error_message, rejected_reason: row.rejected_reason, removed_reason: row.removed_reason } : {}),
});

function trendingCte(t, paramStart) {
  // Parameters: window hours, half-life, weights... see docs/TRENDING.md.
  const p = (i) => `$${paramStart + i}`;
  return {
    sql: `
    win as (select now() - make_interval(hours => ${p(0)}::int) as since),
    ev as (
      select e.video_id,
             count(distinct e.actor_key) filter (where e.type = 'view')::float as v,
             count(distinct e.actor_key) filter (where e.type = 'share')::float as s
        from video_events e, win where e.created_at >= win.since group by e.video_id),
    rx as (
      select r.video_id,
             count(*) filter (where r.type = 'heart')::float as h,
             count(*) filter (where r.type = 'dislike')::float as d
        from reactions r, win where r.created_at >= win.since group by r.video_id),
    cm as (
      select m.video_id, count(*)::float as c
        from comments m, win where m.status = 'visible' and m.created_at >= win.since group by m.video_id),
    score as (
      select v.id as video_id,
        greatest(0,
          ${p(2)}::float * coalesce(ev.v, 0) + ${p(3)}::float * coalesce(rx.h, 0) + ${p(4)}::float * coalesce(ev.s, 0)
          + ${p(5)}::float * coalesce(cm.c, 0) - ${p(6)}::float * coalesce(rx.d, 0))
        * (1 + ${p(7)}::float * least(1, (coalesce(rx.h, 0) + coalesce(ev.s, 0) + coalesce(cm.c, 0)) / greatest(coalesce(ev.v, 0), 1)))
        * greatest(0.1, power(0.5, extract(epoch from (now() - coalesce(v.published_at, v.created_at))) / 3600.0 / ${p(1)}::float))
        as trending_score
      from videos v
      left join ev on ev.video_id = v.id left join rx on rx.video_id = v.id left join cm on cm.video_id = v.id)`,
    params: [t.window_hours, t.half_life_hours, t.w_views, t.w_hearts, t.w_shares, t.w_comments, t.w_dislikes, t.w_engagement],
  };
}

const ORDER = {
  views: 'v.views_count desc, v.published_at desc',
  hearts: 'v.hearts_count desc, v.published_at desc',
  dislikes: 'v.dislikes_count desc, v.published_at desc',
  comments: 'v.comments_count desc, v.published_at desc',
  shares: 'v.shares_count desc, v.published_at desc',
  recent: 'v.published_at desc',
  featured: '(v.pinned_rank is null), v.pinned_rank asc, v.featured_at desc nulls last, v.published_at desc',
  trending: '(v.pinned_rank is null), v.pinned_rank asc, s.trending_score desc, v.published_at desc',
  random: 'random()', // internal: used by recommendations only, never exposed through SORTS
};

/** Public listing: only published videos from approved, non-suspended channels. */
export async function listVideos({ kind, sort = 'trending', category, q, channel, limit = 20, offset = 0, excludeIds = [], admin = false, status,
  affinity = null, notAffinity = null, publishedWithinDays = 0 } = {}) {
  if (!SORTS.includes(sort) && sort !== 'random') sort = 'trending';
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];
  if (!admin) {
    where.push(`v.status = 'published'`);
    where.push(`v.visibility = 'public'`);
    where.push(`c.status = 'approved'`);
  } else if (status) {
    where.push(`v.status = ${add(status)}`);
  }
  if (kind) where.push(`v.kind = ${add(kind)}`);
  if (category) where.push(`cat.slug = ${add(category)}`);
  if (channel) where.push(`lower(c.handle) = ${add(String(channel).toLowerCase())}`);
  if (sort === 'featured') where.push('v.featured');
  if (q) {
    const like = add(`%${String(q).replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    where.push(`(v.title ilike ${like} or v.description ilike ${like} or c.handle ilike ${like} or c.name ilike ${like}
      or cat.name ilike ${like} or exists (select 1 from unnest(v.tags) tg where tg ilike ${like}))`);
  }
  if (excludeIds.length) where.push(`v.public_id <> all(${add(excludeIds)}::text[])`);
  // Recommendation filters: videos in (or outside) a set of categories / channels, and recency.
  const aff = (a) => `(coalesce(v.category_id = any(${add(a.categoryIds || [])}::uuid[]), false) or v.channel_id = any(${add(a.channelIds || [])}::uuid[]))`;
  if (affinity) where.push(aff(affinity));
  if (notAffinity) where.push(`not ${aff(notAffinity)}`);
  if (publishedWithinDays > 0) where.push(`coalesce(v.published_at, v.created_at) > now() - make_interval(days => ${add(Math.floor(publishedWithinDays))}::int)`);

  let withSql = '';
  let join = '';
  if (sort === 'trending') {
    const t = await getSetting('trending');
    const start = params.length + 1;
    const cte = trendingCte(t, start);
    params.push(...cte.params);
    withSql = `with ${cte.sql}`;
    join = 'join score s on s.video_id = v.id';
  }
  const lim = add(limit + 1);
  const off = add(offset);
  const sql = `${withSql} select ${BASE_SELECT}${sort === 'trending' ? ', s.trending_score' : ''} ${BASE_FROM} ${join}
    ${where.length ? 'where ' + where.join(' and ') : ''} order by ${ORDER[sort]} limit ${lim} offset ${off}`;
  const rows = await db.query(sql, params);
  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore };
}

export async function getVideoRowByPublicId(publicId) {
  return db.one(`select ${BASE_SELECT}, v.original_key, v.custom_thumbnail, v.mime ${BASE_FROM} where v.public_id = $1`, [publicId]);
}
export async function getVideoRowById(id) {
  return db.one(`select ${BASE_SELECT}, v.original_key, v.custom_thumbnail, v.mime ${BASE_FROM} where v.id = $1`, [id]);
}

// Recompute every counter from the source-of-truth tables (used for repair and after moderation).
export async function recountVideo(q, videoId) {
  await q(`update videos set
      hearts_count = (select count(*) from reactions where video_id = $1 and type = 'heart'),
      dislikes_count = (select count(*) from reactions where video_id = $1 and type = 'dislike'),
      comments_count = (select count(*) from comments where video_id = $1 and status = 'visible'),
      saves_count = (select count(*) from saved_videos where video_id = $1),
      shares_count = (select count(*) from video_events where video_id = $1 and type = 'share'),
      views_count = (select count(*) from video_events where video_id = $1 and type = 'view'),
      unique_views_count = (select count(distinct actor_key) from video_events where video_id = $1 and type = 'view'),
      updated_at = now()
    where id = $1`, [videoId]);
}

export function isPubliclyVisible(row) {
  return row.status === 'published' && row.channel_status === 'approved' && row.visibility !== 'private';
}

export async function trendingScoreFor(videoId) {
  const t = await getSetting('trending');
  const cte = trendingCte(t, 1);
  const rows = await db.query(`with ${cte.sql} select trending_score from score where video_id = $${cte.params.length + 1}`, [...cte.params, videoId]);
  return rows[0] ? Number(rows[0].trending_score) : 0;
}
