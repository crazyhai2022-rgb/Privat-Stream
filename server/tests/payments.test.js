import test, { after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeCreator, makeUser, uploadVideo, publish, shutdown } from './helpers.js';
import * as E from '../src/services/earnings.js';
import { seal, open } from '../src/lib/secretbox.js';
import { validateMethod } from '../src/services/paymentMethods.js';
import { resolveRange } from '../src/routes/earnings.js';

after(shutdown);

const UPI = { type: 'upi', holder_name: 'Asha Rao', value: 'asha.rao@okaxis' };
const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const EVM = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const BTC_LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const BTC_BECH = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const crypto = (o) => ({ type: 'crypto', holder_name: 'Asha Rao', network_confirmed: true, ...o });

describe('encryption', () => {
  test('round-trips, is randomised, and rejects tampering', () => {
    const a = seal('asha@okaxis'), b = seal('asha@okaxis');
    assert.notEqual(a, b);
    assert.equal(open(a), 'asha@okaxis');
    assert.throws(() => open(a.slice(0, -2) + 'AA'));
    assert.ok(!a.includes('asha'));
  });
});

describe('address validation', () => {
  test('accepts real addresses on the right network', () => {
    assert.equal(validateMethod(UPI).value, 'asha.rao@okaxis');
    assert.ok(validateMethod(crypto({ asset: 'usdt', network: 'tron', value: TRON })));
    assert.ok(validateMethod(crypto({ asset: 'usdt', network: 'bsc', value: EVM })));
    assert.ok(validateMethod(crypto({ asset: 'usdt', network: 'ethereum', value: EVM })));
    assert.ok(validateMethod(crypto({ asset: 'eth', network: 'ethereum', value: EVM })));
    assert.ok(validateMethod(crypto({ asset: 'btc', network: 'bitcoin', value: BTC_LEGACY })));
    assert.ok(validateMethod(crypto({ asset: 'btc', network: 'bitcoin', value: BTC_BECH })));
  });
  test('rejects wrong-network, bad-checksum, malformed and unconfirmed submissions', () => {
    assert.throws(() => validateMethod(crypto({ asset: 'usdt', network: 'tron', value: EVM })), /valid/);
    assert.throws(() => validateMethod(crypto({ asset: 'btc', network: 'bitcoin', value: EVM })), /valid/);
    assert.throws(() => validateMethod(crypto({ asset: 'eth', network: 'ethereum', value: TRON })), /valid/);
    assert.throws(() => validateMethod(crypto({ asset: 'btc', network: 'bitcoin', value: BTC_LEGACY.slice(0, -1) + '3' })), /valid/);
    assert.throws(() => validateMethod(crypto({ asset: 'usdt', network: 'tron', value: TRON.slice(0, -1) + 'u' })), /valid/);
    assert.throws(() => validateMethod(crypto({ asset: 'btc', network: 'tron', value: TRON })), /supported/);
    assert.throws(() => validateMethod({ ...crypto({ asset: 'usdt', network: 'tron', value: TRON }), network_confirmed: false }), /Confirm/);
    assert.throws(() => validateMethod({ ...UPI, value: 'not-a-upi' }), /UPI/);
    assert.throws(() => validateMethod({ ...UPI, holder_name: '' }), /holder/);
  });
});

describe('payment settings API', () => {
  test('requires login and an approved channel', async () => {
    assert.equal((await client().get('/api/me/payment-methods')).status, 401);
    assert.equal((await client().get('/api/me/earnings')).status, 401);
    const pending = await makeCreator({ approve: false });
    assert.equal((await pending.client.post('/api/me/payment-methods', UPI)).status, 403);
    const noChannel = await makeUser();
    assert.equal((await noChannel.client.get('/api/me/earnings')).status, 403);
  });

  test('stores only ciphertext, shows only a masked value, and starts pending verification', async () => {
    const c = await makeCreator();
    const r = await c.client.post('/api/me/payment-methods', UPI);
    assert.equal(r.status, 201);
    assert.equal(r.body.method.status, 'pending');
    assert.equal(r.body.method.is_default, true);
    assert.match(r.body.method.masked, /\*\*\*\*@okaxis$/);
    assert.ok(!JSON.stringify(r.body).includes('asha.rao'), 'the full identifier is never returned');

    const row = await db.one('select * from payout_methods where channel_id = $1', [c.channelId]);
    assert.ok(!JSON.stringify(row).includes('asha.rao'), 'and never stored in clear');
    assert.equal(open(row.secret_cipher), 'asha.rao@okaxis');

    const list = await c.client.get('/api/me/payment-methods');
    assert.ok(!JSON.stringify(list.body).includes('secret'));
  });

  test('a duplicate is refused and one creator cannot touch another\'s method', async () => {
    const a = await makeCreator(), b = await makeCreator();
    const first = await a.client.post('/api/me/payment-methods', UPI);
    assert.equal((await a.client.post('/api/me/payment-methods', UPI)).status, 400);
    const id = first.body.method.id;
    assert.equal((await b.client.del(`/api/me/payment-methods/${id}`)).status, 404);
    assert.equal((await b.client.post(`/api/me/payment-methods/${id}/default`)).status, 404);
    assert.equal((await a.client.del(`/api/me/payment-methods/${id}`)).status, 200);
  });

  test('crypto needs a confirmed network', async () => {
    const c = await makeCreator();
    const body = crypto({ asset: 'usdt', network: 'tron', value: TRON });
    assert.equal((await c.client.post('/api/me/payment-methods', { ...body, network_confirmed: false })).status, 400);
    const ok = await c.client.post('/api/me/payment-methods', body);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.method.network, 'tron');
    assert.match(ok.body.method.masked, /^TR7NHq….{0,1}j6t$|…/);
  });
});

describe('earnings dashboard data', () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  test('range filters resolve and bad ones are refused', () => {
    const now = new Date('2026-10-25T10:00:00Z');
    assert.deepEqual(resolveRange({ range: '7' }, now), { from: '2026-10-19', to: '2026-10-25' });
    assert.deepEqual(resolveRange({ range: '30' }, now), { from: '2026-09-26', to: '2026-10-25' });
    assert.deepEqual(resolveRange({ range: 'custom', from: '2026-10-01', to: '2026-10-10' }, now), { from: '2026-10-01', to: '2026-10-10' });
    assert.throws(() => resolveRange({ range: 'custom', from: '2026-10-10', to: '2026-10-01' }, now));
    assert.throws(() => resolveRange({ range: 'custom', from: '2024-01-01', to: '2026-10-01' }, now));
    assert.throws(() => resolveRange({ range: 'custom' }, now));
  });

  test('summary, chart, top videos and history show the figures the ledger holds', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'long', title: 'dash earner' });
    await publish(id);
    const v = await db.one('select id from videos where public_id = $1', [id]);
    // 3,000 eligible views two days ago (₹30) and 1,000 yesterday (₹10), at ₹10 per 1000.
    for (const [d, n] of [[2, 3000], [1, 1000]]) {
      await db.query(
        `insert into video_events (video_id, type, actor_key, created_at)
         select $1, 'view', 'a:dash-' || $2::text || '-' || g, ($2::date + interval '5 hours') from generate_series(0, $3::int - 1) g`,
        [v.id, day(d), n]);
      await E.aggregateDay(day(d));
    }
    await db.query(`update earning_entries set status = 'approved' where video_id = $1 and day = $2::date`, [v.id, day(2)]);

    const sum = await c.client.get('/api/me/earnings');
    assert.equal(sum.status, 200);
    assert.equal(sum.body.balance.payable, 30);
    assert.equal(sum.body.balance.pending, 10);
    assert.equal(sum.body.balance.estimated_total, 40);
    assert.equal(sum.body.balance.progress, 30 / 500);
    assert.equal(sum.body.balance.min_payout, 500);

    const chart = await c.client.get('/api/me/earnings/chart?range=7');
    assert.equal(chart.body.daily.length, 7);
    const byDay = Object.fromEntries(chart.body.daily.map((d) => [d.day, d]));
    assert.equal(byDay[day(2)].eligible_views, 3000);
    assert.equal(byDay[day(2)].estimated, 30);
    assert.equal(byDay[day(2)].approved, 30);
    assert.equal(byDay[day(1)].estimated, 10);
    assert.equal(byDay[day(1)].approved, 0);
    assert.equal(byDay[day(3)].eligible_views, 0, 'quiet days are zero, not missing');
    assert.equal(chart.body.daily.reduce((s, d) => s + d.estimated, 0), 40);

    const top = await c.client.get('/api/me/earnings/videos?range=30');
    assert.equal(top.body.items[0].title, 'dash earner');
    assert.equal(top.body.items[0].estimated, 40);

    const hist = await c.client.get('/api/me/payouts');
    assert.equal(hist.body.total, 0);

    // Another creator sees none of this.
    const other = await makeCreator();
    const o = await other.client.get('/api/me/earnings');
    assert.equal(o.body.balance.estimated_total, 0);
  });
});
