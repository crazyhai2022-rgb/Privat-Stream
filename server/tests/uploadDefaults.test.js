import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, makeCreator, shutdown } from './helpers.js';

after(shutdown);

describe('upload defaults', () => {
  test('save, read back, validate, isolate per user and clear', async () => {
    const a = await makeCreator(), b = await makeCreator();
    assert.equal((await client().get('/api/me/upload-defaults')).status, 401);
    let r = await a.client.get('/api/me/upload-defaults');
    assert.deepEqual(r.body.defaults.short, { title: '', description: '', tags: [], category_id: null });
    r = await a.client.put('/api/me/upload-defaults', { short: { title: '{filename} #x', description: 'cap', tags: ['Fun', 'fun', 'viral'] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.defaults.short.tags, ['fun', 'viral']);
    assert.equal((await a.client.get('/api/me/upload-defaults')).body.defaults.short.title, '{filename} #x');
    assert.equal((await b.client.get('/api/me/upload-defaults')).body.defaults.short.title, '');
    assert.equal((await a.client.put('/api/me/upload-defaults', { short: { tags: ['bad!tag'] } })).status, 400);
    assert.equal((await a.client.put('/api/me/upload-defaults', { short: { title: 'x', evil: 1 } })).status, 400);
    assert.equal((await a.client.put('/api/me/upload-defaults', { long: { category_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
    r = await a.client.del('/api/me/upload-defaults');
    assert.equal(r.body.defaults.short.title, '');
  });
});
