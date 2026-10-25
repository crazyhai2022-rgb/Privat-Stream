-- Per-creator default upload settings (title, description, hashtags, category for Shorts and long videos).
-- Additive and idempotent: one small row per creator, removed automatically with the user.
create table if not exists creator_upload_defaults (
  user_id    uuid primary key references users(id) on delete cascade,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
