-- viralX: creator earnings, payouts and view eligibility.
--
-- Money is stored as numeric, never floating point. The canonical accounting currency is INR.
-- Every earning row keeps the rate that produced it, so history stays auditable after a rate change.

-- View events gain a hashed network identifier so the eligibility pass can spot one
-- network driving many "different" viewers. Only an HMAC is stored, never an IP address.
alter table video_events add column ip_hash text;
create index video_events_ip_day_idx on video_events (ip_hash, created_at) where ip_hash is not null;

-- ---------------------------------------------------------------------------
-- Rate history. The current rate also lives in `settings`, but every change is
-- recorded here and each earning row snapshots the rate it was paid at.
-- ---------------------------------------------------------------------------
create table earning_rates (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('short', 'long')),
  -- Rupees per 1000 eligible views. Shorts default to 2.0000 (₹10 per 5,000 views),
  -- long videos to 10.0000 (₹10 per 1,000 views).
  rate_per_1000  numeric(12, 4) not null check (rate_per_1000 >= 0),
  effective_from timestamptz not null default now(),
  changed_by     uuid references users(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now()
);
create index earning_rates_kind_idx on earning_rates (kind, effective_from desc);

insert into earning_rates (kind, rate_per_1000, note)
values ('short', 2.0000, 'Initial rate: ₹10 per 5,000 eligible views'),
       ('long', 10.0000, 'Initial rate: ₹10 per 1,000 eligible views');

-- ---------------------------------------------------------------------------
-- Daily eligible-view aggregate. One row per video per day, rebuilt from
-- video_events by the aggregation job. `eligible_views` is what creators are paid for.
-- ---------------------------------------------------------------------------
create table video_view_daily (
  video_id         uuid not null references videos(id) on delete cascade,
  day              date not null,
  eligible_views   int not null default 0 check (eligible_views >= 0),
  suspicious_views int not null default 0 check (suspicious_views >= 0),
  raw_events       int not null default 0 check (raw_events >= 0),
  computed_at      timestamptz not null default now(),
  primary key (video_id, day)
);
create index video_view_daily_day_idx on video_view_daily (day desc);

-- Actors the eligibility pass judged abusive on a given day. Their views are counted
-- as suspicious and never earn. Kept separately so a decision can be reviewed.
create table suspicious_actors (
  day        date not null,
  actor_key  text not null,
  reason     text not null,
  events     int not null default 0,
  created_at timestamptz not null default now(),
  primary key (day, actor_key)
);

-- ---------------------------------------------------------------------------
-- Earnings ledger. One row per video per day. The unique key makes the
-- aggregation job idempotent: re-running it can never create a second row.
-- ---------------------------------------------------------------------------
create table earning_entries (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id) on delete cascade,
  video_id       uuid not null references videos(id) on delete cascade,
  kind           text not null check (kind in ('short', 'long')),
  day            date not null,
  eligible_views int not null default 0 check (eligible_views >= 0),
  rate_per_1000  numeric(12, 4) not null check (rate_per_1000 >= 0),
  amount         numeric(14, 4) not null check (amount >= 0),
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'invalidated')),
  invalidated_reason text,
  reviewed_by    uuid references users(id) on delete set null,
  -- Set when the entry is attached to a payout. A non-null value means it is spoken for,
  -- which is what stops an amount being paid twice or carried forward after payment.
  payout_id      uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (video_id, day)
);
create index earning_entries_channel_idx on earning_entries (channel_id, day desc);
create index earning_entries_payable_idx on earning_entries (channel_id) where status = 'approved' and payout_id is null;
create index earning_entries_status_idx on earning_entries (status, day);
create index earning_entries_payout_idx on earning_entries (payout_id);

-- ---------------------------------------------------------------------------
-- Payout methods. Account identifiers are encrypted at rest; only a masked
-- label is kept in clear for display.
-- ---------------------------------------------------------------------------
create table payout_methods (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id) on delete cascade,
  type           text not null check (type in ('upi', 'crypto')),
  -- For crypto: the asset and network, kept distinct on purpose.
  asset          text check (asset in ('btc', 'eth', 'usdt')),
  network        text check (network in ('bitcoin', 'ethereum', 'tron', 'bsc')),
  holder_name    text not null,
  -- AES-256-GCM ciphertext of the UPI id or wallet address.
  secret_cipher  text not null,
  -- e.g. "vic****@okaxis" or "TR7N...9xKz" — safe to show back to the owner.
  masked         text not null,
  -- SHA-256 of the plaintext, so duplicates can be spotted without decrypting.
  secret_hash    text not null,
  status         text not null default 'pending'
                   check (status in ('pending', 'verified', 'rejected', 'changes_requested')),
  status_reason  text,
  reviewed_by    uuid references users(id) on delete set null,
  reviewed_at    timestamptz,
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index payout_methods_channel_idx on payout_methods (channel_id, created_at desc);
create unique index payout_methods_one_default on payout_methods (channel_id) where is_default;
create index payout_methods_review_idx on payout_methods (status, created_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Monthly payout batches. One per earning period; the 7th of the following month.
-- ---------------------------------------------------------------------------
create table payout_batches (
  id            uuid primary key default gen_random_uuid(),
  period_start  date not null,
  period_end    date not null,
  scheduled_for date not null,
  status        text not null default 'draft'
                  check (status in ('draft', 'review', 'approved', 'processing', 'completed', 'cancelled')),
  total_amount  numeric(14, 4) not null default 0,
  payout_count  int not null default 0,
  carried_count int not null default 0,
  carried_amount numeric(14, 4) not null default 0,
  min_payout    numeric(14, 4) not null,
  created_by    uuid references users(id) on delete set null,
  completed_at  timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (period_start)
);
create index payout_batches_sched_idx on payout_batches (scheduled_for desc);

-- ---------------------------------------------------------------------------
-- Individual payouts. A payout is never "paid" without a recorded reference.
-- ---------------------------------------------------------------------------
create table payouts (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid references payout_batches(id) on delete set null,
  channel_id     uuid not null references channels(id) on delete cascade,
  amount         numeric(14, 4) not null check (amount > 0),
  currency       text not null default 'INR',
  status         text not null default 'eligible'
                   check (status in ('eligible', 'approved', 'processing', 'paid', 'failed', 'on_hold', 'cancelled')),
  -- Snapshot of the method at approval time, so later edits cannot rewrite history.
  method_id      uuid references payout_methods(id) on delete set null,
  method_type    text,
  method_masked  text,
  method_asset   text,
  method_network text,
  -- What actually left the platform, when it is not plain INR.
  paid_currency  text,
  paid_amount    numeric(20, 8),
  exchange_rate  numeric(20, 8),
  exchange_rate_at timestamptz,
  fees           numeric(14, 4) not null default 0,
  transaction_ref text,
  tx_hash        text,
  tx_network     text,
  failure_reason text,
  hold_reason    text,
  approved_by    uuid references users(id) on delete set null,
  paid_by        uuid references users(id) on delete set null,
  paid_at        timestamptz,
  -- Guards against a double-click or a retried request creating two payouts.
  idempotency_key text unique,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index payouts_channel_idx on payouts (channel_id, created_at desc);
create index payouts_batch_idx on payouts (batch_id, status);
create index payouts_status_idx on payouts (status, created_at desc);
-- One payout per channel per batch.
create unique index payouts_one_per_channel_batch on payouts (batch_id, channel_id) where batch_id is not null;

alter table earning_entries
  add constraint earning_entries_payout_fk foreign key (payout_id) references payouts(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Manual adjustments: corrections, bonuses, clawbacks. Always have a reason and
-- an author, and they join the payable balance exactly like earnings do.
-- ---------------------------------------------------------------------------
create table payout_adjustments (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references channels(id) on delete cascade,
  -- Positive adds to the balance, negative takes away.
  amount      numeric(14, 4) not null,
  reason      text not null,
  created_by  uuid references users(id) on delete set null,
  payout_id   uuid references payouts(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index payout_adjustments_channel_idx on payout_adjustments (channel_id, created_at desc);
create index payout_adjustments_payable_idx on payout_adjustments (channel_id) where payout_id is null;

-- ---------------------------------------------------------------------------
-- Visitor analytics, kept apart from anything that touches money.
-- ---------------------------------------------------------------------------
create table visitor_days (
  day         date not null,
  visitor_key text not null,
  is_new      boolean not null default false,
  user_id     uuid references users(id) on delete set null,
  views       int not null default 0,
  created_at  timestamptz not null default now(),
  primary key (day, visitor_key)
);
create index visitor_days_day_idx on visitor_days (day desc);
