import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeAdmin, makeCreator, makeUser, shutdown } from './helpers.js';
import { recordVisit, isBot, visitorStats, purgeOldVisitors } from '../src/services/visitors.js';
import { runMaintenance } from '../src/services/maintenance.js';

after(shutdown);
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0 Safari/537.36' };

describe('recording visits', () => {
  test('one row per visitor per day; repeat visits add page views; the first ever visit is "new"', async () => {
    await db.query('delete from visitor_days');
    const c = client();
    for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/visit', {}, { headers: UA })).body.counted, true);
    const rows = await db.query('select * from visitor_days');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].views, 3);
    assert.equal(rows[0].is_new, true);
    // the same visitor tomorrow is returning
    await db.query(`update visitor_days set day = current_date - 1`);
    await c.post('/api/visit', {}, { headers: UA });
    const today = await db.one('select is_new from visitor_days where day = current_date');
    assert.equal(today.is_new, false);
  });

  test('bots and Do-Not-Track visitors are not counted, and nothing identifying is stored', async () => {
    await db.query('delete from visitor_days');
    assert.equal((await client().post('/api/visit', {}, { headers: { 'User-Agent': 'Googlebot/2.1' } })).body.counted, false);
    assert.equal((await client().post('/api/visit', {}, { headers: { ...UA, DNT: '1' } })).body.counted, false);
    assert.equal((await db.query('select 1 from visitor_days')).length, 0);
    assert.ok(isBot('') && isBot('curl/8') && !isBot(UA['User-Agent']));
    await client().post('/api/visit', {}, { headers: UA });
    const cols = Object.keys((await db.query('select * from visitor_days'))[0]);
    assert.deepEqual(cols.sort(), ['created_at', 'day', 'is_new', 'user_id', 'views', 'visitor_key']);
    const row = await db.one('select visitor_key from visitor_days');
    assert.match(row.visitor_key, /^a:[0-9a-f]{40}$/, 'only a hashed key, never an IP');
  });

  test('signed-in visitors are linked to their account for the signed-in count', async () => {
    await db.query('delete from visitor_days');
    const u = await makeUser();
    await u.client.post('/api/visit', {}, { headers: UA });
    const s = await visitorStats(7);
    assert.equal(s.totals.signed_in, 1);
  });
});

describe('admin analytics', () => {
  test('requires a Super Admin and returns a complete daily series', async () => {
    await db.query('delete from visitor_days');
    await recordVisit({ key: 'a:one', userAgent: UA['User-Agent'] });
    await recordVisit({ key: 'a:two', userAgent: UA['User-Agent'] });
    await db.query(`insert into visitor_days (day, visitor_key, is_new, views) values (current_date - 2, 'a:old', true, 4)`);

    assert.equal((await client().get('/api/admin/analytics/visitors')).status, 401);
    assert.equal((await (await makeCreator()).client.get('/api/admin/analytics/visitors')).status, 401);
    const mod = await makeAdmin({ role: 'moderator' });
    assert.equal((await mod.client.get('/api/admin/analytics/visitors')).status, 403);

    const sa = await makeAdmin();
    const r = await sa.client.get('/api/admin/analytics/visitors?days=7');
    assert.equal(r.status, 200);
    assert.equal(r.body.series.length, 7, 'days with no visitors still appear');
    assert.equal(r.body.today.visitors, 2);
    assert.equal(r.body.totals.unique_visitors, 3);
    assert.equal(r.body.totals.pageviews, 6);
    assert.equal(r.body.by_hour_utc.length, 24);
  });
});

describe('maintenance', () => {
  test('runs end to end, is repeatable, and trims old analytics rows', async () => {
    await db.query(`insert into visitor_days (day, visitor_key, views) values (current_date - 500, 'a:ancient', 1)`);
    const a = await runMaintenance();
    const b = await runMaintenance();
    assert.ok(a.purged_visitor_rows >= 1);
    assert.equal(b.purged_visitor_rows, 0);
    assert.equal((await db.query(`select 1 from visitor_days where visitor_key = 'a:ancient'`)).length, 0);
    assert.equal(await purgeOldVisitors(), 0);
  });
});
