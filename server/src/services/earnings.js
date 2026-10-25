// Creator earnings: eligible views -> ledger entries -> monthly payouts.
//
// Rules that matter:
//  - Every amount is computed on the server from stored events. Nothing a client sends
//    can change a payable figure.
//  - Each ledger entry keeps the rate that produced it, so a later rate change cannot
//    rewrite history.
//  - An entry is "spoken for" the moment it is attached to a payout (payout_id). That is
//    what stops an amount being paid twice or carried forward after it was paid.
//  - Aggregation is idempotent: unique (video_id, day) means re-running a day cannot
//    create a second entry, and entries already approved or paid are never rewritten.
import { db } from '../db/index.js';
import { getSetting } from './settings.js';

export const MONEY_DP = 4;      // stored precision
export const DISPLAY_DP = 2;    // shown to people

export const toMoney = (v) => Number(v ?? 0);
export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const formatINR = (v) => `₹${round2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Earnings for a number of views at a rate quoted per 1000 views. */
export const earningsFor = (views, ratePer1000) => (Number(views) * Number(ratePer1000)) / 1000;

/** The rate each kind currently earns, from platform settings. */
export async function currentRates() {
  const m = await getSetting('monetization');
  return { short: Number(m.rate_short_per_1000), long: Number(m.rate_long_per_1000), settings: m };
}

/** Records a rate change in the audit history. Call it when the setting changes. */
export async function recordRateChange({ kind, rate, adminId, note }) {
  await db.query(
    `insert into earning_rates (kind, rate_per_1000, changed_by, note) values ($1,$2,$3,$4)`,
    [kind, rate, adminId || null, note || null],
  );
}

export async function rateHistory(limit = 50) {
  return db.query(
    `select r.id, r.kind, r.rate_per_1000, r.effective_from, r.note, u.full_name as changed_by_name
       from earning_rates r left join users u on u.id = r.changed_by
      order by r.effective_from desc limit $1`, [limit]);
}

// ---------------------------------------------------------------------------
// Eligible views
// ---------------------------------------------------------------------------

/**
 * Rebuilds the eligible-view aggregate and the ledger for one day (UTC).
 *
 * Eligibility, all enforced here on stored data:
 *  - one view per viewer per video per day (the API already de-duplicates within 30 minutes);
 *  - the creator's own views are never recorded in the first place;
 *  - viewers who exceeded the per-day cap, or networks driving more distinct "viewers"
 *    than the cap allows, are marked suspicious and earn nothing;
 *  - only published videos on approved channels earn.
 *
 * Safe to run repeatedly for the same day.
 */
export async function aggregateDay(day) {
  const m = await getSetting('monetization');
  const d = typeof day === 'string' ? day : day.toISOString().slice(0, 10);

  return db.tx(async (q) => {
    // 1. Who behaved abusively on this day?
    await q('delete from suspicious_actors where day = $1', [d]);
    await q(
      `insert into suspicious_actors (day, actor_key, reason, events)
       select $1::date, actor_key, 'too many views for one viewer', count(*)::int
         from video_events
        where type = 'view' and created_at >= $1::date and created_at < ($1::date + 1)
        group by actor_key having count(*) > $2::int
       on conflict (day, actor_key) do nothing`,
      [d, m.max_views_per_actor_per_day]);
    await q(
      `insert into suspicious_actors (day, actor_key, reason, events)
       select $1::date, e.actor_key, 'network with too many distinct viewers', 0
         from video_events e
         join (select ip_hash from video_events
                where type = 'view' and ip_hash is not null
                  and created_at >= $1::date and created_at < ($1::date + 1)
                group by ip_hash having count(distinct actor_key) > $2::int) bad on bad.ip_hash = e.ip_hash
        where e.type = 'view' and e.created_at >= $1::date and e.created_at < ($1::date + 1)
        group by e.actor_key
       on conflict (day, actor_key) do nothing`,
      [d, m.max_actors_per_ip_per_day]);

    // 2. Eligible and suspicious counts per video.
    await q(
      `insert into video_view_daily (video_id, day, eligible_views, suspicious_views, raw_events, computed_at)
       select e.video_id, $1::date,
              count(distinct e.actor_key) filter (where s.actor_key is null)::int,
              count(distinct e.actor_key) filter (where s.actor_key is not null)::int,
              count(*)::int, now()
         from video_events e
         left join suspicious_actors s on s.day = $1::date and s.actor_key = e.actor_key
        where e.type = 'view' and e.created_at >= $1::date and e.created_at < ($1::date + 1)
        group by e.video_id
       on conflict (video_id, day) do update
         set eligible_views = excluded.eligible_views,
             suspicious_views = excluded.suspicious_views,
             raw_events = excluded.raw_events,
             computed_at = now()`,
      [d]);

    if (!m.enabled) return { day: d, entries: 0, skipped: 'monetization disabled' };

    // 3. Ledger entries, only for monetizable content, with the rate of the day snapshotted.
    //    Entries already approved, invalidated or attached to a payout are left untouched.
    const rows = await q(
      `insert into earning_entries (channel_id, video_id, kind, day, eligible_views, rate_per_1000, amount)
       select v.channel_id, v.id, v.kind, vd.day, vd.eligible_views,
              case when v.kind = 'short' then $2::numeric else $3::numeric end,
              round(vd.eligible_views * (case when v.kind = 'short' then $2::numeric else $3::numeric end) / 1000.0, 4)
         from video_view_daily vd
         join videos v on v.id = vd.video_id
         join channels c on c.id = v.channel_id
        where vd.day = $1::date
          and v.status = 'published'
          and c.status = 'approved'
       on conflict (video_id, day) do update
         set eligible_views = excluded.eligible_views,
             rate_per_1000 = excluded.rate_per_1000,
             amount = excluded.amount,
             updated_at = now()
         where earning_entries.status = 'pending' and earning_entries.payout_id is null
       returning id`,
      [d, m.rate_short_per_1000, m.rate_long_per_1000]);

    return { day: d, entries: rows.length };
  });
}

/** Rebuilds the last `days` complete days (today is skipped: it is not over yet). */
export async function aggregateRecent(days = 3) {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push(await aggregateDay(d));
  }
  return out;
}

/** Moves pending entries to approved once they are older than the review window. */
export async function approveDueEntries() {
  const m = await getSetting('monetization');
  if (!m.auto_approve) return 0;
  const rows = await db.query(
    `update earning_entries set status = 'approved', updated_at = now()
      where status = 'pending' and day <= (current_date - make_interval(days => $1::int))
      returning id`,
    [m.approval_delay_days]);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * A channel's money position. All of it is derived from the ledger, never stored
 * as a running total that could drift.
 */
export async function balanceFor(channelId, { q = (sql, p) => db.query(sql, p), settings = null } = {}) {
  const one = async (sql, p) => (await q(sql, p))[0];
  const m = settings || await getSetting('monetization');
  const e = await one(
    `select
       coalesce(sum(amount) filter (where status = 'pending'), 0) as pending,
       coalesce(sum(amount) filter (where status = 'approved' and payout_id is null), 0) as approved_unpaid,
       coalesce(sum(amount) filter (where status = 'approved'), 0) as approved_total,
       coalesce(sum(amount) filter (where status <> 'invalidated'), 0) as lifetime,
       coalesce(sum(eligible_views) filter (where status <> 'invalidated'), 0)::int as eligible_views
     from earning_entries where channel_id = $1`, [channelId]);
  const adj = await one(
    `select coalesce(sum(amount) filter (where payout_id is null), 0) as unpaid,
            coalesce(sum(amount), 0) as total
       from payout_adjustments where channel_id = $1`, [channelId]);
  const paid = await one(
    `select coalesce(sum(amount) filter (where status = 'paid'), 0) as paid,
            coalesce(sum(amount) filter (where status in ('eligible','approved','processing')), 0) as in_flight,
            coalesce(sum(amount) filter (where status = 'on_hold'), 0) as on_hold
       from payouts where channel_id = $1`, [channelId]);

  const payable = Math.max(0, toMoney(e.approved_unpaid) + toMoney(adj.unpaid));
  const minPayout = Number(m.min_payout);
  return {
    pending: toMoney(e.pending),
    approved_unpaid: toMoney(e.approved_unpaid),
    adjustments_unpaid: toMoney(adj.unpaid),
    payable,
    estimated_total: toMoney(e.lifetime) + toMoney(adj.total),
    eligible_views: e.eligible_views,
    paid_to_date: toMoney(paid.paid),
    in_flight: toMoney(paid.in_flight),
    on_hold: toMoney(paid.on_hold),
    min_payout: minPayout,
    meets_minimum: payable >= minPayout,
    // Below the minimum nothing moves: the balance simply stays and is carried forward.
    carried_forward: payable < minPayout ? payable : 0,
    progress: minPayout > 0 ? Math.min(1, payable / minPayout) : 1,
    next_payout_date: nextPayoutDate(m.payout_day),
    currency: 'INR',
  };
}

/** The next scheduled payout date (the configured day of the month, the 7th by default). */
export function nextPayoutDate(payoutDay = 7, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), payoutDay));
  if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1);
  return nextBusinessDay(d.toISOString().slice(0, 10));
}

/** First and last day of the month that a batch scheduled on `scheduledFor` pays for. */
export function periodForBatch(scheduledFor) {
  const d = new Date(scheduledFor + 'T00:00:00Z');
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));       // last day of previous month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { period_start: start.toISOString().slice(0, 10), period_end: end.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Monthly batches
// ---------------------------------------------------------------------------

/**
 * Builds the payout batch for one earning period.
 *
 * Every channel's payable balance is measured, and those at or above the minimum get a
 * payout with their entries and adjustments attached inside the same transaction. Channels
 * below the minimum get nothing attached, so their balance stays exactly where it is and
 * is picked up by a later batch — carried forward without being counted twice.
 */
export async function buildBatch({ periodStart, scheduledFor, adminId }) {
  const m = await getSetting('monetization');
  const minPayout = Number(m.min_payout);
  const period = periodStart
    ? { period_start: periodStart, period_end: lastDayOfMonth(periodStart) }
    : periodForBatch(scheduledFor || nextPayoutDate(m.payout_day));
  const sched = scheduledFor || scheduledForPeriod(period.period_start, m.payout_day);

  return db.tx(async (q) => {
    const [existing] = await q('select * from payout_batches where period_start = $1', [period.period_start]);
    if (existing && !['draft', 'review'].includes(existing.status)) {
      throw Object.assign(new Error(`A batch for ${period.period_start} already exists and is ${existing.status}`), { code: 'batch_exists' });
    }
    if (existing) {
      // A batch under review may be rebuilt, but only while nobody has started acting on it.
      const [{ n }] = await q(`select count(*)::int as n from payouts where batch_id = $1 and status <> 'eligible'`, [existing.id]);
      if (n) throw Object.assign(new Error(`The batch for ${period.period_start} already has approved or processed payouts`), { code: 'batch_exists' });
    }
    let batch = existing;
    if (!batch) {
      [batch] = await q(
        `insert into payout_batches (period_start, period_end, scheduled_for, min_payout, created_by)
         values ($1,$2,$3,$4,$5) returning *`,
        [period.period_start, period.period_end, sched, minPayout, adminId || null]);
    } else {
      // Rebuilding a draft: release anything it had attached so the sums cannot double up.
      await q(`update earning_entries set payout_id = null, updated_at = now()
                where payout_id in (select id from payouts where batch_id = $1)`, [batch.id]);
      await q(`update payout_adjustments set payout_id = null
                where payout_id in (select id from payouts where batch_id = $1)`, [batch.id]);
      await q(`delete from payouts where batch_id = $1 and status in ('eligible','approved')`, [batch.id]);
    }

    // Everything approved and unpaid up to the end of the period, plus unattached adjustments.
    const candidates = await q(
      `select c.id as channel_id,
              coalesce(e.amount, 0) + coalesce(a.amount, 0) as payable,
              coalesce(e.amount, 0) as earnings, coalesce(a.amount, 0) as adjustments
         from channels c
         left join (select channel_id, sum(amount) as amount from earning_entries
                     where status = 'approved' and payout_id is null and day <= $1::date
                     group by channel_id) e on e.channel_id = c.id
         left join (select channel_id, sum(amount) as amount from payout_adjustments
                     where payout_id is null group by channel_id) a on a.channel_id = c.id
        where coalesce(e.amount, 0) + coalesce(a.amount, 0) > 0`,
      [period.period_end]);

    let total = 0, count = 0, carriedAmount = 0, carriedCount = 0;
    for (const c of candidates) {
      const payable = toMoney(c.payable);
      if (payable < minPayout) { carriedAmount += payable; carriedCount++; continue; }

      const [method] = await q(
        `select * from payout_methods where channel_id = $1 and is_default order by updated_at desc limit 1`, [c.channel_id]);
      const [payout] = await q(
        `insert into payouts (batch_id, channel_id, amount, status, method_id, method_type, method_masked, method_asset, method_network, idempotency_key)
         values ($1,$2,$3,'eligible',$4,$5,$6,$7,$8,$9) returning id`,
        [batch.id, c.channel_id, payable.toFixed(4), method?.id || null, method?.type || null,
          method?.masked || null, method?.asset || null, method?.network || null, `${batch.id}:${c.channel_id}`]);

      // Attaching inside the transaction is what makes the amount unavailable to any other batch.
      await q(`update earning_entries set payout_id = $2, updated_at = now()
                where channel_id = $1 and status = 'approved' and payout_id is null and day <= $3::date`,
        [c.channel_id, payout.id, period.period_end]);
      await q(`update payout_adjustments set payout_id = $2
                where channel_id = $1 and payout_id is null`,
        [c.channel_id, payout.id]);

      total += payable; count++;
    }

    const [updated] = await q(
      `update payout_batches set status = 'review', total_amount = $2, payout_count = $3,
              carried_amount = $4, carried_count = $5, min_payout = $6, updated_at = now()
        where id = $1 returning *`,
      [batch.id, total.toFixed(4), count, carriedAmount.toFixed(4), carriedCount, minPayout]);
    return updated;
  });
}

const lastDayOfMonth = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};
/** Weekend dates roll forward to Monday, so a batch is never scheduled for a day banks are closed. */
export function nextBusinessDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const scheduledForPeriod = (periodStart, payoutDay) => {
  const d = new Date(periodStart + 'T00:00:00Z');
  return nextBusinessDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, payoutDay)).toISOString().slice(0, 10));
};

// ---------------------------------------------------------------------------
// Payout state machine
// ---------------------------------------------------------------------------

export const PAYOUT_TRANSITIONS = {
  eligible: ['approved', 'on_hold', 'cancelled'],
  approved: ['processing', 'on_hold', 'cancelled'],
  processing: ['paid', 'failed', 'on_hold'],
  on_hold: ['eligible', 'approved', 'cancelled'],
  failed: ['approved', 'cancelled'],
  paid: [],
  cancelled: [],
};

export class PayoutStateError extends Error {
  constructor(from, to) {
    super(`A payout that is ${from.replace('_', ' ')} cannot become ${to.replace('_', ' ')}`);
    this.code = 'invalid_transition';
    this.status = 409;
  }
}

/**
 * Moves a payout to a new state, enforcing the transitions above in the database.
 * Marking one paid requires a reference, and cancelling releases its money back
 * to the channel's balance so it is carried forward rather than lost.
 */
export async function transitionPayout(payoutId, to, { adminId, fields = {} } = {}) {
  return db.tx(async (q) => {
    const [p] = await q('select * from payouts where id = $1 for update', [payoutId]);
    if (!p) throw Object.assign(new Error('Payout not found'), { status: 404, code: 'not_found' });
    if (p.status === to) return p;
    if (!(PAYOUT_TRANSITIONS[p.status] || []).includes(to)) throw new PayoutStateError(p.status, to);
    if (to === 'paid' && !String(fields.transaction_ref || fields.tx_hash || '').trim()) {
      throw Object.assign(new Error('Record the transaction reference before marking a payout paid'), { status: 400, code: 'reference_required' });
    }

    const sets = ['status = $2', 'updated_at = now()'];
    const params = [payoutId, to];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    for (const col of ['transaction_ref', 'tx_hash', 'tx_network', 'failure_reason', 'hold_reason', 'note',
      'paid_currency', 'paid_amount', 'exchange_rate', 'fees']) {
      if (fields[col] !== undefined) add(col, fields[col]);
    }
    if (fields.exchange_rate !== undefined) sets.push('exchange_rate_at = now()');
    if (to === 'approved') add('approved_by', adminId || null);
    if (to === 'paid') { add('paid_by', adminId || null); sets.push('paid_at = now()'); }

    const [updated] = await q(`update payouts set ${sets.join(', ')} where id = $1 returning *`, params);

    if (to === 'cancelled') {
      // Release the money: the entries become payable again and carry forward.
      await q('update earning_entries set payout_id = null, updated_at = now() where payout_id = $1', [payoutId]);
      await q('update payout_adjustments set payout_id = null where payout_id = $1', [payoutId]);
    }
    return updated;
  });
}

/** Runs the daily maintenance: rebuild recent days, then approve what is due. */
export async function runEarningsMaintenance({ days = 3 } = {}) {
  const aggregated = await aggregateRecent(days);
  const approved = await approveDueEntries();
  return { aggregated, approved };
}

// ---------------------------------------------------------------------------
// Withdrawal requests
// ---------------------------------------------------------------------------

/** Why a creator cannot ask for a withdrawal right now, or null when they can. */
export async function withdrawalBlocker(channelId, { q = (sql, p) => db.query(sql, p), settings = null } = {}) {
  const bal = await balanceFor(channelId, { q, settings });
  if (!bal.meets_minimum) return `Your payable balance is below the ${formatINR(bal.min_payout)} minimum. It carries forward until it reaches it.`;
  const [open] = await q(`select id from payouts where channel_id = $1 and status in ('eligible','approved','processing','on_hold') limit 1`, [channelId]);
  if (open) return 'You already have a withdrawal in progress. Wait for it to finish first.';
  const [m] = await q(`select status from payout_methods where channel_id = $1 and is_default limit 1`, [channelId]);
  if (!m) return 'Add a payment method first.';
  if (m.status !== 'verified') return 'Your default payment method is not verified yet.';
  return null;
}

/**
 * Creates a payout for the whole payable balance on the creator's request. The money is attached in the
 * same transaction, so it cannot also be paid by a monthly batch. An administrator still approves and pays it.
 */
export async function requestWithdrawal(channelId) {
  const settings = await getSetting('monetization');   // read before the transaction: it holds the only connection
  return db.tx(async (q) => {
    await q('select id from channels where id = $1 for update', [channelId]);   // serialises double-clicks
    const blocker = await withdrawalBlocker(channelId, { q, settings });
    if (blocker) throw Object.assign(new Error(blocker), { status: 400, code: 'withdrawal_blocked' });
    const [e] = await q(`select coalesce(sum(amount),0) as a from earning_entries where channel_id = $1 and status = 'approved' and payout_id is null`, [channelId]);
    const [a] = await q(`select coalesce(sum(amount),0) as a from payout_adjustments where channel_id = $1 and payout_id is null`, [channelId]);
    const payable = toMoney(e.a) + toMoney(a.a);
    const [method] = await q(`select * from payout_methods where channel_id = $1 and is_default limit 1`, [channelId]);
    const [p] = await q(
      `insert into payouts (channel_id, amount, status, source, method_id, method_type, method_masked, method_asset, method_network, idempotency_key)
       values ($1,$2,'eligible','request',$3,$4,$5,$6,$7,$8) returning *`,
      [channelId, payable.toFixed(4), method.id, method.type, method.masked, method.asset, method.network, `req:${channelId}:${Date.now()}`]);
    await q(`update earning_entries set payout_id = $2, updated_at = now() where channel_id = $1 and status = 'approved' and payout_id is null`, [channelId, p.id]);
    await q(`update payout_adjustments set payout_id = $2 where channel_id = $1 and payout_id is null`, [channelId, p.id]);
    return p;
  });
}
