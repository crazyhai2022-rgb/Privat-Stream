import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { client, db, makeCreator, makeVideoFile, uploadVideo, shutdown } from './helpers.js';
import { imageSize } from '../src/lib/media.js';

after(shutdown);

function makeImage(w, h, ext = 'jpg') {
  const f = path.join(process.env.TMP_DIR, `img-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.mkdirSync(process.env.TMP_DIR, { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-frames:v', '1', f]);
  if (r.status !== 0) throw new Error('could not make test image: ' + r.stderr);
  return f;
}
const form = (file, type, name = 'thumb') => { const fd = new FormData(); fd.append('thumbnail', new Blob([fs.readFileSync(file)], { type }), name); return fd; };
const meta = (id) => db.one('select thumbnail_key, custom_thumbnail from videos where public_id = $1', [id]);

describe('image headers', () => {
  test('size is read from JPEG, PNG and WebP headers', async () => {
    assert.deepEqual(await imageSize(makeImage(334, 556, 'jpg')), { width: 334, height: 556 });
    assert.deepEqual(await imageSize(makeImage(400, 300, 'png')), { width: 400, height: 300 });
    const webp = makeImage(322, 124, 'webp');
    assert.deepEqual(await imageSize(webp), { width: 322, height: 124 });
    const junk = path.join(process.env.TMP_DIR, 'junk.jpg'); fs.writeFileSync(junk, 'not an image at all, just text'.repeat(10));
    assert.equal(await imageSize(junk), null);
  });
});

describe('changing a thumbnail', () => {
  test('a valid custom image replaces the generated one, in 9:16 for Shorts and 16:9 for long videos', async () => {
    const c = await makeCreator();
    const shortId = await uploadVideo(c, { kind: 'short' });
    const before = await meta(shortId);
    assert.equal(before.custom_thumbnail, false);
    const r = await c.client.post(`/api/videos/${shortId}/thumbnail`, form(makeImage(540, 960), 'image/jpeg'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after1 = await meta(shortId);
    assert.equal(after1.custom_thumbnail, true);
    assert.notEqual(after1.thumbnail_key, before.thumbnail_key);

    const longId = await uploadVideo(c, { kind: 'long' });
    const l = await c.client.post(`/api/videos/${longId}/thumbnail`, form(makeImage(1280, 720, 'png'), 'image/png'));
    assert.equal(l.status, 200, JSON.stringify(l.body));
  });

  test('refuses non-images, disguised files, tiny images and anonymous or foreign callers', async () => {
    const c = await makeCreator(), other = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });
    const txt = path.join(process.env.TMP_DIR, 'x.jpg'); fs.writeFileSync(txt, 'hello '.repeat(100));
    let r = await c.client.post(`/api/videos/${id}/thumbnail`, form(txt, 'image/jpeg'));
    assert.equal(r.status, 400); assert.match(r.body.error.message, /JPEG, PNG or WebP/);
    const vid = await makeVideoFile({ kind: 'short' });
    r = await c.client.post(`/api/videos/${id}/thumbnail`, form(vid, 'image/jpeg'));
    assert.equal(r.status, 400, 'a video renamed as an image is refused');
    r = await c.client.post(`/api/videos/${id}/thumbnail`, form(makeImage(100, 100), 'image/jpeg'));
    assert.equal(r.status, 400); assert.match(r.body.error.message, /too small/);
    r = await other.client.post(`/api/videos/${id}/thumbnail`, form(makeImage(540, 960), 'image/jpeg'));
    assert.equal(r.status, 404, 'another creator cannot touch it');
    r = await client().post(`/api/videos/${id}/thumbnail`, form(makeImage(540, 960), 'image/jpeg'));
    assert.equal(r.status, 401);
    assert.equal((await meta(id)).custom_thumbnail, false, 'nothing changed');
  });

  test('oversized files are refused', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'long' });
    await db.query(`insert into settings (key, value) values ('upload', '{}'::jsonb) on conflict do nothing`);
    const { setSetting, getSetting } = await import('../src/services/settings.js');
    const cur = await getSetting('upload');
    await setSetting('upload', { ...cur, thumbnail_max_mb: 0.1 });
    const big = path.join(process.env.TMP_DIR, 'big.jpg');
    fs.writeFileSync(big, Buffer.concat([fs.readFileSync(makeImage(1280, 720)), Buffer.alloc(200 * 1024)]));
    const r = await c.client.post(`/api/videos/${id}/thumbnail`, form(big, 'image/jpeg'));
    assert.ok([400, 413].includes(r.status), `got ${r.status} ${JSON.stringify(r.body)}`);
    await setSetting('upload', cur);
  });

  test('a frame can be captured on the server at a chosen time', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'long', seconds: 3 });
    const r = await c.client.post(`/api/videos/${id}/thumbnail/frame`, { at: 1.5 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await meta(id)).custom_thumbnail, true);
    assert.equal((await c.client.post(`/api/videos/${id}/thumbnail/frame`, { at: -3 })).status, 400);
  });
});

describe('upload with a thumbnail attached', () => {
  test('the chosen thumbnail is kept and not overwritten by processing', async () => {
    const c = await makeCreator();
    const create = await c.client.post('/api/videos', { kind: 'short', title: 'With thumb', description: '', tags: [] });
    const id = create.body.video.id;
    const fd = new FormData();
    fd.append('video', new Blob([fs.readFileSync(await makeVideoFile({ kind: 'short' }))], { type: 'video/mp4' }), 'c.mp4');
    fd.append('thumbnail', new Blob([fs.readFileSync(makeImage(540, 960))], { type: 'image/jpeg' }), 't.jpg');
    const up = await c.client.post(`/api/videos/${id}/upload`, fd);
    assert.equal(up.status, 202, JSON.stringify(up.body));
    const { drainJobs } = await import('./helpers.js');
    await drainJobs();
    const m = await meta(id);
    assert.equal(m.custom_thumbnail, true);
    assert.match(m.thumbnail_key, /^thumbs\//);

    const bad = await c.client.post('/api/videos', { kind: 'short', title: 'Bad thumb', description: '', tags: [] });
    const fd2 = new FormData();
    fd2.append('video', new Blob([fs.readFileSync(await makeVideoFile({ kind: 'short' }))], { type: 'video/mp4' }), 'c.mp4');
    fd2.append('thumbnail', new Blob(['nope'.repeat(50)], { type: 'image/png' }), 't.png');
    const r2 = await c.client.post(`/api/videos/${bad.body.video.id}/upload`, fd2);
    assert.equal(r2.status, 400, 'a bad thumbnail is a clear error, not a silent drop');
    assert.equal((await db.one('select status from videos where public_id = $1', [bad.body.video.id])).status, 'draft');
  });
});
