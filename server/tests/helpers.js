// Shared test harness: boots the app on an ephemeral port against an isolated database.
process.env.NODE_ENV = 'test';
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123456';
process.env.RATE_LIMIT_DISABLED = '1';
process.env.TRANSCODE = '0';          // keep tests fast; the probe/thumbnail path still runs
process.env.RUN_WORKER = '0';         // tests drain the queue explicitly
process.env.EXPOSE_EMAIL_OUTBOX = '1';
process.env.PGLITE_DIR ||= 'memory://';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'));
process.env.STORAGE_LOCAL_DIR = path.join(tmpRoot, 'storage');
process.env.TMP_DIR = path.join(tmpRoot, 'tmp');

const { initDb, db } = await import('../src/db/index.js');
const { migrate } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const { ensureDefaultCategories } = await import('../src/services/bootstrap.js');
const { drainJobs } = await import('../src/services/processing.js');
const { hashPassword } = await import('../src/lib/password.js');

await initDb();
await migrate({ quiet: true });
await ensureDefaultCategories();
// Production default is auto-publish for approved creators; most tests exercise the review queue.
await db.query(`insert into settings (key, value) values ('moderation', '{"require_video_moderation": true}'::jsonb)
                on conflict (key) do update set value = settings.value || '{"require_video_moderation": true}'::jsonb`);

const server = createApp().listen(0);
server.keepAliveTimeout = 120000; // long DB-only tests must not leave the test client with a dead socket
await new Promise((r) => server.once('listening', r));
export const base = `http://127.0.0.1:${server.address().port}`;
process.env.BASE_URL = base;

export { db, drainJobs };
export async function shutdown() {
  server.close();
  await db.close().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

/** A browser-like client: keeps cookies and sends the CSRF token. */
export function client() {
  const jar = new Map();
  let csrf = null, adminCsrf = null;
  const c = {
    get cookies() { return jar; },
    setCsrf(v) { csrf = v; }, setAdminCsrf(v) { adminCsrf = v; },
    clearCookies() { jar.clear(); csrf = null; adminCsrf = null; },
    async req(method, url, body, { raw = false, headers = {} } = {}) {
      const h = { Accept: 'application/json', 'X-Requested-With': 'fetch', ...headers };
      const tok = url.startsWith('/api/admin') ? adminCsrf : csrf;
      if (tok && !('X-CSRF-Token' in h)) h['X-CSRF-Token'] = tok;
      if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
      for (const sc of res.headers.getSetCookie?.() || []) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i), value = pair.slice(i + 1);
        if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc)) jar.delete(name); else jar.set(name, value);
      }
      if (raw) return res;
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      if (data?.csrf_token) { if (url.startsWith('/api/admin')) adminCsrf = data.csrf_token; else csrf = data.csrf_token; }
      return { status: res.status, body: data, headers: res.headers };
    },
    get: (u, o) => c.req('GET', u, undefined, o),
    post: (u, b, o) => c.req('POST', u, b ?? {}, o),
    put: (u, b, o) => c.req('PUT', u, b ?? {}, o),
    patch: (u, b, o) => c.req('PATCH', u, b ?? {}, o),
    del: (u, b, o) => c.req('DELETE', u, b, o),
  };
  return c;
}

let n = 0;
export const uniqueEmail = (p = 'user') => `${p}${++n}.${Date.now()}@example.test`;

/** Register + verify + log in. Returns { client, email, password, userId }. */
export async function makeUser({ verify = true, name = 'Test User' } = {}) {
  const c = client();
  const email = uniqueEmail();
  const password = 'Password12345';
  await c.post('/api/auth/register', { full_name: name, email, password, password_confirm: password });
  const u = await db.one('select id from users where lower(email) = $1', [email.toLowerCase()]);
  if (verify) {
    const out = await c.get(`/api/dev/outbox?to=${encodeURIComponent(email)}`);
    const link = out.body.items[0].link;
    await c.post('/api/auth/verify-email', { token: new URL(link).searchParams.get('token') });
  }
  const login = await c.post('/api/auth/login', { email, password });
  return { client: c, email, password, userId: u.id, login };
}

/** A user with an approved channel. */
export async function makeCreator({ handle, approve = true } = {}) {
  const u = await makeUser();
  handle ||= `creator${Math.random().toString(36).slice(2, 8)}`;
  const r = await u.client.post('/api/me/channel', { name: `Channel ${handle}`, handle, bio: 'test', category_ids: [] });
  if (r.status !== 201) throw new Error('channel create failed: ' + JSON.stringify(r.body));
  const ch = await db.one('select * from channels where user_id = $1', [u.userId]);
  if (approve) await db.query(`update channels set status = 'approved', reviewed_at = now() where id = $1`, [ch.id]);
  return { ...u, handle, channelId: ch.id };
}

export async function makeAdmin({ role = 'super_admin' } = {}) {
  const email = uniqueEmail('admin');
  const password = 'AdminPassword12345';
  const u = await db.one(
    `insert into users (email, full_name, password_hash, role, email_verified_at) values ($1,'Admin',$2,$3, now()) returning id`,
    [email, await hashPassword(password), role]);
  const c = client();
  const r = await c.post('/api/admin/auth/login', { email, password });
  if (r.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(r.body));
  return { client: c, email, password, id: u.id };
}

/** Generate a tiny real video with ffmpeg so uploads exercise the real pipeline. */
export async function makeVideoFile({ kind = 'short', seconds = 2 } = {}) {
  const size = kind === 'short' ? '180x320' : '320x180';
  const file = path.join(process.env.TMP_DIR, `t-${Math.random().toString(36).slice(2)}.mp4`);
  fs.mkdirSync(process.env.TMP_DIR, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=12`, '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed'))));
    p.on('error', reject);
  });
  return file;
}

export async function uploadVideo(creator, { kind = 'short', title = 'Test video', seconds = 2, categoryId = null } = {}) {
  const create = await creator.client.post('/api/videos', { kind, title, description: 'desc', category_id: categoryId, tags: ['test'] });
  if (create.status !== 201) throw new Error('create failed: ' + JSON.stringify(create.body));
  const id = create.body.video.id;
  const file = await makeVideoFile({ kind, seconds });
  const fd = new FormData();
  fd.append('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), 'clip.mp4');
  const up = await creator.client.post(`/api/videos/${id}/upload`, fd);
  if (up.status !== 202) throw new Error('upload failed: ' + JSON.stringify(up.body));
  await drainJobs();
  return id;
}

export async function publish(videoId) {
  await db.query(`update videos set status = 'published', published_at = coalesce(published_at, now()) where public_id = $1`, [videoId]);
}
