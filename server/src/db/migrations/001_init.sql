-- Privat Stream: initial schema (PostgreSQL)

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  full_name        text not null,
  password_hash    text not null,
  role             text not null default 'user' check (role in ('user', 'moderator', 'super_admin')),
  account_status   text not null default 'active' check (account_status in ('active', 'suspended')),
  suspended_reason text,
  email_verified_at timestamptz,
  failed_logins    int not null default 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index users_email_lower_uq on users (lower(email));
create index users_created_idx on users (created_at desc);
create index users_status_idx on users (account_status);

-- Server-side sessions. Only a SHA-256 of the cookie token is stored.
create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  csrf_token  text not null,
  scope       text not null default 'user' check (scope in ('user', 'admin')),
  ip_hash     text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create index sessions_user_idx on sessions (user_id);

create table email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  type        text not null check (type in ('verify_email', 'reset_password')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index email_tokens_user_idx on email_tokens (user_id, type);

-- Development-only mail sink (used when SMTP is not configured and not in production).
create table email_outbox (
  id         bigserial primary key,
  to_email   text not null,
  subject    text not null,
  body       text not null,
  link       text,
  created_at timestamptz not null default now()
);

create table categories (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  sort_order int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table channels (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references users(id) on delete cascade,
  name             text not null,
  handle           text not null,
  avatar_key       text,
  banner_key       text,
  bio              text not null default '',
  telegram_url     text,
  telegram_enabled boolean not null default true,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended')),
  status_reason    text,
  reviewed_by      uuid references users(id),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index channels_handle_lower_uq on channels (lower(handle));
create index channels_status_idx on channels (status, created_at);

create table channel_categories (
  channel_id  uuid not null references channels(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  primary key (channel_id, category_id)
);

create table videos (
  id               uuid primary key default gen_random_uuid(),
  public_id        text not null unique,
  channel_id       uuid not null references channels(id) on delete cascade,
  kind             text not null check (kind in ('short', 'long')),
  title            text not null,
  description      text not null default '',
  category_id      uuid references categories(id) on delete set null,
  tags             text[] not null default '{}',
  status           text not null default 'draft'
                     check (status in ('draft', 'uploading', 'processing', 'pending_moderation', 'published', 'rejected', 'removed')),
  error_message    text,
  original_key     text,
  playback_key     text,
  thumbnail_key    text,
  custom_thumbnail boolean not null default false,
  mime             text,
  size_bytes       bigint,
  duration_seconds numeric(10, 2),
  width            int,
  height           int,
  featured         boolean not null default false,
  featured_at      timestamptz,
  pinned_rank      int,
  published_at     timestamptz,
  removed_at       timestamptz,
  removed_reason   text,
  removed_by       text,           -- 'creator' | 'admin'
  rejected_reason  text,
  -- Independent, server-maintained counters (never accepted from clients).
  views_count        int not null default 0,
  unique_views_count int not null default 0,
  hearts_count       int not null default 0,
  dislikes_count     int not null default 0,
  comments_count     int not null default 0,
  shares_count       int not null default 0,
  saves_count        int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index videos_feed_idx on videos (kind, status, published_at desc);
create index videos_channel_idx on videos (channel_id, created_at desc);
create index videos_category_idx on videos (category_id, status);
create index videos_status_idx on videos (status, created_at);
create index videos_featured_idx on videos (featured, pinned_rank, featured_at desc) where featured;

-- DB-backed job queue (claimed with FOR UPDATE SKIP LOCKED); a Redis queue can replace it at scale.
create table video_jobs (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid not null references videos(id) on delete cascade,
  type       text not null default 'process',
  status     text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts   int not null default 0,
  last_error text,
  run_after  timestamptz not null default now(),
  locked_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index video_jobs_queue_idx on video_jobs (status, run_after);

-- One reaction per (video, actor). actor_key = 'u:<user id>' or 'a:<hmac of anonymous id>'.
create table reactions (
  video_id   uuid not null references videos(id) on delete cascade,
  actor_key  text not null,
  user_id    uuid references users(id) on delete cascade,
  type       text not null check (type in ('heart', 'dislike')),
  ip_hash    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (video_id, actor_key)
);
create index reactions_video_type_idx on reactions (video_id, type, created_at);
create index reactions_ip_idx on reactions (ip_hash, created_at) where user_id is null;

create table saved_videos (
  user_id    uuid not null references users(id) on delete cascade,
  video_id   uuid not null references videos(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index saved_user_idx on saved_videos (user_id, created_at desc);

create table comments (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid not null references videos(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  body       text not null,
  status     text not null default 'visible' check (status in ('visible', 'hidden', 'removed')),
  created_at timestamptz not null default now()
);
create index comments_video_idx on comments (video_id, status, created_at desc);

-- view / share events; used for unique views and the time-windowed trending score.
create table video_events (
  id         bigserial primary key,
  video_id   uuid not null references videos(id) on delete cascade,
  type       text not null check (type in ('view', 'share')),
  actor_key  text not null,
  created_at timestamptz not null default now()
);
create index video_events_video_idx on video_events (video_id, type, created_at desc);
create index video_events_actor_idx on video_events (video_id, type, actor_key, created_at desc);
create index video_events_time_idx on video_events (created_at);

create table reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references users(id) on delete cascade,
  target_type  text not null check (target_type in ('video', 'comment')),
  video_id     uuid references videos(id) on delete cascade,
  comment_id   uuid references comments(id) on delete cascade,
  reason       text not null,
  details      text not null default '',
  status       text not null default 'open' check (status in ('open', 'investigating', 'dismissed', 'actioned')),
  resolved_by  uuid references users(id),
  resolution_note text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index reports_status_idx on reports (status, created_at desc);
create index reports_video_idx on reports (video_id);
create unique index reports_one_per_reporter_video on reports (reporter_id, video_id) where target_type = 'video' and status in ('open', 'investigating');
create unique index reports_one_per_reporter_comment on reports (reporter_id, comment_id) where target_type = 'comment' and status in ('open', 'investigating');

create table admin_roles (
  role        text primary key,
  permissions text[] not null
);
insert into admin_roles (role, permissions) values
  ('super_admin', array['dashboard', 'users', 'creators', 'videos', 'reports', 'popularity', 'categories', 'settings', 'audit', 'admins']),
  ('moderator',   array['dashboard', 'creators', 'videos', 'reports', 'popularity']);

create table moderation_actions (
  id         bigserial primary key,
  admin_id   uuid references users(id),
  video_id   uuid references videos(id) on delete set null,
  comment_id uuid references comments(id) on delete set null,
  user_id    uuid references users(id) on delete set null,
  action     text not null,
  note       text,
  created_at timestamptz not null default now()
);
create index moderation_video_idx on moderation_actions (video_id, created_at desc);
create index moderation_user_idx on moderation_actions (user_id, created_at desc);

create table audit_logs (
  id          bigserial primary key,
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  ip_hash     text,
  created_at  timestamptz not null default now()
);
create index audit_created_idx on audit_logs (created_at desc);
create index audit_actor_idx on audit_logs (actor_id, created_at desc);

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
