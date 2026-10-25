import { z } from 'zod';
import { db } from '../db/index.js';

// ---- Defaults & validation schemas for every platform setting -------------------------------
export const SETTING_SCHEMAS = {
  brand: z.object({
    name: z.string().trim().min(1).max(40),
    tagline: z.string().trim().max(120),
  }),
  telegram: z.object({
    global_url: z.string().trim().max(300),
    allow_creator_override: z.boolean(),
    locked: z.boolean(),
  }),
  upload: z.object({
    short_max_seconds: z.number().int().min(5).max(600),
    short_max_mb: z.number().min(1).max(2048),
    long_max_seconds: z.number().int().min(30).max(14400),
    long_max_mb: z.number().min(1).max(10240),
    allowed_formats: z.array(z.enum(['mp4', 'webm', 'mov'])).min(1),
    thumbnail_max_mb: z.number().min(0.1).max(20),
  }),
  moderation: z.object({
    require_video_moderation: z.boolean(),
    require_email_verification: z.boolean(),
    comments_enabled: z.boolean(),
  }),
  trending: z.object({
    window_hours: z.number().int().min(1).max(720),
    half_life_hours: z.number().min(1).max(720),
    w_views: z.number().min(0).max(100),
    w_hearts: z.number().min(0).max(100),
    w_shares: z.number().min(0).max(100),
    w_comments: z.number().min(0).max(100),
    w_dislikes: z.number().min(0).max(100),
    w_engagement: z.number().min(0).max(100),
  }),
  monetization: z.object({
    enabled: z.boolean(),
    // Rupees per 1000 eligible views, per video kind.
    rate_short_per_1000: z.number().min(0).max(10000),
    rate_long_per_1000: z.number().min(0).max(10000),
    min_payout: z.number().min(1).max(100000),
    payout_day: z.number().int().min(1).max(28),
    // Days an entry waits before it can be approved, leaving room to spot abuse.
    approval_delay_days: z.number().int().min(0).max(60),
    auto_approve: z.boolean(),
    // View eligibility policy.
    dedupe_hours: z.number().min(0.25).max(168),
    max_views_per_actor_per_day: z.number().int().min(1).max(10000),
    max_actors_per_ip_per_day: z.number().int().min(1).max(10000),
    client_view_delay_seconds: z.number().min(0).max(600),
  }),
  // "For you" mix, per 10 videos: some from what the viewer already watches, some brand new,
  // and some from outside their usual interests so the feed does not narrow.
  recommendations: z.object({
    enabled: z.boolean(),
    preferred: z.number().int().min(0).max(10),
    fresh: z.number().int().min(0).max(10),
    exploratory: z.number().int().min(0).max(10),
    fresh_days: z.number().int().min(1).max(60),
    history_days: z.number().int().min(1).max(180),
  }).refine((r) => r.preferred + r.fresh + r.exploratory > 0, 'At least one slot is needed'),
  currency: z.object({
    display: z.array(z.enum(['INR', 'USD', 'EUR', 'GBP', 'AED'])).min(1),
    usd_per_inr: z.number().min(0).max(10),
    rates_updated_at: z.string().max(40),
  }),
  ads: z.object({
    reserve_space: z.boolean(),
    show_label: z.boolean(),
    width: z.number().int().min(160).max(400),
    min_height: z.number().int().min(100).max(1200),
    slot_id: z.string().trim().max(80).regex(/^[A-Za-z0-9_\-:.]*$/, 'Letters, numbers and _-:. only'),
  }),
  policies: z.object({
    content_policy: z.string().max(5000),
    community_guidelines: z.string().max(5000),
  }),
};

export const DEFAULTS = {
  brand: { name: 'viralX', tagline: 'Short videos first' },
  telegram: { global_url: '', allow_creator_override: true, locked: false },
  upload: {
    short_max_seconds: 90,
    short_max_mb: 100,
    long_max_seconds: 3600,
    long_max_mb: 1024,
    allowed_formats: ['mp4', 'webm', 'mov'],
    thumbnail_max_mb: 5,
  },
  // Email verification is off by default so the platform works before SMTP exists. Creator
  // approval is the gate that matters: a channel still has to be reviewed before it can upload.
  moderation: { require_video_moderation: false, require_email_verification: false, comments_enabled: true },
  trending: {
    window_hours: 72,
    half_life_hours: 48,
    w_views: 1,
    w_hearts: 4,
    w_shares: 6,
    w_comments: 3,
    w_dislikes: 2,
    w_engagement: 2,
  },
  monetization: {
    enabled: true,
    rate_short_per_1000: 2,    // ₹10 per 5,000 eligible views
    rate_long_per_1000: 10,    // ₹10 per 1,000 eligible views
    min_payout: 500,
    payout_day: 7,
    approval_delay_days: 3,
    auto_approve: true,
    dedupe_hours: 24,
    max_views_per_actor_per_day: 200,
    max_actors_per_ip_per_day: 50,
    client_view_delay_seconds: 3,
  },
  recommendations: { enabled: true, preferred: 5, fresh: 3, exploratory: 2, fresh_days: 7, history_days: 30 },
  currency: { display: ['INR', 'USD'], usd_per_inr: 0, rates_updated_at: '' },
  ads: { reserve_space: true, show_label: false, width: 300, min_height: 600, slot_id: '' },
  policies: {
    content_policy: 'Only upload content you own or have the right to share. No illegal, hateful, sexually explicit, or harmful content.',
    community_guidelines: 'Be respectful in comments. Spam and harassment lead to removal.',
  },
};

let cache = null;
let cacheAt = 0;
const TTL = 5000;

async function loadAll() {
  const rows = await db.query('select key, value from settings');
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = { ...DEFAULTS[k] };
  for (const r of rows) if (r.key in out) out[r.key] = { ...out[r.key], ...r.value };
  return out;
}

export async function getSettings() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  cache = await loadAll();
  cacheAt = Date.now();
  return cache;
}
export const getSetting = async (key) => (await getSettings())[key];
export const invalidateSettings = () => { cache = null; };

export async function setSetting(key, value, adminId) {
  const schema = SETTING_SCHEMAS[key];
  if (!schema) throw new Error('Unknown setting');
  const parsed = schema.parse(value);
  await db.query(
    `insert into settings (key, value, updated_by, updated_at) values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(parsed), adminId || null],
  );
  invalidateSettings();
  return parsed;
}
