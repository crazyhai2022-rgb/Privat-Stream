import test, { after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeCreator, uploadVideo, publish, shutdown } from './helpers.js';
import { mixCounts, recommend } from '../src/services/recommend.js';
import { setSetting } from '../src/services/settings.js';

after(shutdown);

const CFG = { enabled: true, preferred: 5, fresh: 3, exploratory: 2, fresh_days: 7, history_days: 30 };
const ids = { A: [], B: [], C: [] };
let cats;

before(async () => {
  await setSetting('recommendations', CFG);
  cats = (await db.query('select id from categories order by sort_order, name limit 3')).map((c) => c.id);
  const mk = async (group, cat, n, ageDays) => {
    const c = await makeCreator();
    for (let i = 0; i < n; i++) {
      const id = await uploadVideo(c, { kind: 'short', title: `${group} ${i}`, categoryId: cat });
      await publish(id);
      await db.query(`update videos set published_at = now() - make_interval(days => $2::int) where public_id = $1`, [id, ageDays]);
      ids[group].push(id);
    }
  };
  await mk('A', cats[0], 4, 30);
  await mk('B', cats[1], 4, 30);
  await mk('C', cats[2], 3, 0);
});

const view = (publicId, actor) => db.query(
  `insert into video_events (video_id, type, actor_key) select id, 'view', $2 from videos where public_id = $1`, [publicId, actor]);

describe('the mix', () => {
  test('splits any page size across the configured proportions', () => {
    assert.deepEqual(mixCounts(10, CFG), { preferred: 5, fresh: 3, exploratory: 2 });
    assert.deepEqual(mixCounts(10, { preferred: 5, fresh: 2, exploratory: 3 }), { preferred: 5, fresh: 2, exploratory: 3 });
    for (const limit of [1, 3, 7, 12, 25]) {
      const m = mixCounts(limit, CFG);
      assert.equal(m.preferred + m.fresh + m.exploratory, limit, `limit ${limit}`);
    }
    assert.equal(mixCounts(10, { preferred: 10, fresh: 0, exploratory: 0 }).fresh, 0, 'a zero slot stays zero');
  });
});

describe('recommend()', () => {
  test('favours what the viewer watches, adds new videos and something different, and never repeats', async () => {
    const actor = 'a:fan-of-A';
    await view(ids.A[0], actor);
    const r = await recommend({ actorKey: actor, kind: 'short', limit: 10 });
    const got = r.rows.map((x) => x.public_id);
    assert.equal(new Set(got).size, got.length, 'no duplicates');
    assert.ok(!got.includes(ids.A[0]), 'already watched video is not shown again');
    const by = (tag) => r.rows.filter((x) => x.rec === tag);
    assert.ok(by('preferred').length >= 1 && by('preferred').every((x) => ids.A.includes(x.public_id)), 'preferred comes from the watched category');
    assert.ok(by('fresh').length >= 1 && by('fresh').every((x) => ids.C.includes(x.public_id)), 'fresh means recently published');
    assert.ok(by('exploratory').every((x) => !ids.A.includes(x.public_id)), 'exploratory comes from outside the usual interests');
  });

  test('a brand-new visitor still gets a full, varied page', async () => {
    const r = await recommend({ actorKey: null, kind: 'short', limit: 6 });
    assert.equal(r.rows.length, 6);
    assert.equal(new Set(r.rows.map((x) => x.public_id)).size, 6);
  });

  test('ids the client already shows are never repeated', async () => {
    const first = await recommend({ actorKey: 'a:x', kind: 'short', limit: 5 });
    const exclude = first.rows.map((x) => x.public_id);
    const next = await recommend({ actorKey: 'a:x', kind: 'short', limit: 5, exclude });
    assert.ok(next.rows.every((x) => !exclude.includes(x.public_id)));
  });

  test('only published videos from approved channels are ever recommended', async () => {
    const hidden = ids.B[0];
    await db.query(`update videos set status = 'removed' where public_id = $1`, [hidden]);
    for (let i = 0; i < 5; i++) {
      const r = await recommend({ actorKey: null, kind: 'short', limit: 10 });
      assert.ok(!r.rows.some((x) => x.public_id === hidden));
    }
    await db.query(`update videos set status = 'published' where public_id = $1`, [hidden]);
  });

  test('switching it off falls back to plain trending', async () => {
    await setSetting('recommendations', { ...CFG, enabled: false });
    const r = await recommend({ actorKey: 'a:x', kind: 'short', limit: 4 });
    assert.ok(r.rows.every((x) => x.rec === 'trending'));
    await setSetting('recommendations', CFG);
  });
});

describe('GET /api/feed/for-you', () => {
  test('is public, validates input and ignores junk in exclude', async () => {
    const c = client();
    const ok = await c.get('/api/feed/for-you?kind=short&limit=5&exclude=' + encodeURIComponent('bad id,<script>,' + ids.A[1]));
    assert.equal(ok.status, 200);
    assert.ok(ok.body.items.length > 0 && ok.body.items.every((v) => v.id !== ids.A[1]));
    assert.match(ok.headers.get('cache-control'), /no-store/);
    assert.equal((await c.get('/api/feed/for-you?kind=podcast')).status, 400);
    assert.equal((await c.get('/api/feed/for-you?limit=999')).status, 400);
  });

  test('settings reject an empty mix', async () => {
    const { makeAdmin } = await import('./helpers.js');
    const admin = await makeAdmin();
    const bad = await admin.client.put('/api/admin/settings/recommendations', { value: { ...CFG, preferred: 0, fresh: 0, exploratory: 0 } });
    assert.equal(bad.status, 400);
    const good = await admin.client.put('/api/admin/settings/recommendations', { value: { ...CFG, preferred: 6, fresh: 2, exploratory: 2 } });
    assert.equal(good.status, 200);
    await setSetting('recommendations', CFG);
  });
});
