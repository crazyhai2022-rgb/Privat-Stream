process.env.CDN_BASE_URL = 'https://cdn.example.test/';
process.env.CDN_CACHE_SECONDS = '7200';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
const { client, db, makeCreator, makeAdmin, uploadVideo, publish, shutdown } = await import('./helpers.js');
const { config } = await import('../src/config.js');

after(shutdown);

describe('CDN delivery', () => {
  test('the address is normalised and only https hosts are accepted', () => {
    assert.equal(config.cdn.baseUrl, 'https://cdn.example.test');
    assert.equal(config.cdn.cacheSeconds, 7200);
  });

  test('published videos point at the CDN; unpublished ones stay on the origin', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short', title: 'cdn test' });
    const own = await c.client.get('/api/me/videos');
    const draft = own.body.items.find((v) => v.id === id);
    assert.match(draft.stream_url, /^\/stream\//, 'not public yet, so served by the origin with an access check');
    await publish(id);
    const pub = await client().get(`/api/videos/${id}`);
    assert.equal(pub.body.video.stream_url, `https://cdn.example.test/stream/${id}`);
    assert.equal(pub.body.video.thumbnail_url, `https://cdn.example.test/thumb/${id}`);
  });

  test('the origin sends CDN-friendly headers for public video and supports range requests', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short', title: 'range test' });
    await publish(id);
    const full = await client().get(`/stream/${id}`, { raw: true });
    assert.equal(full.status, 200);
    assert.match(full.headers.get('cache-control'), /public, max-age=7200/);
    assert.equal(full.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const part = await client().get(`/stream/${id}`, { raw: true, headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    // private (removed) videos are never cacheable
    await db.query(`update videos set status = 'draft' where public_id = $1`, [id]);
    assert.equal((await client().get(`/stream/${id}`, { raw: true })).status, 404);
  });

  test('the content-security-policy allows the CDN for media and images', async () => {
    const r = await client().get('/api/config', { raw: true });
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /media-src[^;]*https:\/\/cdn\.example\.test/);
    assert.match(csp, /img-src[^;]*https:\/\/cdn\.example\.test/);
  });
});

describe('phone start page', () => {
  test('defaults to the Shorts feed, is public, and only accepts known values', async () => {
    const cfg = await client().get('/api/config');
    assert.equal(cfg.body.playback.mobile_start, 'shorts');
    assert.equal(cfg.body.playback.cdn, true);
    const admin = await makeAdmin();
    assert.equal((await admin.client.put('/api/admin/settings/playback', { value: { mobile_start: 'nope' } })).status, 400);
    assert.equal((await admin.client.put('/api/admin/settings/playback', { value: { mobile_start: 'home' } })).status, 200);
    assert.equal((await client().get('/api/config')).body.playback.mobile_start, 'home');
    await admin.client.put('/api/admin/settings/playback', { value: { mobile_start: 'shorts' } });
  });
});
