import test, { after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeAdmin, makeCreator, makeUser, uploadVideo, publish, shutdown } from './helpers.js';
import * as E from '../src/services/earnings.js';
import { setSetting } from '../src/services/settings.js';

after(shutdown);

const BASE = { enabled: true, rate_short_per_1000: 2, rate_long_per_1000: 10, min_payout: 500, payout_day: 7, approval_delay_days: 3,
  auto_approve: true, dedupe_hours: 24, max_views_per_actor_per_day: 200, max_actors_per_ip_per_day: 50, client_view_delay_seconds: 3 };
before(async () => { await setSetting('monetization', BASE); });

const P = '/api/admin/payments';
const UPI = { type: 'upi', holder_name: 'Asha Rao', value: 'asha.rao@okaxis' };
const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const lastMonthDay = () => { const d = new Date(); d.setUTCDate(0); d.setUTCDate(10); return d.toISOString().slice(0, 10); };
const periodStart = () => lastMonthDay().slice(0, 8) + '01';

async function funded(amount, { method = true, verified = true, crypto = false } = {}) {
  const c = await makeCreator();
  const vid = await uploadVideo(c, { kind: 'long', title: 'earner' });
  await publish(vid);
  const v = await db.one('select id from videos where public_id = $1', [vid]);
  await db.query(
    `insert into earning_entries (channel_id, video_id, kind, day, eligible_views, rate_per_1000, amount, status)
     values ($1,$2,'long',$3,$4,10,$5,'approved')`, [c.channelId, v.id, lastMonthDay(), Math.round(amount * 100), amount]);
  if (method) {
    const body = crypto ? { type: 'crypto', holder_name: 'Asha Rao', asset: 'usdt', network: 'tron', value: TRON, network_confirmed: true } : UPI;
    const r = await c.client.post('/api/me/payment-methods', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (verified) await db.query(`update payout_methods set status = 'verified' where channel_id = $1`, [c.channelId]);
  }
  return c;
}
async function reset() {
  await db.query('delete from payouts'); await db.query('delete from payout_batches');
  await db.query('delete from payout_adjustments'); await db.query('delete from earning_entries');
}

describe('access control', () => {
  test('payment endpoints need a Super Admin; moderators, creators and visitors are refused', async () => {
    const paths = ['/summary', '/eligibility', '/methods', '/batches', '/payouts', '/reconciliation', '/export/payouts.csv'];
    for (const p of paths) assert.equal((await client().get(P + p)).status, 401, p);
    const creator = await makeCreator();
    for (const p of paths) assert.ok([401, 403].includes((await creator.client.get(P + p)).status), p);
    const mod = await makeAdmin({ role: 'moderator' });
    for (const p of paths) assert.equal((await mod.client.get(P + p)).status, 403, p);
    const sa = await makeAdmin();
    for (const p of paths.slice(0, 6)) assert.equal((await sa.client.get(P + p)).status, 200, p);
  });
});

describe('method review and payout workflow', () => {
  test('a batch only approves creators with a verified method; paid needs a reference', async () => {
    await reset();
    const admin = await makeAdmin();
    const ok = await funded(900);
    const unverified = await funded(800, { verified: false });
    const noMethod = await funded(700, { method: false });

    const build = await admin.client.post(P + '/batches', { period_start: periodStart() });
    assert.equal(build.status, 201, JSON.stringify(build.body));
    assert.equal(build.body.batch.payout_count, 3);
    assert.equal(build.body.batch.total_amount, 2400);
    const again = await admin.client.post(P + '/batches', { period_start: periodStart() });
    assert.equal(again.status, 201, 'rebuilding a draft/review batch is allowed and does not double count');
    assert.equal(again.body.batch.total_amount, 2400);

    const id = build.body.batch.id;
    assert.equal((await admin.client.post(`${P}/batches/${id}/approve`, {})).status, 400, 'needs confirm');
    const ap = await admin.client.post(`${P}/batches/${id}/approve`, { confirm: true });
    assert.equal(ap.body.approved, 1);
    assert.equal(ap.body.skipped.length, 2);

    const detail = await admin.client.get(`${P}/batches/${id}`);
    const mine = detail.body.payouts.find((p) => p.channel_id === ok.channelId);
    assert.equal(mine.status, 'approved');

    // processing, then paid: reference mandatory
    assert.equal((await admin.client.post(`${P}/payouts/${mine.id}/transition`, { to: 'processing' })).status, 200);
    const noRef = await admin.client.post(`${P}/payouts/${mine.id}/transition`, { to: 'paid' });
    assert.equal(noRef.status, 400);
    const paid = await admin.client.post(`${P}/payouts/${mine.id}/transition`, { to: 'paid', transaction_ref: 'UTR123456789' });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.payout.status, 'paid');
    // repeating the same request is idempotent; going anywhere else is refused
    assert.equal((await admin.client.post(`${P}/payouts/${mine.id}/transition`, { to: 'paid', transaction_ref: 'UTR123456789' })).status, 200);
    assert.equal((await admin.client.post(`${P}/payouts/${mine.id}/transition`, { to: 'cancelled', reason: 'oops' })).status, 409);

    // the unverified one cannot be approved by hand either
    const un = detail.body.payouts.find((p) => p.channel_id === unverified.channelId);
    assert.equal((await admin.client.post(`${P}/payouts/${un.id}/transition`, { to: 'approved' })).status, 400);

    const audits = await db.one(`select count(*)::int as n from audit_logs where action like 'payout.%'`);
    assert.ok(audits.n >= 3);
  });

  test('crypto payouts require hash and a matching network; verification records a reason', async () => {
    await reset();
    const admin = await makeAdmin();
    const c = await funded(1000, { crypto: true, verified: false });
    const m = await db.one('select id from payout_methods where channel_id = $1', [c.channelId]);

    assert.equal((await admin.client.post(`${P}/methods/${m.id}/review`, { action: 'reject' })).status, 400, 'reason required');
    assert.equal((await admin.client.post(`${P}/methods/${m.id}/review`, { action: 'request_changes', reason: 'Wrong network' })).status, 200);
    assert.equal((await admin.client.post(`${P}/methods/${m.id}/review`, { action: 'verify' })).status, 200);

    const reveal = await admin.client.post(`${P}/methods/${m.id}/reveal`, {});
    assert.equal(reveal.body.identifier, TRON);
    assert.ok((await db.one(`select 1 as x from audit_logs where action = 'payment_method.reveal'`)));

    const b = await admin.client.post(P + '/batches', { period_start: periodStart() });
    await admin.client.post(`${P}/batches/${b.body.batch.id}/approve`, { confirm: true });
    const p = (await admin.client.get(`${P}/batches/${b.body.batch.id}`)).body.payouts[0];
    await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'processing' });
    assert.equal((await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'paid', transaction_ref: 'x' })).status, 400, 'tx hash needed');
    assert.equal((await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'paid', tx_hash: '0xabc', tx_network: 'ethereum' })).status, 400, 'network mismatch');
    const ok = await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'paid', tx_hash: 'abc123', tx_network: 'tron', paid_currency: 'USDT', paid_amount: 11.5, exchange_rate: 86.9 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.payout.tx_network, 'tron');
  });

  test('failed → retry → approved, and cancelling releases the money back to the creator', async () => {
    await reset();
    const admin = await makeAdmin();
    const c = await funded(600);
    const b = await admin.client.post(P + '/batches', { period_start: periodStart() });
    await admin.client.post(`${P}/batches/${b.body.batch.id}/approve`, { confirm: true });
    const p = (await admin.client.get(`${P}/batches/${b.body.batch.id}`)).body.payouts[0];
    await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'processing' });
    assert.equal((await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'failed' })).status, 400, 'reason required');
    assert.equal((await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'failed', reason: 'UPI id rejected' })).status, 200);
    assert.equal((await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'approved' })).status, 200, 'retry');
    assert.equal((await admin.client.post(`${P}/payouts/${p.id}/transition`, { to: 'cancelled', reason: 'creator asked' })).status, 200);
    assert.equal(E.round2((await E.balanceFor(c.channelId)).payable), 600, 'carried forward, not lost');
  });
});

describe('adjustments, reconciliation, exports, rates', () => {
  test('adjustments need a reason, join the balance, and the books still reconcile', async () => {
    await reset();
    const admin = await makeAdmin();
    const c = await funded(450);
    assert.equal((await admin.client.post(P + '/adjustments', { channel_id: c.channelId, amount: 100, reason: 'x' })).status, 400);
    assert.equal((await admin.client.post(P + '/adjustments', { channel_id: c.channelId, amount: 0, reason: 'zero amount' })).status, 400);
    assert.equal((await admin.client.post(P + '/adjustments', { channel_id: c.channelId, amount: 100, reason: 'Goodwill bonus' })).status, 201);
    assert.equal(E.round2((await E.balanceFor(c.channelId)).payable), 550);

    const b = await admin.client.post(P + '/batches', { period_start: periodStart() });
    assert.equal(b.body.batch.total_amount, 550);
    const rec = await admin.client.get(P + '/reconciliation');
    assert.equal(rec.body.balanced, true, JSON.stringify(rec.body));
    // tamper with a payout: reconciliation must notice
    await db.query(`update payouts set amount = amount + 5 where batch_id = $1`, [b.body.batch.id]);
    const bad = await admin.client.get(P + '/reconciliation');
    assert.equal(bad.body.balanced, false);
    assert.equal(bad.body.mismatches.length, 1);
  });

  test('CSV export neutralises formulas and is audited', async () => {
    await reset();
    const admin = await makeAdmin();
    const c = await funded(700);
    await db.query(`update channels set name = '=HYPERLINK("http://x")' where id = $1`, [c.channelId]);
    await admin.client.post(P + '/batches', { period_start: periodStart() });
    const res = await admin.client.get(P + '/export/payouts.csv', { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const text = await res.text();
    assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`), text);
    assert.ok((await db.one(`select count(*)::int as n from audit_logs where action = 'export.payouts'`)).n >= 1);
  });

  test('changing a rate in settings is recorded in the rate history', async () => {
    const admin = await makeAdmin();
    const r = await admin.client.put('/api/admin/settings/monetization', { value: { ...BASE, rate_long_per_1000: 12 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = await admin.client.get(P + '/rates');
    assert.ok(h.body.items.some((x) => x.kind === 'long' && Number(x.rate_per_1000) === 12));
    await admin.client.put('/api/admin/settings/monetization', { value: BASE });
  });

  test('payout dates roll weekends to Monday', () => {
    assert.equal(E.nextBusinessDay('2026-12-05'), '2026-12-07'); // Saturday
    assert.equal(E.nextBusinessDay('2026-07-05'), '2026-07-06'); // Sunday
    assert.equal(E.nextBusinessDay('2026-10-07'), '2026-10-07'); // Wednesday
  });

  test('summary reports real figures', async () => {
    await reset();
    const admin = await makeAdmin();
    await funded(900);
    const s = await admin.client.get(P + '/summary');
    assert.equal(s.body.cards.approved_unpaid, 900);
    assert.equal(s.body.eligible.channels, 1);
    assert.equal(s.body.cards.paid_total, 0);
  });
});

describe('withdrawal requests and creator earnings list', () => {
  test('creator requests a withdrawal; admin sees, approves and pays it; money is never double-counted', async () => {
    await reset();
    const admin = await makeAdmin();
    const c = await funded(750);
    const low = await funded(200);

    assert.equal((await client().post('/api/me/withdrawals', {})).status, 401);
    const blocked = await low.client.post('/api/me/withdrawals', {});
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error.message, /minimum/);
    assert.equal((await c.client.get('/api/me/withdrawal')).body.can_request, true);

    const [a, b] = await Promise.all([c.client.post('/api/me/withdrawals', {}), c.client.post('/api/me/withdrawals', {})]);
    assert.deepEqual([a.status, b.status].sort(), [201, 400], 'a double click creates exactly one request');
    assert.equal(E.round2((await E.balanceFor(c.channelId)).payable), 0, 'the balance is spoken for');

    const list = await admin.client.get(P + '/payouts?source=request');
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].amount, 750);
    assert.equal(list.body.items[0].source, 'request');
    assert.equal((await admin.client.get(P + '/summary')).body.cards.requests_waiting, 1);

    // a monthly batch must not pick the same money up again
    const batch = await admin.client.post(P + '/batches', { period_start: periodStart() });
    assert.equal(batch.body.batch.payout_count, 0);

    const id = list.body.items[0].id;
    assert.equal((await admin.client.post(`${P}/payouts/${id}/transition`, { to: 'approved' })).status, 200);
    assert.equal((await admin.client.post(`${P}/payouts/${id}/transition`, { to: 'processing' })).status, 200);
    assert.equal((await admin.client.post(`${P}/payouts/${id}/transition`, { to: 'paid', transaction_ref: 'UTR55' })).status, 200);
    assert.equal((await c.client.get('/api/me/payouts')).body.items[0].display_status, 'Paid');
  });

  test('admin sees every creator with their earnings; others cannot', async () => {
    await reset();
    const admin = await makeAdmin();
    const a = await funded(900);
    await funded(100);
    const r = await admin.client.get(P + '/creators?sort=payable');
    assert.equal(r.status, 200);
    assert.equal(r.body.items[0].channel_id, a.channelId);
    assert.equal(r.body.items[0].payable, 900);
    assert.equal(r.body.items[0].meets_minimum, true);
    assert.equal((await admin.client.get(P + '/creators?q=zzzznomatch')).body.items.length, 0);
    assert.equal((await (await makeAdmin({ role: 'moderator' })).client.get(P + '/creators')).status, 403);
  });
});
