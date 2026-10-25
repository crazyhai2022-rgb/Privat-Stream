import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, makeCreator, makeUser, uploadVideo, publish, shutdown } from './helpers.js';

after(shutdown);

describe('video visibility', () => {
  test('public, unlisted and private behave differently for lists, links and owners', async () => {
    const owner = await makeCreator();
    const id = await uploadVideo(owner, { title: 'Visibility clip' });
    await publish(id);
    const anon = client();
    const inFeed = async (c) => (await c.get(`/api/videos?channel=${owner.handle}`)).body.items?.some((v) => v.id === id);

    assert.equal((await owner.client.get('/api/me/videos')).body.items.find((v) => v.id === id).visibility, 'public');
    assert.equal(await inFeed(anon), true);

    // unlisted: gone from lists, still opens by link
    let r = await owner.client.patch(`/api/videos/${id}/visibility`, { visibility: 'unlisted' });
    assert.deepEqual([r.status, r.body.video.visibility], [200, 'unlisted']);
    assert.equal(await inFeed(anon), false);
    assert.equal((await anon.get(`/api/videos/${id}`)).status, 200);

    // private: nobody but the owner
    r = await owner.client.patch(`/api/videos/${id}/visibility`, { visibility: 'private' });
    assert.equal(r.body.video.visibility, 'private');
    assert.equal((await anon.get(`/api/videos/${id}`)).status, 404);
    const fan = await makeUser();
    assert.equal((await fan.client.get(`/api/videos/${id}`)).status, 404);
    assert.equal((await owner.client.get(`/api/videos/${id}`)).status, 200);
    assert.equal(await inFeed(anon), false);

    // back to published
    await owner.client.patch(`/api/videos/${id}/visibility`, { visibility: 'public' });
    assert.equal(await inFeed(anon), true);
  });

  test('only the owner can change it, and only to a known value', async () => {
    const owner = await makeCreator();
    const id = await uploadVideo(owner);
    await publish(id);
    const other = await makeCreator();
    assert.notEqual((await other.client.patch(`/api/videos/${id}/visibility`, { visibility: 'private' })).status, 200);
    assert.equal((await client().patch(`/api/videos/${id}/visibility`, { visibility: 'private' })).status, 401);
    assert.equal((await owner.client.patch(`/api/videos/${id}/visibility`, { visibility: 'secret' })).status, 400);
  });
});
