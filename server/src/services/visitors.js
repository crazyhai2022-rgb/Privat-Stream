// Privacy-light visitor analytics. A visit is one row per pseudonymous visitor per day (an HMAC of a
// random cookie, or the account id): no IP address, no page paths, no user agent is stored, and it
// never touches the money tables. Administrators and obvious bots are not counted.
import { db } from '../db/index.js';

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python-requests|httpclient/i;
export const isBot = (ua) => !ua || BOT.test(String(ua));

/** Counts a page view for today. Returns true when it was recorded. */
export async function recordVisit({ key, userId = null, userAgent = '' }) {
  if (!key || isBot(userAgent)) return false;
  await db.query(
    `insert into visitor_days (day, visitor_key, is_new, user_id, views)
     select current_date, $1, not exists (select 1 from visitor_days where visitor_key = $1), $2, 1
     on conflict (day, visitor_key) do update
       set views = visitor_days.views + 1, user_id = coalesce(visitor_days.user_id, excluded.user_id)`,
    [key, userId]);
  return true;
}

export async function visitorStats(days = 30) {
  days = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
  const series = await db.query(
    `select d::date::text as day,
            count(v.visitor_key)::int as visitors,
            count(v.visitor_key) filter (where v.is_new)::int as new_visitors,
            count(v.visitor_key) filter (where not v.is_new)::int as returning_visitors,
            count(v.visitor_key) filter (where v.user_id is not null)::int as signed_in,
            coalesce(sum(v.views), 0)::int as pageviews
       from generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
       left join visitor_days v on v.day = d::date
      group by d order by d`, [days]);
  const totals = await db.one(
    `select count(distinct visitor_key)::int as unique_visitors,
            count(distinct visitor_key) filter (where is_new)::int as new_visitors,
            count(distinct visitor_key) filter (where user_id is not null)::int as signed_in,
            coalesce(sum(views), 0)::int as pageviews
       from visitor_days where day > current_date - $1::int`, [days]);
  const today = series[series.length - 1] || { visitors: 0, pageviews: 0 };
  const yesterday = series[series.length - 2] || { visitors: 0, pageviews: 0 };
  const topVideos = await db.query(
    `select v.public_id, v.title, v.kind, c.name as channel_name, count(*)::int as views
       from video_events e join videos v on v.id = e.video_id join channels c on c.id = v.channel_id
      where e.type = 'view' and e.created_at > now() - make_interval(days => $1::int)
      group by v.id, c.name order by views desc limit 10`, [days]);
  const kinds = await db.query(
    `select v.kind, count(*)::int as views, count(distinct e.actor_key)::int as viewers
       from video_events e join videos v on v.id = e.video_id
      where e.type = 'view' and e.created_at > now() - make_interval(days => $1::int) group by v.kind`, [days]);
  const hours = await db.query(
    `select extract(hour from created_at at time zone 'UTC')::int as hour, count(*)::int as views
       from video_events where type = 'view' and created_at > now() - make_interval(days => $1::int) group by 1 order by 1`, [days]);
  return {
    days, series, totals, today, yesterday, top_videos: topVideos, by_kind: kinds,
    by_hour_utc: Array.from({ length: 24 }, (_, h) => ({ hour: h, views: hours.find((x) => x.hour === h)?.views || 0 })),
  };
}

export const purgeOldVisitors = (keepDays = 400) =>
  db.query(`delete from visitor_days where day < current_date - $1::int returning 1 as x`, [keepDays]).then((r) => r.length);
