import test, { after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeCreator, uploadVideo, publish, shutdown } from './helpers.js';

after(shutdown);

const E = await import('../src/services/earnings.js');
const { setSetting, invalidateSettings } = await import('../src/services/settings.js');

const BASE = {
  enabled: true,
  rate_short_per_1000: 2,   // ₹10 per 5,000
  rate_long_per_1000: 10,   // ₹10 per 1,000
  min_payout: 500,
  payout_day: 7,
  approval_delay_days: 3,
  auto_approve: true,
  dedupe_hours: 24,
  max_views_per_actor_per_day: 200,
  max_actors_per_ip_per_day: 50,
  client_view_delay_seconds: 3,
};

before(async () => { await setSetting('monetization', BASE); });

const dayStr = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

/** Writes `count` distinct viewers for a video on a given day. */
async function seedViews(videoId, day, count, { prefix = 'v', ipHash = null } = {}) {
  const v = await db.one('select id from videos where public_id = $1', [videoId]);
  await db.query(
    `insert into video_events (video_id, type, actor_key, ip_hash, created_at)
     select $1, 'view', 'a:' || $2::text || '-' || $3::text || '-' || g, $4::text, ($3::date + interval '6 hours')
       from generate_series(0, $5::int - 1) g`,
    [v.id, prefix, day, ipHash, count]);
  return v.id;
}

async function creatorWithVideo(kind = 'long') {
  const c = await makeCreator();
  const id = await uploadVideo(c, { kind, title: `${kind} earner` });
  await publish(id);
  return { ...c, videoId: id };
}

async function resetLedger() {
  await db.query('delete from payouts');
  await db.query('delete from payout_batches');
  await db.query('delete from payout_adjustments');
  await db.query('delete from earning_entries');
  await db.query('delete from video_view_daily');
}

const payableOf = async (channelId) => (await E.balanceFor(channelId)).payable;

describe('earning rate maths', () => {
  test('the documented figures come out exactly', () => {
    // Long videos: ₹10 per 1,000 eligible views.
    assert.equal(E.earningsFor(1000, 10), 10);
    assert.equal(E.earningsFor(10000, 10), 100);
    assert.equal(E.earningsFor(25000, 10), 250);
    assert.equal(E.earningsFor(50000, 10), 500);
    assert.equal(E.earningsFor(100000, 10), 1000);
    // Shorts: ₹10 per 5,000 eligible views.
    assert.equal(E.earningsFor(5000, 2), 10);
    assert.equal(E.earningsFor(50000, 2), 100);
    assert.equal(E.earningsFor(250000, 2), 500);
    // Partial thousands keep their precision.
    assert.equal(E.earningsFor(1, 10), 0.01);
    assert.equal(E.earningsFor(333, 10), 3.33);
    assert.equal(E.round2(E.earningsFor(1234, 2)), 2.47);
  });

  test('shorts and long videos earn at their own rates from the same view count', async () => {
    const day = dayStr(5);
    const shortC = await creatorWithVideo('short');
    const longC = await creatorWithVideo('long');
    await seedViews(shortC.videoId, day, 50, { prefix: 's' });
    await seedViews(longC.videoId, day, 50, { prefix: 'l' });
    await E.aggregateDay(day);

    const s = await db.one(`select kind, eligible_views, rate_per_1000, amount from earning_entries
                             where video_id = (select id from videos where public_id = $1)`, [shortC.videoId]);
    const l = await db.one(`select kind, eligible_views, rate_per_1000, amount from earning_entries
                             where video_id = (select id from videos where public_id = $1)`, [longC.videoId]);
    assert.equal(s.eligible_views, 50);
    assert.equal(Number(s.rate_per_1000), 2);
    assert.equal(Number(s.amount), 0.1);      // 50 / 1000 * 2
    assert.equal(Number(l.rate_per_1000), 10);
    assert.equal(Number(l.amount), 0.5);      // 50 / 1000 * 10
  });

  test('each entry keeps the rate it was created with, so a later change cannot rewrite history', async () => {
    const day = dayStr(6);
    const c = await creatorWithVideo('long');
    await seedViews(c.videoId, day, 1000, { prefix: 'hist' });
    await E.aggregateDay(day);
    const before = await db.one('select amount, rate_per_1000 from earning_entries where day = $1 and channel_id = $2', [day, c.channelId]);
    assert.equal(Number(before.amount), 10);

    await setSetting('monetization', { ...BASE, rate_long_per_1000: 99 });
    await db.query(`update earning_entries set status = 'approved' where day = $1 and channel_id = $2`, [day, c.channelId]);
    await E.aggregateDay(day); // re-running must not touch an approved entry

    const after = await db.one('select amount, rate_per_1000 from earning_entries where day = $1 and channel_id = $2', [day, c.channelId]);
    assert.equal(Number(after.rate_per_1000), 10, 'the historical rate is preserved');
    assert.equal(Number(after.amount), 10);
    await setSetting('monetization', BASE);
  });
});

describe('eligible views', () => {
  test('aggregating the same day twice does not create or double anything', async () => {
    const day = dayStr(7);
    const c = await creatorWithVideo('long');
    await seedViews(c.videoId, day, 2000, { prefix: 'idem' });
    await E.aggregateDay(day);
    await E.aggregateDay(day);
    await E.aggregateDay(day);
    const rows = await db.query('select amount from earning_entries where channel_id = $1 and day = $2', [c.channelId, day]);
    assert.equal(rows.length, 1, 'one entry per video per day');
    assert.equal(Number(rows[0].amount), 20);
  });

  test('one viewer watching repeatedly counts once', async () => {
    const day = dayStr(8);
    const c = await creatorWithVideo('long');
    const vid = await db.one('select id from videos where public_id = $1', [c.videoId]);
    for (let i = 0; i < 25; i++) {
      await db.query(`insert into video_events (video_id, type, actor_key, created_at)
                      values ($1,'view','a:repeat-viewer', ($2::date + interval '3 hours'))`, [vid.id, day]);
    }
    await E.aggregateDay(day);
    const row = await db.one('select eligible_views, raw_events from video_view_daily where video_id = $1 and day = $2', [vid.id, day]);
    assert.equal(row.eligible_views, 1, '25 events from one viewer are one eligible view');
    assert.equal(row.raw_events, 25);
  });

  test('a viewer over the daily cap earns nothing and is recorded as suspicious', async () => {
    const day = dayStr(9);
    await setSetting('monetization', { ...BASE, max_views_per_actor_per_day: 5 });
    const c = await creatorWithVideo('long');
    const vid = await db.one('select id from videos where public_id = $1', [c.videoId]);
    // One abusive actor hitting many videos, plus 10 honest viewers.
    const others = await db.query(`select id from videos where status = 'published' limit 8`);
    for (const v of others) {
      await db.query(`insert into video_events (video_id, type, actor_key, created_at)
                      values ($1,'view','a:bot-1', ($2::date + interval '1 hour'))`, [v.id, day]);
    }
    await db.query(`insert into video_events (video_id, type, actor_key, created_at)
                    values ($1,'view','a:bot-1', ($2::date + interval '2 hours'))`, [vid.id, day]);
    await seedViews(c.videoId, day, 10, { prefix: 'honest' });
    await E.aggregateDay(day);

    const flagged = await db.one('select reason, events from suspicious_actors where day = $1 and actor_key = $2', [day, 'a:bot-1']);
    assert.ok(flagged, 'the abusive viewer is recorded');
    const row = await db.one('select eligible_views, suspicious_views from video_view_daily where video_id = $1 and day = $2', [vid.id, day]);
    assert.equal(row.eligible_views, 10, 'only the honest viewers are eligible');
    assert.equal(row.suspicious_views, 1);
    const entry = await db.one('select amount from earning_entries where video_id = $1 and day = $2', [vid.id, day]);
    assert.equal(Number(entry.amount), 0.1, 'paid for 10 views, not 11');
    await setSetting('monetization', BASE);
  });

  test('one network posing as many viewers is caught', async () => {
    const day = dayStr(10);
    await setSetting('monetization', { ...BASE, max_actors_per_ip_per_day: 3 });
    const c = await creatorWithVideo('long');
    await seedViews(c.videoId, day, 12, { prefix: 'farm', ipHash: 'one-network' });
    await E.aggregateDay(day);
    const row = await db.one(`select eligible_views, suspicious_views from video_view_daily
                               where video_id = (select id from videos where public_id = $1) and day = $2`, [c.videoId, day]);
    assert.equal(row.eligible_views, 0, 'none of them earn');
    assert.equal(row.suspicious_views, 12);
    await setSetting('monetization', BASE);
  });

  test('unpublished videos and unapproved channels earn nothing', async () => {
    const day = dayStr(11);
    const c = await makeCreator();
    const pending = await uploadVideo(c, { kind: 'long', title: 'not published' });
    await seedViews(pending, day, 5000, { prefix: 'unpub' });

    const suspended = await creatorWithVideo('long');
    await seedViews(suspended.videoId, day, 5000, { prefix: 'susp' });
    await db.query(`update channels set status = 'suspended' where id = $1`, [suspended.channelId]);

    await E.aggregateDay(day);
    const a = await db.query(`select 1 from earning_entries where video_id = (select id from videos where public_id = $1)`, [pending]);
    const b = await db.query(`select 1 from earning_entries where video_id = (select id from videos where public_id = $1) and day = $2`, [suspended.videoId, day]);
    assert.equal(a.length, 0, 'a video awaiting moderation does not earn');
    assert.equal(b.length, 0, 'a suspended channel does not earn');
  });
});

describe('the ₹500 threshold and carry-forward', () => {
  async function creatorWithBalance(amount, { day = dayStr(20) } = {}) {
    const c = await creatorWithVideo('long');
    const views = Math.round(amount * 100); // ₹10 per 1000 views -> ₹1 per 100 views
    await seedViews(c.videoId, day, views, { prefix: `bal${Math.random().toString(36).slice(2, 7)}` });
    await E.aggregateDay(day);
    await db.query(`update earning_entries set status = 'approved' where channel_id = $1`, [c.channelId]);
    return c;
  }

  test('₹250 and ₹499 stay put; ₹500, ₹850 and ₹1,250 become payable', async () => {
    const cases = [[250, false], [499, false], [500, true], [850, true], [1250, true]];
    for (const [amount, shouldPay] of cases) {
      const c = await creatorWithBalance(amount);
      const bal = await E.balanceFor(c.channelId);
      assert.equal(E.round2(bal.payable), amount, `balance for ₹${amount}`);
      assert.equal(bal.meets_minimum, shouldPay, `₹${amount} eligibility`);
      assert.equal(E.round2(bal.carried_forward), shouldPay ? 0 : amount, `₹${amount} carry-forward`);
    }
  });

  test('a batch pays those at or above the minimum and leaves the rest untouched', async () => {
    await resetLedger();
    const small = await creatorWithBalance(300);
    const big = await creatorWithBalance(900);

    const batch = await E.buildBatch({ periodStart: firstOfMonth(dayStr(20)), adminId: null });
    assert.equal(batch.status, 'review');
    assert.equal(batch.payout_count, 1, 'only the creator above the minimum gets a payout');
    assert.equal(E.round2(batch.total_amount), 900);
    assert.ok(batch.carried_count >= 1);

    assert.equal(E.round2(await payableOf(big.channelId)), 0, 'the paid balance is now spoken for');
    assert.equal(E.round2(await payableOf(small.channelId)), 300, 'the small balance is untouched');

    const payouts = await db.query('select channel_id, amount, status from payouts where batch_id = $1', [batch.id]);
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].channel_id, big.channelId);
    assert.equal(E.round2(payouts[0].amount), 900);
    assert.equal(payouts[0].status, 'eligible');
  });

  test('₹300 one month plus ₹250 the next becomes ₹550 and is then paid', async () => {
    await resetLedger();

    const monthA = firstOfMonth(dayStr(45));
    const monthB = firstOfMonth(dayStr(10));
    const c = await creatorWithVideo('long');
    // ₹300 in the first month.
    await seedViews(c.videoId, addDays(monthA, 3), 30000, { prefix: 'm1' });
    // ₹250 in the second.
    await seedViews(c.videoId, addDays(monthB, 3), 25000, { prefix: 'm2' });
    await E.aggregateDay(addDays(monthA, 3));
    await E.aggregateDay(addDays(monthB, 3));
    await db.query(`update earning_entries set status = 'approved' where channel_id = $1`, [c.channelId]);

    // First batch: ₹300 is below ₹500, so nothing is paid and nothing is attached.
    const b1 = await E.buildBatch({ periodStart: monthA });
    const afterFirst = await E.balanceFor(c.channelId);
    assert.equal(E.round2(afterFirst.payable), 550, 'both months remain payable');
    assert.equal((await db.query('select 1 from payouts where batch_id = $1 and channel_id = $2', [b1.id, c.channelId])).length, 0);

    // Second batch covers both periods: ₹550 is over the minimum.
    const b2 = await E.buildBatch({ periodStart: monthB });
    const payout = await db.one('select amount, status from payouts where batch_id = $1 and channel_id = $2', [b2.id, c.channelId]);
    assert.equal(E.round2(payout.amount), 550, 'the carried amount is paid once, in full');
    assert.equal(E.round2(await payableOf(c.channelId)), 0, 'and is not payable a second time');
  });

  test('rebuilding a draft batch does not double anything', async () => {
    await resetLedger();
    const c = await creatorWithBalance(700, { day: dayStr(20) });
    const period = firstOfMonth(dayStr(20));

    const first = await E.buildBatch({ periodStart: period });
    await db.query(`update payout_batches set status = 'draft' where id = $1`, [first.id]);
    const second = await E.buildBatch({ periodStart: period });

    assert.equal(E.round2(second.total_amount), 700, 'the total is the same, not doubled');
    const payouts = await db.query('select id from payouts where channel_id = $1', [c.channelId]);
    assert.equal(payouts.length, 1, 'still a single payout');
    assert.equal(E.round2(await payableOf(c.channelId)), 0);
  });

  test('a batch that is no longer a draft refuses to be rebuilt', async () => {
    await resetLedger();
    const period = firstOfMonth(dayStr(20));
    await E.buildBatch({ periodStart: period });                 // leaves it in "review"
    await assert.rejects(() => E.buildBatch({ periodStart: period }), /already exists and is review/);
  });

  test('adjustments join the balance and are paid with it', async () => {
    await resetLedger();
    const c = await creatorWithBalance(400, { day: dayStr(20) });
    assert.equal(E.round2(await payableOf(c.channelId)), 400);

    await db.query(`insert into payout_adjustments (channel_id, amount, reason) values ($1, 150, 'documented correction')`, [c.channelId]);
    const bal = await E.balanceFor(c.channelId);
    assert.equal(E.round2(bal.payable), 550);
    assert.equal(bal.meets_minimum, true, 'the adjustment carries it over the minimum');

    const batch = await E.buildBatch({ periodStart: firstOfMonth(dayStr(20)) });
    const payout = await db.one('select amount from payouts where batch_id = $1 and channel_id = $2', [batch.id, c.channelId]);
    assert.equal(E.round2(payout.amount), 550);
    assert.equal(E.round2(await payableOf(c.channelId)), 0);
  });
});

describe('payout states', () => {
  async function aPayout() {
    await resetLedger();
    const c = await creatorWithVideo('long');
    await seedViews(c.videoId, dayStr(20), 60000, { prefix: `st${Math.random().toString(36).slice(2, 7)}` });
    await E.aggregateDay(dayStr(20));
    await db.query(`update earning_entries set status = 'approved' where channel_id = $1`, [c.channelId]);
    const batch = await E.buildBatch({ periodStart: firstOfMonth(dayStr(20)) });
    const p = await db.one('select * from payouts where batch_id = $1 and channel_id = $2', [batch.id, c.channelId]);
    return { channel: c, payout: p };
  }

  test('only the documented transitions are allowed', async () => {
    const { payout } = await aPayout();
    await assert.rejects(() => E.transitionPayout(payout.id, 'paid', { fields: { transaction_ref: 'X' } }), /cannot become paid/);
    await E.transitionPayout(payout.id, 'approved');
    await E.transitionPayout(payout.id, 'processing');
    await assert.rejects(() => E.transitionPayout(payout.id, 'eligible'), /cannot become eligible/);
  });

  test('a payout cannot be marked paid without a reference', async () => {
    const { payout } = await aPayout();
    await E.transitionPayout(payout.id, 'approved');
    await E.transitionPayout(payout.id, 'processing');
    await assert.rejects(() => E.transitionPayout(payout.id, 'paid', {}), /transaction reference/);
    const done = await E.transitionPayout(payout.id, 'paid', { fields: { transaction_ref: 'UPI-12345' } });
    assert.equal(done.status, 'paid');
    assert.ok(done.paid_at);
    const bal = await E.balanceFor(payout.channel_id);
    assert.equal(E.round2(bal.paid_to_date), E.round2(payout.amount));
    assert.equal(E.round2(bal.payable), 0, 'paid money is not payable again');
  });

  test('a paid payout is final', async () => {
    const { payout } = await aPayout();
    await E.transitionPayout(payout.id, 'approved');
    await E.transitionPayout(payout.id, 'processing');
    await E.transitionPayout(payout.id, 'paid', { fields: { transaction_ref: 'R-1' } });
    for (const to of ['failed', 'cancelled', 'processing', 'on_hold']) {
      await assert.rejects(() => E.transitionPayout(payout.id, to), /cannot become/);
    }
  });

  test('a failed payout can be retried and does not pay twice', async () => {
    const { payout, channel } = await aPayout();
    await E.transitionPayout(payout.id, 'approved');
    await E.transitionPayout(payout.id, 'processing');
    await E.transitionPayout(payout.id, 'failed', { fields: { failure_reason: 'bank rejected' } });
    assert.equal(E.round2(await payableOf(channel.channelId)), 0, 'a failed payout still holds its money');

    await E.transitionPayout(payout.id, 'approved');
    await E.transitionPayout(payout.id, 'processing');
    await E.transitionPayout(payout.id, 'paid', { fields: { transaction_ref: 'R-2' } });
    const paidRows = await db.query(`select id from payouts where channel_id = $1 and status = 'paid'`, [channel.channelId]);
    assert.equal(paidRows.length, 1, 'one payment, not two');
  });

  test('cancelling returns the money to the balance so it carries forward', async () => {
    const { payout, channel } = await aPayout();
    const amount = E.round2(payout.amount);
    await E.transitionPayout(payout.id, 'cancelled', { fields: { note: 'creator asked to hold' } });
    assert.equal(E.round2(await payableOf(channel.channelId)), amount, 'the money is payable again');
    const attached = await db.query('select 1 from earning_entries where payout_id = $1', [payout.id]);
    assert.equal(attached.length, 0);
  });

  test('putting a payout on hold keeps the money reserved', async () => {
    const { payout, channel } = await aPayout();
    await E.transitionPayout(payout.id, 'on_hold', { fields: { hold_reason: 'verification pending' } });
    const bal = await E.balanceFor(channel.channelId);
    assert.equal(E.round2(bal.payable), 0);
    assert.equal(E.round2(bal.on_hold), E.round2(payout.amount));
  });
});

describe('scheduling', () => {
  test('the next payout is the 7th of the coming month', () => {
    assert.equal(E.nextPayoutDate(7, new Date('2026-03-01T00:00:00Z')), '2026-03-07');
    assert.equal(E.nextPayoutDate(7, new Date('2026-03-07T12:00:00Z')), '2026-04-07');
    assert.equal(E.nextPayoutDate(7, new Date('2026-12-20T00:00:00Z')), '2027-01-07');
  });

  test('a batch scheduled on the 7th pays for the previous whole month', () => {
    assert.deepEqual(E.periodForBatch('2026-03-07'), { period_start: '2026-02-01', period_end: '2026-02-28' });
    assert.deepEqual(E.periodForBatch('2027-01-07'), { period_start: '2026-12-01', period_end: '2026-12-31' });
  });
});

function firstOfMonth(dateStr) { return dateStr.slice(0, 8) + '01'; }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
