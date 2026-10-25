-- Subscriptions: a signed-in user follows a channel. The composite key is what makes
-- double clicks and retried requests harmless (one row per pair, ever).
create table channel_subscriptions (
  channel_id uuid not null references channels(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index channel_subscriptions_user_idx on channel_subscriptions (user_id, created_at desc);
