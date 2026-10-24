import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { client, db, makeUser, makeCreator, makeAdmin, makeVideoFile, uploadVideo, drainJobs, shutdown } from './helpers.js';

after(shutdown);

describe('creator approval gates uploading', () => {
  test('a brand-new user cannot upload before approval, even by calling the API directly', async () => {
    const u = await makeUser();
    // No channel yet.
    let r = await u.client.post('/api/videos', { kind: 'short', title: 'Sneaky upload' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'no_channel');

    await u.client.post('/api/me/channel', { name: 'Pending Channel', handle: 'pending_one', bio: '', category_ids: [] });
    const me = await u.client.get('/api/auth/me');
    assert.equal(me.body.channel.status, 'pending');
    assert.equal(me.body.can_upload, false);

    r = await u.client.post('/api/videos', { kind: 'short', title: 'Sneaky upload' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'creator_pending');

    // Even a video row inserted directly cannot be uploaded to.
    const ch = await db.one('select id from channels where user_id = $1', [u.userId]);
    await db.query(`insert into videos (public_id, channel_id, kind, title, status) values ('forcedid123', $1, 'short', 'Forced', 'draft')`, [ch.id]);
    const fd = new FormData();
    fd.append('video', new Blob([fs.readFileSync(await makeVideoFile())], { type: 'video/mp4' }), 'c.mp4');
    const up = await u.client.post('/api/videos/forcedid123/upload', fd);
    assert.equal(up.status, 403);
  });

  test('an unverified user cannot create a channel', async () => {
    const u = await makeUser({ verify: false });
    const r = await u.client.post('/api/me/channel', { name: 'Nope', handle: 'unverified_x', bio: '', category_ids: [] });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'email_unverified');
  });

  test('rejected and suspended creators cannot upload; a rejected creator can resubmit', async () => {
    const c = await makeCreator({ approve: false });
    const admin = await makeAdmin();
    assert.equal((await admin.client.post(`/api/admin/channels/${c.channelId}/reject`, { reason: 'Not enough detail' })).status, 200);

    let r = await c.client.post('/api/videos', { kind: 'short', title: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'creator_rejected');

    const resubmit = await c.client.patch('/api/me/channel', { bio: 'More detail about my channel', resubmit: true });
    assert.equal(resubmit.body.channel.status, 'pending');

    await admin.client.post(`/api/admin/channels/${c.channelId}/approve`, {});
    assert.equal((await c.client.post('/api/videos', { kind: 'short', title: 'Allowed now' })).status, 201);

    await admin.client.post(`/api/admin/channels/${c.channelId}/suspend`, { reason: 'Policy breach', confirm: true });
    r = await c.client.post('/api/videos', { kind: 'short', title: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'creator_suspended');
  });

  test('handles are unique, reserved words are blocked and the format is enforced', async () => {
    const a = await makeCreator({ handle: 'takenhandle' });
    const b = await makeUser();
    let r = await b.client.post('/api/me/channel', { name: 'Copy', handle: 'TakenHandle', bio: '', category_ids: [] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'handle_taken');
    r = await b.client.post('/api/me/channel', { name: 'Admin', handle: 'admin', bio: '', category_ids: [] });
    assert.equal(r.status, 400);
    r = await b.client.post('/api/me/channel', { name: 'Bad', handle: 'has spaces!', bio: '', category_ids: [] });
    assert.equal(r.status, 400);
    void a;
  });

  test('a pending channel is hidden from the public but visible to its owner', async () => {
    const c = await makeCreator({ approve: false, handle: 'hiddenchan' });
    const anon = client();
    assert.equal((await anon.get('/api/channels/hiddenchan')).status, 404);
    const own = await c.client.get('/api/channels/hiddenchan');
    assert.equal(own.status, 200);
    assert.equal(own.body.is_owner, true);
  });
});

describe('upload, processing and moderation', () => {
  test('an approved creator can upload a Short; it is processed and waits for moderation', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short', title: 'My first Short' });
    const row = await db.one('select * from videos where public_id = $1', [id]);
    assert.equal(row.status, 'pending_moderation');
    assert.ok(row.original_key, 'the original file is stored outside the database');
    assert.ok(row.thumbnail_key, 'a thumbnail was generated');
    assert.ok(Number(row.duration_seconds) > 0, 'duration was probed');
    assert.equal(row.width, 180);
    assert.equal(row.height, 320);
    assert.ok(!('video_data' in row), 'no binary column exists on videos');

    // Not public until approved.
    const anon = client();
    assert.equal((await anon.get(`/api/videos/${id}`)).status, 404);
    const list = await anon.get('/api/videos?kind=short');
    assert.ok(!list.body.items.some((v) => v.id === id));

    // The creator can preview it.
    assert.equal((await c.client.get(`/api/videos/${id}`)).status, 200);
  });

  test('metadata persists and survives a fresh request', async () => {
    const c = await makeCreator();
    const cat = await db.one('select id, slug from categories limit 1');
    const id = await uploadVideo(c, { kind: 'long', title: 'Persisted title', categoryId: cat.id });
    const fresh = client();
    await db.query(`update videos set status = 'published', published_at = now() where public_id = $1`, [id]);
    const got = await fresh.get(`/api/videos/${id}`);
    assert.equal(got.body.video.title, 'Persisted title');
    assert.equal(got.body.video.category.slug, cat.slug);
    assert.deepEqual(got.body.video.tags, ['test']);
  });

  test('files that are not videos, or exceed the limits, are rejected server-side', async () => {
    const c = await makeCreator();
    const create = await c.client.post('/api/videos', { kind: 'short', title: 'Bad file' });
    const id = create.body.video.id;
    const fd = new FormData();
    fd.append('video', new Blob([Buffer.from('#!/bin/sh\necho hacked')], { type: 'video/mp4' }), 'evil.mp4');
    const r = await c.client.post(`/api/videos/${id}/upload`, fd);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /not a supported video/i);
    assert.equal((await db.one('select status from videos where public_id = $1', [id])).status, 'draft');

    // Too long for a Short once the duration limit is lowered.
    await db.query(`insert into settings (key, value) values ('upload', '{"short_max_seconds":1}'::jsonb)
                    on conflict (key) do update set value = settings.value || '{"short_max_seconds":1}'::jsonb`);
    const { invalidateSettings } = await import('../src/services/settings.js');
    invalidateSettings();
    const id2 = (await c.client.post('/api/videos', { kind: 'short', title: 'Too long' })).body.video.id;
    const fd2 = new FormData();
    fd2.append('video', new Blob([fs.readFileSync(await makeVideoFile({ seconds: 3 }))], { type: 'video/mp4' }), 'long.mp4');
    assert.equal((await c.client.post(`/api/videos/${id2}/upload`, fd2)).status, 202);
    await drainJobs();
    const row = await db.one('select status, error_message from videos where public_id = $1', [id2]);
    assert.equal(row.status, 'draft');
    assert.match(row.error_message, /limit is 1s/);
    await db.query(`delete from settings where key = 'upload'`);
    invalidateSettings();
  });

  test('a creator cannot publish their own video or touch another creator\'s video', async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    const id = await uploadVideo(a, { kind: 'short' });

    // No endpoint accepts a status from the client.
    const patched = await a.client.patch(`/api/videos/${id}`, { title: 'New title', status: 'published' });
    assert.equal(patched.status, 200);
    assert.equal((await db.one('select status from videos where public_id = $1', [id])).status, 'pending_moderation');

    // Another creator cannot see or change it.
    assert.equal((await b.client.patch(`/api/videos/${id}`, { title: 'Stolen' })).status, 404);
    assert.equal((await b.client.del(`/api/videos/${id}`)).status, 404);
    assert.equal((await b.client.get(`/api/videos/${id}/status`)).status, 404);
  });

  test('when moderation is turned off, processed videos publish automatically', async () => {
    const { invalidateSettings } = await import('../src/services/settings.js');
    await db.query(`insert into settings (key, value) values ('moderation', '{"require_video_moderation":false}'::jsonb)
                    on conflict (key) do update set value = settings.value || '{"require_video_moderation":false}'::jsonb`);
    invalidateSettings();
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short', title: 'Auto published' });
    assert.equal((await db.one('select status from videos where public_id = $1', [id])).status, 'published');
    await db.query(`delete from settings where key = 'moderation'`);
    invalidateSettings();
  });
});
