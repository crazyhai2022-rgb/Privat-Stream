import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { base, client, db, makeUser, makeCreator, makeAdmin, uploadVideo, publish, makeVideoFile, shutdown } from './helpers.js';

after(shutdown);

describe('injection and object-reference safety', () => {
  test('search input with SQL metacharacters is parameterised, not executed', async () => {
    const c = await makeCreator();
    await publish(await uploadVideo(c, { kind: 'long', title: 'Safe title' }));
    const anon = client();
    for (const q of ["'; drop table videos; --", "100%' or '1'='1", '\\', '%_%']) {
      const r = await anon.get(`/api/videos?kind=long&q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, q);
    }
    assert.ok((await db.one('select count(*)::int as n from videos')).n > 0, 'tables are intact');
  });

  test('one user cannot read or change another user\'s objects (IDOR)', async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    const idA = await uploadVideo(a, { kind: 'short' });
    const chA = await db.one('select id from channels where user_id = $1', [a.userId]);

    assert.equal((await b.client.patch(`/api/videos/${idA}`, { title: 'hijack' })).status, 404);
    assert.equal((await b.client.post(`/api/videos/${idA}/retry`, {})).status, 404);
    // Channel updates always act on the caller's own channel, never an id from the body.
    await b.client.patch('/api/me/channel', { name: 'Renamed', id: chA.id, user_id: a.userId });
    assert.notEqual((await db.one('select name from channels where id = $1', [chA.id])).name, 'Renamed');

    const user = await makeUser();
    const saved = await user.client.get('/api/me/saved');
    assert.deepEqual(saved.body.items, []);
  });

  test('a creator cannot escalate their own role or channel status through the API', async () => {
    const c = await makeCreator({ approve: false });
    await c.client.patch('/api/me/channel', { status: 'approved', bio: 'x' });
    assert.equal((await db.one('select status from channels where user_id = $1', [c.userId])).status, 'pending');
    await c.client.patch('/api/auth/profile', { full_name: 'Name', role: 'super_admin', account_status: 'active', email_verified_at: new Date().toISOString() });
    assert.equal((await db.one('select role from users where id = $1', [c.userId])).role, 'user');
  });

  test('unpublished media is not served to the public', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'short' });   // pending moderation
    const anon = client();
    assert.equal((await anon.get(`/stream/${id}`, { raw: true })).status, 404);
    assert.equal((await anon.get(`/thumb/${id}`, { raw: true })).status, 404);
    // The owner may preview it.
    assert.equal((await c.client.get(`/stream/${id}`, { raw: true })).status, 200);
    await publish(id);
    assert.equal((await anon.get(`/stream/${id}`, { raw: true })).status, 200);
  });

  test('media keys cannot be traversed to read arbitrary files', async () => {
    // fetch() normalises ".." away, so the raw paths are sent over a socket.
    const port = Number(new URL(base).port);
    const rawGet = (p) => new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
      let out = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => { out += d; });
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });
    for (const p of ['/media/img/../../../../etc/passwd', '/media/img/avatars/../../package.json', '/media/img/avatars/%2e%2e%2fsecret.jpg',
      '/media/img/avatars/....//....//package.json', '/stream/../package.json']) {
      const res = await rawGet(p);
      assert.ok(!res.includes('root:x:'), `${p} leaked /etc/passwd`);
      assert.ok(!res.includes('"viralx-server"'), `${p} leaked package.json`);
      assert.ok(!res.includes('argon2'), `${p} leaked a server file`);
    }
  });

  test('stored content is returned as data, never executed as HTML', async () => {
    const c = await makeCreator();
    const payload = '<img src=x onerror=alert(1)>';
    const create = await c.client.post('/api/videos', { kind: 'short', title: payload, description: payload });
    const id = create.body.video.id;
    const got = await c.client.get(`/api/videos/${id}`);
    assert.equal(got.body.video.title, payload, 'stored verbatim as text');
    const res = await c.client.get(`/api/videos/${id}`, { raw: true });
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('security headers and a strict CSP are sent with the app shell', async () => {
    const res = await fetch(base + '/');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'no inline scripts allowed');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  test('session cookies are HttpOnly and SameSite', async () => {
    const c = client();
    const u = await makeUser();
    const res = await c.req('POST', '/api/auth/login', { email: u.email, password: u.password }, { raw: true });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((x) => x.startsWith('ps_session='));
    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    const admin = await makeAdmin();
    const ares = await admin.client.req('POST', '/api/admin/auth/login', { email: admin.email, password: admin.password }, { raw: true });
    assert.match(ares.headers.getSetCookie().find((x) => x.startsWith('ps_admin=')), /SameSite=Strict/i);
  });

  test('oversized and unexpected uploads are rejected', async () => {
    const c = await makeCreator();
    const id = (await c.client.post('/api/videos', { kind: 'short', title: 'Limits' })).body.video.id;
    const fd = new FormData();
    fd.append('surprise', new Blob([fs.readFileSync(await makeVideoFile())], { type: 'video/mp4' }), 'c.mp4');
    const r = await c.client.post(`/api/videos/${id}/upload`, fd);
    assert.equal(r.status, 400);

    const big = await c.client.post('/api/videos', { kind: 'short', title: 'x'.repeat(500) });
    assert.equal(big.status, 400, 'over-long titles are rejected');
  });

  test('malformed JSON and unknown routes return clean errors', async () => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'bad_json');
    const nf = await client().get('/api/nope');
    assert.equal(nf.status, 404);
  });
});

describe('the development email outbox is not a public endpoint', () => {
  test('it answers local requests only, and never leaks links to a proxied caller', async () => {
    // helpers.js enables it explicitly and the test client connects over loopback.
    const local = await client().get('/api/dev/outbox');
    assert.equal(local.status, 200, 'available to a direct local request during development');

    const { config } = await import('../src/config.js');
    assert.equal(config.exposeOutbox, true, 'only because the test harness switched it on');

    // Behind a proxy every caller looks local, so the endpoint refuses to answer at all.
    const original = config.trustProxy;
    config.trustProxy = true;
    try {
      const proxied = await client().get('/api/dev/outbox');
      assert.equal(proxied.status, 404, 'treated as not found when the app sits behind a proxy');
    } finally {
      config.trustProxy = original;
    }
  });

  test('it is off unless explicitly enabled', async () => {
    // The default is false in every mode; production additionally refuses to start with it on.
    const src = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../src/config.js', import.meta.url), 'utf8'));
    assert.match(src, /exposeOutbox: bool\(env\.EXPOSE_EMAIL_OUTBOX, false\)/);
    assert.match(src, /EXPOSE_EMAIL_OUTBOX must be false in production/);
  });
});
