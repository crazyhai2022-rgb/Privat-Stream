import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeUser, makeCreator, makeAdmin, uploadVideo, publish, shutdown } from './helpers.js';

after(shutdown);

const ADMIN_ROUTES = [
  ['get', '/api/admin/dashboard'], ['get', '/api/admin/users'], ['get', '/api/admin/creators'], ['get', '/api/admin/videos'],
  ['get', '/api/admin/reports'], ['get', '/api/admin/settings'], ['get', '/api/admin/audit'], ['get', '/api/admin/categories'],
];

describe('admin access control', () => {
  test('anonymous and ordinary logged-in users cannot reach any admin endpoint', async () => {
    const anon = client();
    const user = await makeUser();
    for (const [m, url] of ADMIN_ROUTES) {
      assert.equal((await anon[m](url)).status, 401, `anon ${url}`);
      assert.equal((await user.client[m](url)).status, 401, `user ${url}`);
    }
    // A normal user session cookie must not be accepted as an admin session.
    assert.equal((await user.client.post('/api/admin/users/00000000-0000-0000-0000-000000000000/suspend', { reason: 'x', confirm: true })).status, 401);
  });

  test('a non-admin account cannot log into the admin panel, and the error does not reveal why', async () => {
    const user = await makeUser();
    const c = client();
    const r = await c.post('/api/admin/auth/login', { email: user.email, password: user.password });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.message, 'Incorrect email or password');
    assert.equal((await c.get('/api/admin/dashboard')).status, 401);
  });

  test('the admin session is separate from the public session', async () => {
    const admin = await makeAdmin();
    assert.equal((await admin.client.get('/api/admin/dashboard')).status, 200);
    assert.ok(admin.client.cookies.get('ps_admin'), 'admin cookie is set');
    assert.equal(admin.client.cookies.get('ps_session'), undefined, 'no public session cookie is created');
    await admin.client.post('/api/admin/auth/logout');
    assert.equal((await admin.client.get('/api/admin/dashboard')).status, 401);
  });

  test('moderators have a reduced permission set', async () => {
    const mod = await makeAdmin({ role: 'moderator' });
    assert.equal((await mod.client.get('/api/admin/dashboard')).status, 200);
    assert.equal((await mod.client.get('/api/admin/videos')).status, 200);
    assert.equal((await mod.client.get('/api/admin/reports')).status, 200);
    // Not allowed: users, settings, categories, audit log.
    for (const url of ['/api/admin/users', '/api/admin/settings', '/api/admin/audit', '/api/admin/categories']) {
      assert.equal((await mod.client.get(url)).status, 403, url);
    }
    const target = await makeUser();
    assert.equal((await mod.client.post(`/api/admin/users/${target.userId}/role`, { role: 'super_admin', confirm: true })).status, 403);
  });

  test('destructive actions require confirmation and a reason', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);

    let r = await admin.client.post(`/api/admin/videos/${id}/remove`, { reason: 'Policy breach' });
    assert.equal(r.status, 400, 'removal without confirm is refused');
    r = await admin.client.post(`/api/admin/videos/${id}/remove`, { confirm: true });
    assert.equal(r.status, 400, 'removal without a reason is refused');
    r = await admin.client.post(`/api/admin/videos/${id}/remove`, { confirm: true, reason: 'Policy breach' });
    assert.equal(r.status, 200);
  });

  test('an admin cannot suspend themselves or remove the last Super Admin', async () => {
    const admin = await makeAdmin();
    assert.equal((await admin.client.post(`/api/admin/users/${admin.id}/suspend`, { reason: 'oops', confirm: true })).status, 403);
    assert.equal((await admin.client.post(`/api/admin/users/${admin.id}/role`, { role: 'user', confirm: true })).status, 403);
  });
});

describe('moderation workflow', () => {
  test('an administrator approves a creator and then publishes their video', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator({ approve: false, handle: 'approveme' });
    const pending = await admin.client.get('/api/admin/creators?status=pending');
    assert.ok(pending.body.items.some((x) => x.handle === 'approveme'));

    assert.equal((await admin.client.post(`/api/admin/channels/${c.channelId}/approve`, {})).status, 200);
    const id = await uploadVideo(c, { kind: 'long', title: 'Needs review' });

    const queue = await admin.client.get('/api/admin/videos?status=pending_moderation');
    assert.ok(queue.body.items.some((v) => v.public_id === id));

    assert.equal((await client().get(`/api/videos/${id}`)).status, 404, 'not public before approval');
    assert.equal((await admin.client.post(`/api/admin/videos/${id}/approve`, {})).status, 200);
    assert.equal((await client().get(`/api/videos/${id}`)).status, 200, 'public after approval');

    const detail = await admin.client.get(`/api/admin/videos/${id}`);
    assert.ok(detail.body.history.some((a) => a.action === 'approved'));
  });

  test('rejecting tells the creator why; removing hides the video and can be restored', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });

    await admin.client.post(`/api/admin/videos/${id}/reject`, { reason: 'Audio is copyrighted' });
    const mine = await c.client.get('/api/me/videos');
    const row = mine.body.items.find((v) => v.id === id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.rejected_reason, 'Audio is copyrighted');

    await admin.client.post(`/api/admin/videos/${id}/approve`, {});
    await admin.client.post(`/api/admin/videos/${id}/remove`, { reason: 'Reported by users', confirm: true });
    assert.equal((await client().get(`/api/videos/${id}`)).status, 404);

    assert.equal((await admin.client.post(`/api/admin/videos/${id}/restore`, {})).status, 200);
    assert.equal((await client().get(`/api/videos/${id}`)).status, 200);
  });

  test('a video a creator deleted cannot be restored by an administrator', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);
    await c.client.del(`/api/videos/${id}`);
    const r = await admin.client.post(`/api/admin/videos/${id}/restore`, {});
    assert.equal(r.status, 409);
  });

  test('reports can be investigated, dismissed or actioned, and actioning removes the content', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);
    const reporter = await makeUser();
    await reporter.client.post(`/api/videos/${id}/report`, { reason: 'hate', details: 'Abusive language' });

    const open = await admin.client.get('/api/admin/reports?status=open');
    const rep = open.body.items.find((x) => x.video_id === id);
    assert.ok(rep);
    assert.equal(rep.reason, 'hate');

    assert.equal((await admin.client.post(`/api/admin/reports/${rep.id}/investigate`, {})).status, 200);
    assert.equal((await admin.client.post(`/api/admin/reports/${rep.id}/action`, { action: 'remove_content', note: 'Confirmed abuse', confirm: true })).status, 200);
    assert.equal((await db.one('select status from videos where public_id = $1', [id])).status, 'removed');
    assert.equal((await db.one('select status from reports where id = $1', [rep.id])).status, 'actioned');
  });

  test('suspending a creator from a report blocks their uploads', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);
    const reporter = await makeUser();
    await reporter.client.post(`/api/videos/${id}/report`, { reason: 'spam' });
    const rep = (await admin.client.get('/api/admin/reports?status=open')).body.items.find((x) => x.video_id === id);
    await admin.client.post(`/api/admin/reports/${rep.id}/action`, { action: 'suspend_creator', note: 'Repeat offender', confirm: true });
    const up = await c.client.post('/api/videos', { kind: 'short', title: 'after suspension' });
    assert.equal(up.status, 403);
  });
});

describe('metrics integrity', () => {
  test('there is no endpoint that sets engagement counts directly', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);
    const before = await db.one('select views_count, hearts_count from videos where public_id = $1', [id]);
    // Attempts to inject counters through the metadata endpoint are ignored.
    await admin.client.patch(`/api/admin/videos/${id}`, { title: 'Edited', views_count: 999999, hearts_count: 999999, metrics: { views: 5e6 } });
    const after = await db.one('select views_count, hearts_count, title from videos where public_id = $1', [id]);
    assert.equal(after.title, 'Edited');
    assert.equal(after.views_count, before.views_count);
    assert.equal(after.hearts_count, before.hearts_count);
  });

  test('recount rebuilds counters from the stored events', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);
    await client().post(`/api/videos/${id}/react`, { type: 'heart' });
    // Simulate drift.
    await db.query('update videos set hearts_count = 5000, views_count = 9999 where public_id = $1', [id]);
    const r = await admin.client.post(`/api/admin/videos/${id}/recount`, {});
    assert.equal(r.body.after.hearts, 1);
    assert.equal(r.body.after.views, 0);
  });

  test('invalidating abusive engagement lowers counts and is audited', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    await publish(id);
    const vid = await db.one('select id from videos where public_id = $1', [id]);
    for (let i = 0; i < 6; i++) {
      await db.query(`insert into reactions (video_id, actor_key, type, ip_hash) values ($1, $2, 'heart', 'abusenetwork')`, [vid.id, `a:fake${i}`]);
    }
    await db.tx(async (q) => { const { recountVideo } = await import('../src/services/videos.js'); await recountVideo(q, vid.id); });
    assert.equal((await db.one('select hearts_count from videos where public_id = $1', [id])).hearts_count, 6);

    const sus = await admin.client.get(`/api/admin/videos/${id}/suspicious`);
    assert.ok(sus.body.anonymous_reactions_by_network.some((x) => x.ip_hash === 'abusenetwork'));

    const r = await admin.client.post(`/api/admin/videos/${id}/invalidate`, { type: 'ip', key: 'abusenetwork', reason: 'Coordinated voting', confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.after.hearts, 0);
    const audit = await admin.client.get('/api/admin/audit?action=invalidate');
    assert.ok(audit.body.items.some((a) => a.target_id === id));
  });

  test('featuring and pinning only apply to published videos', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    assert.equal((await admin.client.post(`/api/admin/videos/${id}/feature`, { featured: true })).status, 409);
    await publish(id);
    assert.equal((await admin.client.post(`/api/admin/videos/${id}/feature`, { featured: true })).status, 200);
    assert.equal((await admin.client.post(`/api/admin/videos/${id}/pin`, { rank: 1 })).status, 200);
    const featured = await client().get('/api/videos?kind=short&sort=featured');
    assert.ok(featured.body.items.some((v) => v.id === id));
  });
});

describe('settings, telegram and audit', () => {
  test('admin actions are written to the audit log', async () => {
    const admin = await makeAdmin();
    const c = await makeCreator({ approve: false });
    await admin.client.post(`/api/admin/channels/${c.channelId}/approve`, {});
    const log = await admin.client.get('/api/admin/audit');
    const entry = log.body.items.find((a) => a.action === 'creator.approved');
    assert.ok(entry, 'approval is audited');
    assert.equal(entry.actor_email, admin.email);
    assert.ok(log.body.items.some((a) => a.action === 'admin.login'));
  });

  test('the Telegram link follows the documented priority order', async () => {
    const { resolveTelegram } = await import('../src/services/telegram.js');
    const { setSetting, invalidateSettings } = await import('../src/services/settings.js');
    const creatorChannel = { telegram_url: 'https://t.me/creatorlink', telegram_enabled: true };

    await setSetting('telegram', { global_url: '', allow_creator_override: true, locked: false });
    assert.equal((await resolveTelegram(creatorChannel)).source, 'creator');
    assert.equal((await resolveTelegram({})).url, null, 'no link at all -> hidden');

    await setSetting('telegram', { global_url: 'https://t.me/platform', allow_creator_override: true, locked: false });
    assert.equal((await resolveTelegram(creatorChannel)).url, 'https://t.me/creatorlink');
    assert.equal((await resolveTelegram({})).url, 'https://t.me/platform');

    await setSetting('telegram', { global_url: 'https://t.me/platform', allow_creator_override: false, locked: false });
    assert.equal((await resolveTelegram(creatorChannel)).url, 'https://t.me/platform', 'overrides disabled');

    await setSetting('telegram', { global_url: 'https://t.me/platform', allow_creator_override: true, locked: true });
    const locked = await resolveTelegram(creatorChannel);
    assert.equal(locked.url, 'https://t.me/platform');
    assert.equal(locked.source, 'global_locked');

    // A creator who disabled their button falls back to the global link.
    await setSetting('telegram', { global_url: 'https://t.me/platform', allow_creator_override: true, locked: false });
    assert.equal((await resolveTelegram({ ...creatorChannel, telegram_enabled: false })).source, 'global');
    await setSetting('telegram', { global_url: '', allow_creator_override: true, locked: false });
    invalidateSettings();
  });

  test('only safe Telegram URLs are accepted', async () => {
    const { normalizeTelegramUrl } = await import('../src/services/telegram.js');
    assert.equal(normalizeTelegramUrl('https://t.me/good'), 'https://t.me/good');
    assert.equal(normalizeTelegramUrl('@goodname'), 'https://t.me/goodname');
    assert.equal(normalizeTelegramUrl('t.me/good'), 'https://t.me/good');
    for (const bad of ['javascript:alert(1)', 'http://t.me/insecure', 'https://evil.example/t.me', 'https://t.me', 'data:text/html,x', 'https://user:pw@t.me/x']) {
      assert.equal(normalizeTelegramUrl(bad), null, bad);
    }
    const admin = await makeAdmin();
    const bad = await admin.client.put('/api/admin/settings/telegram', { value: { global_url: 'https://evil.example/join', allow_creator_override: true, locked: false } });
    assert.equal(bad.status, 400);
    const creator = await makeCreator();
    const badCreator = await creator.client.patch('/api/me/channel', { telegram_url: 'https://evil.example/join' });
    assert.equal(badCreator.status, 400);
  });

  test('settings are validated and changes take effect', async () => {
    const admin = await makeAdmin();
    const bad = await admin.client.put('/api/admin/settings/upload', { value: { short_max_seconds: 99999, short_max_mb: 1, long_max_seconds: 60, long_max_mb: 1, allowed_formats: ['mp4'], thumbnail_max_mb: 1 } });
    assert.equal(bad.status, 400);
    const ok = await admin.client.put('/api/admin/settings/upload', { value: { short_max_seconds: 45, short_max_mb: 50, long_max_seconds: 600, long_max_mb: 200, allowed_formats: ['mp4', 'webm'], thumbnail_max_mb: 2 } });
    assert.equal(ok.status, 200);
    const cfg = await client().get('/api/config');
    assert.equal(cfg.body.upload.short_max_seconds, 45);
    assert.deepEqual(cfg.body.upload.allowed_formats, ['mp4', 'webm']);
    assert.equal((await admin.client.put('/api/admin/settings/not_a_real_setting', { value: {} })).status, 404);
  });

  test('the public config never exposes internal data', async () => {
    const cfg = await client().get('/api/config');
    const json = JSON.stringify(cfg.body);
    for (const leak of ['password', 'secret', 'token_hash', 'DATABASE_URL', 'require_video_moderation']) {
      assert.equal(json.includes(leak), false, `config leaks ${leak}`);
    }
  });
});
