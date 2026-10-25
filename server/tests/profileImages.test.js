import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, makeCreator, shutdown } from './helpers.js';
import { imageSize } from '../src/lib/media.js';
import { getStorage } from '../src/storage/index.js';
import { IMAGE_SPEC } from '../src/routes/channels.js';

after(shutdown);

function makeImage(w, h) {
  const f = path.join(process.env.TMP_DIR, `pi-${Math.random().toString(36).slice(2)}.jpg`);
  fs.mkdirSync(process.env.TMP_DIR, { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-frames:v', '1', f]);
  if (r.status !== 0) throw new Error('could not make test image');
  return f;
}
const form = (file) => { const fd = new FormData(); fd.append('image', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), 'x.jpg'); return fd; };
async function stored(key) {
  const st = await getStorage();
  const out = path.join(process.env.TMP_DIR, `dl-${Math.random().toString(36).slice(2)}.jpg`);
  await st.download(key, out);
  return imageSize(out);
}

describe('profile images', () => {
  test('the stored sizes are 400×400 and 2560×1440', () => {
    assert.deepEqual(IMAGE_SPEC, { avatar: { width: 400, height: 400 }, banner: { width: 2560, height: 1440 } });
  });

  test('any upload is normalised to the exact stored size', async () => {
    const c = await makeCreator();
    assert.equal((await c.client.post('/api/me/channel/avatar', form(makeImage(640, 480)))).status, 200);
    assert.equal((await c.client.post('/api/me/channel/banner', form(makeImage(1920, 1080)))).status, 200);
    const ch = await db.one('select avatar_key, banner_key from channels where id = $1', [c.channelId]);
    assert.deepEqual(await stored(ch.avatar_key), { width: 400, height: 400 });
    assert.deepEqual(await stored(ch.banner_key), { width: 2560, height: 1440 });
  });

  test('non-images are refused and anonymous users cannot upload', async () => {
    const c = await makeCreator();
    const txt = path.join(process.env.TMP_DIR, 'x.txt'); fs.writeFileSync(txt, 'not an image');
    assert.equal((await c.client.post('/api/me/channel/avatar', form(txt))).status, 400);
    const { client } = await import('./helpers.js');
    assert.equal((await client().post('/api/me/channel/avatar', form(makeImage(100, 100)))).status, 401);
  });
});
