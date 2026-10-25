// "For you" recommendations. Per 10 videos, by default: 5 from what the viewer already watches,
// 3 that are new on the platform and 2 from outside their usual interests.
//
// The only input is the pseudonymous actor key already used for view counting (an HMAC of a random
// cookie for visitors, the account id for members). No personal data is read, nothing new is stored,
// and a viewer with no history simply gets new + popular + varied videos.
import { db } from '../db/index.js';
import { getSetting } from './settings.js';
import { listVideos } from './videos.js';

/** Splits `limit` slots across the three groups in the configured proportions (largest remainder). */
export function mixCounts(limit, cfg) {
  const parts = [['preferred', cfg.preferred], ['fresh', cfg.fresh], ['exploratory', cfg.exploratory]];
  const total = parts.reduce((a, [, n]) => a + n, 0) || 1;
  const raw = parts.map(([k, n]) => [k, (n / total) * limit]);
  const out = Object.fromEntries(raw.map(([k, v]) => [k, Math.floor(v)]));
  let left = limit - Object.values(out).reduce((a, n) => a + n, 0);
  for (const [k] of [...raw].sort((a, b) => (b[1] - Math.floor(b[1])) - (a[1] - Math.floor(a[1])))) {
    if (left <= 0) break;
    if (parts.find(([x]) => x === k)[1] > 0) { out[k]++; left--; }
  }
  return out;
}

/** What this viewer has been watching lately: favourite categories/channels and videos already seen. */
export async function tasteOf(actorKey, kind, historyDays) {
  if (!actorKey) return { categoryIds: [], channelIds: [], seen: [] };
  const rows = await db.query(
    `select v.public_id, v.category_id, v.channel_id, case e.type when 'share' then 2 else 1 end as w
       from video_events e join videos v on v.id = e.video_id
      where e.actor_key = $1 and v.kind = $2 and e.created_at > now() - make_interval(days => $3::int)
      order by e.created_at desc limit 500`, [actorKey, kind, historyDays]);
  const top = (key) => {
    const m = new Map();
    for (const r of rows) if (r[key]) m.set(r[key], (m.get(r[key]) || 0) + r.w);
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, key === 'category_id' ? 3 : 5).map(([id]) => id);
  };
  return { categoryIds: top('category_id'), channelIds: top('channel_id'), seen: [...new Set(rows.map((r) => r.public_id))] };
}

/** Spreads the three groups through the page instead of clumping them together. */
function weave(groups) {
  const out = [];
  const queues = groups.map((g) => ({ ...g, items: [...g.items], total: g.items.length }));
  while (queues.some((q) => q.items.length)) {
    // Take from whichever group is furthest behind its share.
    queues.sort((a, b) => (b.items.length / (b.total || 1)) - (a.items.length / (a.total || 1)));
    const q = queues.find((x) => x.items.length);
    out.push({ ...q.items.shift(), rec: q.name });
  }
  return out;
}

/**
 * Returns `limit` videos mixed per the settings. `exclude` (public ids the client already shows) is
 * never repeated; the viewer's recent history is avoided too unless the catalogue is too small.
 */
export async function recommend({ actorKey = null, kind, limit = 10, exclude = [] }) {
  const cfg = await getSetting('recommendations');
  if (!cfg.enabled) {
    const { rows, hasMore } = await listVideos({ kind, sort: 'trending', limit, excludeIds: exclude });
    return { rows: rows.map((r) => ({ ...r, rec: 'trending' })), hasMore };
  }
  const taste = await tasteOf(actorKey, kind, cfg.history_days);
  const hasTaste = taste.categoryIds.length || taste.channelIds.length;
  const counts = mixCounts(limit, cfg);
  const taken = new Set(exclude);
  const avoid = () => [...new Set([...taken, ...taste.seen])];
  const pick = async (name, n, opts) => {
    if (n <= 0) return { name, items: [] };
    const { rows } = await listVideos({ kind, limit: n, excludeIds: avoid(), ...opts });
    rows.forEach((r) => taken.add(r.public_id));
    return { name, items: rows };
  };

  // Without any history there is nothing to prefer, so those slots are filled with popular videos below.
  const preferred = hasTaste ? await pick('preferred', counts.preferred, { sort: 'trending', affinity: taste }) : { name: 'preferred', items: [] };
  const fresh = await pick('fresh', counts.fresh, { sort: 'recent', publishedWithinDays: cfg.fresh_days });
  const exploratory = await pick('exploratory', counts.exploratory, { sort: 'random', notAffinity: hasTaste ? taste : null });

  let got = preferred.items.length + fresh.items.length + exploratory.items.length;
  const filler = { name: 'trending', items: [] };
  if (got < limit) {
    const f = await pick('trending', limit - got, { sort: 'trending' });
    filler.items = f.items; got += f.items.length;
  }
  if (got < limit && taste.seen.length) {
    // Small catalogue: allow the viewer's own history again, but never what the client already shows.
    const { rows } = await listVideos({ kind, sort: 'trending', limit: limit - got, excludeIds: [...taken] });
    filler.items.push(...rows);
    got += rows.length;
  }
  const rows = weave([preferred, fresh, exploratory, filler]);
  return { rows, hasMore: got >= limit };
}
