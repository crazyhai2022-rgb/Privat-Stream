import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeUser, makeCreator, uploadVideo, publish, shutdown } from './helpers.js';

after(shutdown);

async function publishedVideo(opts = {}) {
  const c = await makeCreator();
  const id = await uploadVideo(c, { kind: 'short', ...opts });
  await publish(id);
  return { creator: c, id };
}

describe('engagement metrics stay separate', () => {
  test('hearts, dislikes, views, shares, comments and saves are counted independently', async () => {
    const { id } = await publishedVideo();
    const anon = client();
    const user = await makeUser();

    await anon.post(`/api/videos/${id}/react`, { type: 'heart' });
    await user.client.post(`/api/videos/${id}/react`, { type: 'dislike' });
    await anon.post(`/api/videos/${id}/view`);
    await user.client.post(`/api/videos/${id}/view`);
    await anon.post(`/api/videos/${id}/share`);
    await user.client.post(`/api/videos/${id}/comments`, { body: 'Nice one' });
    await user.client.put(`/api/videos/${id}/save`);

    const m = (await anon.get(`/api/videos/${id}`)).body.video.metrics;
    assert.deepEqual(
      { views: m.views, hearts: m.hearts, dislikes: m.dislikes, comments: m.comments, shares: m.shares, saves: m.saves },
      { views: 2, hearts: 1, dislikes: 1, comments: 1, shares: 1, saves: 1 },
      'each action increments only its own counter');

    const row = await db.one('select * from videos where public_id = $1', [id]);
    assert.equal(row.unique_views_count, 2);
    assert.equal(row.hearts_count, 1);
    assert.equal(row.dislikes_count, 1);
  });

  test('hearts and dislikes work without logging in, and one actor counts once', async () => {
    const { id } = await publishedVideo();
    const anon = client();
    let r = await anon.post(`/api/videos/${id}/react`, { type: 'heart' });
    assert.equal(r.status, 200);
    assert.equal(r.body.hearts, 1);
    // Same anonymous actor hearts again -> still one.
    r = await anon.post(`/api/videos/${id}/react`, { type: 'heart' });
    assert.equal(r.body.hearts, 1);
    // Switching to dislike moves the reaction rather than adding one.
    r = await anon.post(`/api/videos/${id}/react`, { type: 'dislike' });
    assert.equal(r.body.hearts, 0);
    assert.equal(r.body.dislikes, 1);
    // Clearing removes it.
    r = await anon.post(`/api/videos/${id}/react`, { type: null });
    assert.equal(r.body.dislikes, 0);
    assert.equal((await db.query('select * from reactions where video_id = (select id from videos where public_id = $1)', [id])).length, 0);
  });

  test('anonymous reactions are stored under a hashed identifier, never a raw id or IP', async () => {
    const { id } = await publishedVideo();
    const anon = client();
    await anon.post(`/api/videos/${id}/react`, { type: 'heart' });
    const row = await db.one(`select r.actor_key, r.ip_hash, r.user_id from reactions r join videos v on v.id = r.video_id where v.public_id = $1`, [id]);
    const cookie = anon.cookies.get('ps_aid');
    assert.ok(cookie);
    assert.equal(row.user_id, null);
    assert.ok(row.actor_key.startsWith('a:'));
    assert.ok(!row.actor_key.includes(cookie), 'the cookie value itself is not stored');
    assert.match(row.ip_hash, /^[a-f0-9]{32}$/);
  });

  test('views are de-duplicated per actor and a creator viewing their own video is not counted', async () => {
    const { creator, id } = await publishedVideo();
    const anon = client();
    assert.equal((await anon.post(`/api/videos/${id}/view`)).body.counted, true);
    assert.equal((await anon.post(`/api/videos/${id}/view`)).body.counted, false, 'repeat view within 30 minutes is ignored');
    assert.equal((await creator.client.post(`/api/videos/${id}/view`)).body.counted, false, 'own views do not count');
    assert.equal((await db.one('select views_count, unique_views_count from videos where public_id = $1', [id])).views_count, 1);
  });

  test('sharing works without login and returns the canonical URL', async () => {
    const { id } = await publishedVideo();
    const anon = client();
    const r = await anon.post(`/api/videos/${id}/share`);
    assert.equal(r.status, 200);
    assert.equal(r.body.counted, true);
    assert.match(r.body.url, new RegExp(`/shorts/${id}$`));
    assert.equal((await anon.post(`/api/videos/${id}/share`)).body.counted, false);
  });

  test('saving and commenting require a logged-in account', async () => {
    const { id } = await publishedVideo();
    const anon = client();
    assert.equal((await anon.put(`/api/videos/${id}/save`)).status, 401);
    assert.equal((await anon.post(`/api/videos/${id}/comments`, { body: 'hi' })).status, 401);

    const user = await makeUser();
    assert.equal((await user.client.put(`/api/videos/${id}/save`)).status, 200);
    assert.equal((await user.client.post(`/api/videos/${id}/comments`, { body: 'hi' })).status, 201);
  });

  test('commenting asks for a verified email only when the platform requires one', async () => {
    const { id } = await publishedVideo();
    const { setSetting } = await import('../src/services/settings.js');
    const base = { require_video_moderation: true, comments_enabled: true };
    const unverified = await makeUser({ verify: false });

    await setSetting('moderation', { ...base, require_email_verification: false });
    assert.equal((await unverified.client.post(`/api/videos/${id}/comments`, { body: 'hello' })).status, 201);

    await setSetting('moderation', { ...base, require_email_verification: true });
    const blocked = await unverified.client.post(`/api/videos/${id}/comments`, { body: 'again' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'email_unverified');

    await setSetting('moderation', { ...base, require_email_verification: false });
  });

  test('saved videos are persisted and can be removed', async () => {
    const { id } = await publishedVideo();
    const user = await makeUser();
    await user.client.put(`/api/videos/${id}/save`);
    let saved = await user.client.get('/api/me/saved');
    assert.equal(saved.body.items.length, 1);
    assert.equal(saved.body.items[0].id, id);
    // A different session of the same user still sees it (it is in the database, not the browser).
    const again = client();
    await again.post('/api/auth/login', { email: user.email, password: user.password });
    assert.equal((await again.get('/api/me/saved')).body.items.length, 1);

    await user.client.del(`/api/videos/${id}/save`);
    saved = await user.client.get('/api/me/saved');
    assert.equal(saved.body.items.length, 0);
    assert.equal((await db.one('select saves_count from videos where public_id = $1', [id])).saves_count, 0);
  });

  test('a heart is separate from a save', async () => {
    const { id } = await publishedVideo();
    const user = await makeUser();
    await user.client.post(`/api/videos/${id}/react`, { type: 'heart' });
    const v = (await user.client.get(`/api/videos/${id}`)).body.video;
    assert.equal(v.my_reaction, 'heart');
    assert.equal(v.saved, false, 'hearting does not save');
    assert.equal(v.metrics.saves, 0);
    assert.equal((await user.client.get('/api/me/saved')).body.items.length, 0);
  });

  test('comments are only returned when the panel asks for them, and authors can delete their own', async () => {
    const { id } = await publishedVideo();
    const user = await makeUser();
    const posted = await user.client.post(`/api/videos/${id}/comments`, { body: 'First!' });
    assert.equal(posted.status, 201);

    // The video payload carries only the count, never the comment bodies.
    const detail = (await client().get(`/api/videos/${id}`)).body;
    assert.equal(detail.video.metrics.comments, 1);
    assert.equal(JSON.stringify(detail).includes('First!'), false);

    const list = await client().get(`/api/videos/${id}/comments`);
    assert.equal(list.body.items[0].body, 'First!');

    const other = await makeUser();
    assert.equal((await other.client.del(`/api/comments/${posted.body.comment.id}`)).status, 404, 'cannot delete someone else\'s comment');
    assert.equal((await user.client.del(`/api/comments/${posted.body.comment.id}`)).status, 200);
    assert.equal((await db.one('select comments_count from videos where public_id = $1', [id])).comments_count, 0);
  });

  test('engagement endpoints reject unpublished or unknown videos', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' }); // pending moderation
    const anon = client();
    for (const call of [anon.post(`/api/videos/${id}/react`, { type: 'heart' }), anon.post(`/api/videos/${id}/view`), anon.post(`/api/videos/${id}/share`)]) {
      assert.equal((await call).status, 404);
    }
    assert.equal((await anon.post('/api/videos/doesnotexist/view')).status, 404);
  });

  test('reports are accepted once per user and surface to moderation', async () => {
    const { id } = await publishedVideo();
    const user = await makeUser();
    const first = await user.client.post(`/api/videos/${id}/report`, { reason: 'spam', details: 'Looks like a scam' });
    assert.equal(first.status, 201);
    const second = await user.client.post(`/api/videos/${id}/report`, { reason: 'spam' });
    assert.equal(second.body.duplicate, true);
    assert.equal((await db.one(`select count(*)::int as n from reports where status = 'open'`)).n >= 1, true);
  });
});

describe('listing and sorting', () => {
  test('sorts are independent and only published videos from approved channels are listed', async () => {
    const pending = await makeCreator();
    const hidden = await uploadVideo(pending, { kind: 'long', title: 'Hidden' });
    const { id: visible } = await (async () => {
      const c = await makeCreator();
      const vid = await uploadVideo(c, { kind: 'long', title: 'Visible' });
      await publish(vid);
      return { id: vid };
    })();
    const anon = client();
    for (const sort of ['trending', 'recent', 'views', 'hearts', 'dislikes', 'comments', 'shares', 'featured']) {
      const r = await anon.get(`/api/videos?kind=long&sort=${sort}`);
      assert.equal(r.status, 200, `sort=${sort}`);
      assert.ok(!r.body.items.some((v) => v.id === hidden), `sort=${sort} must not leak unpublished videos`);
    }
    const recent = await anon.get('/api/videos?kind=long&sort=recent');
    assert.ok(recent.body.items.some((v) => v.id === visible));

    // Suspending the channel hides published videos immediately.
    await db.query(`update channels set status = 'suspended' where id = (select channel_id from videos where public_id = $1)`, [visible]);
    const after = await anon.get('/api/videos?kind=long&sort=recent');
    assert.ok(!after.body.items.some((v) => v.id === visible));
  });

  test('the home feed alternates Shorts and long videos', async () => {
    const c = await makeCreator();
    for (let i = 0; i < 2; i++) await publish(await uploadVideo(c, { kind: 'short', title: `S${i}` }));
    await publish(await uploadVideo(c, { kind: 'long', title: 'L0' }));
    const r = await client().get('/api/feed/home?page=0');
    assert.ok(r.body.shorts.length >= 2);
    assert.ok(r.body.long.length >= 1);
    assert.ok(r.body.shorts.every((v) => v.kind === 'short'));
    assert.ok(r.body.long.every((v) => v.kind === 'long'));
  });
});
