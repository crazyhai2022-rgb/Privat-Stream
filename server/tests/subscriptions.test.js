import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeUser, makeCreator, shutdown } from './helpers.js';

after(shutdown);

describe('subscriptions', () => {
  test('requires login, rejects unknown/unapproved channels and your own channel', async () => {
    const owner = await makeCreator();
    const anon = client();
    assert.equal((await anon.post(`/api/channels/${owner.handle}/subscribe`)).status, 401);

    const fan = await makeUser();
    assert.equal((await fan.client.post('/api/channels/nobody_here/subscribe')).status, 404);
    const pending = await makeCreator({ approve: false });
    assert.equal((await fan.client.post(`/api/channels/${pending.handle}/subscribe`)).status, 404);
    assert.equal((await owner.client.post(`/api/channels/${owner.handle}/subscribe`)).status, 400);
  });

  test('subscribe and unsubscribe are idempotent and the count is real', async () => {
    const owner = await makeCreator();
    const a = await makeUser(), b = await makeUser();
    let r = await a.client.post(`/api/channels/${owner.handle}/subscribe`);
    assert.deepEqual([r.status, r.body.subscribed, r.body.subscribers], [200, true, 1]);
    r = await a.client.post(`/api/channels/${owner.handle}/subscribe`);   // duplicate request
    assert.deepEqual([r.body.subscribed, r.body.subscribers], [true, 1]);
    r = await Promise.all([1, 2, 3].map(() => b.client.post(`/api/channels/${owner.handle}/subscribe`)));
    assert.ok(r.every((x) => x.status === 200));
    assert.equal((await db.one('select count(*)::int as n from channel_subscriptions where channel_id = $1', [owner.channelId])).n, 2);

    const view = await a.client.get(`/api/channels/${owner.handle}`);
    assert.equal(view.body.channel.subscribers, 2);
    assert.equal(view.body.channel.subscribed, true);
    assert.equal((await client().get(`/api/channels/${owner.handle}`)).body.channel.subscribed, false);
    assert.equal((await client().get(`/api/channels/${owner.handle}/subscription`)).body.subscribers, 2);

    r = await a.client.del(`/api/channels/${owner.handle}/subscribe`);
    assert.deepEqual([r.body.subscribed, r.body.subscribers], [false, 1]);
    r = await a.client.del(`/api/channels/${owner.handle}/subscribe`);   // already unsubscribed
    assert.deepEqual([r.status, r.body.subscribers], [200, 1]);
  });
});
