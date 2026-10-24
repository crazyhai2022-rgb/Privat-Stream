import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, db, makeUser, uniqueEmail, shutdown } from './helpers.js';

after(shutdown);

describe('registration, verification and login', () => {
  test('a user can register, verify their email, log in and log out', async () => {
    const c = client();
    const email = uniqueEmail();
    const password = 'Password12345';
    const reg = await c.post('/api/auth/register', { full_name: 'Jane Doe', email, password, password_confirm: password });
    assert.equal(reg.status, 201);

    // Registering does not log anyone in.
    assert.equal((await c.get('/api/auth/me')).body.user, null);

    const out = await c.get(`/api/dev/outbox?to=${encodeURIComponent(email)}`);
    const token = new URL(out.body.items[0].link).searchParams.get('token');
    assert.equal((await c.post('/api/auth/verify-email', { token })).status, 200);
    // A verification token cannot be replayed.
    assert.equal((await c.post('/api/auth/verify-email', { token })).status, 400);

    const login = await c.post('/api/auth/login', { email, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.email, email.toLowerCase());
    assert.equal(login.body.user.email_verified, true);
    assert.ok(login.body.csrf_token);

    assert.equal((await c.get('/api/auth/me')).body.user.email, email.toLowerCase());
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/auth/me')).body.user, null);
  });

  test('passwords are never stored in plaintext', async () => {
    const u = await makeUser();
    const row = await db.one('select password_hash from users where id = $1', [u.userId]);
    assert.ok(row.password_hash.startsWith('$argon2id$'));
    assert.ok(!row.password_hash.includes(u.password));
  });

  test('email addresses are unique and weak passwords are rejected', async () => {
    const c = client();
    const email = uniqueEmail();
    const password = 'Password12345';
    await c.post('/api/auth/register', { full_name: 'Alice A', email, password, password_confirm: password });
    const dup = await c.post('/api/auth/register', { full_name: 'Bob B', email: email.toUpperCase(), password, password_confirm: password });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'email_taken');

    const weak = await c.post('/api/auth/register', { full_name: 'Cara C', email: uniqueEmail(), password: 'short', password_confirm: 'short' });
    assert.equal(weak.status, 400);
    const noDigits = await c.post('/api/auth/register', { full_name: 'Cara C', email: uniqueEmail(), password: 'onlylettershere', password_confirm: 'onlylettershere' });
    assert.equal(noDigits.status, 400);
    const mismatch = await c.post('/api/auth/register', { full_name: 'Cara C', email: uniqueEmail(), password: 'Password12345', password_confirm: 'Password54321' });
    assert.equal(mismatch.status, 400);
  });

  test('wrong credentials fail and do not reveal whether the account exists', async () => {
    const u = await makeUser();
    const c = client();
    const bad = await c.post('/api/auth/login', { email: u.email, password: 'WrongPassword123' });
    const missing = await c.post('/api/auth/login', { email: uniqueEmail(), password: 'WrongPassword123' });
    assert.equal(bad.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(bad.body.error.message, missing.body.error.message);
  });

  test('repeated failures lock the account briefly', async () => {
    const u = await makeUser();
    const c = client();
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email: u.email, password: 'WrongPassword123' });
    const locked = await c.post('/api/auth/login', { email: u.email, password: u.password });
    assert.equal(locked.status, 429);
    await db.query('update users set locked_until = null, failed_logins = 0 where id = $1', [u.userId]);
    assert.equal((await c.post('/api/auth/login', { email: u.email, password: u.password })).status, 200);
  });

  test('password reset issues a single-use token and revokes sessions', async () => {
    const u = await makeUser();
    const c = u.client;
    assert.equal((await c.post('/api/auth/forgot-password', { email: u.email })).status, 200);
    const out = await c.get(`/api/dev/outbox?to=${encodeURIComponent(u.email)}`);
    const reset = out.body.items.find((i) => i.subject.includes('Reset'));
    const token = new URL(reset.link).searchParams.get('token');
    const newPass = 'BrandNewPass123';
    assert.equal((await c.post('/api/auth/reset-password', { token, password: newPass })).status, 200);
    assert.equal((await c.post('/api/auth/reset-password', { token, password: 'AnotherPass123' })).status, 400);

    // The old session was revoked by the reset.
    assert.equal((await c.get('/api/auth/me')).body.user, null);
    const fresh = client();
    assert.equal((await fresh.post('/api/auth/login', { email: u.email, password: u.password })).status, 401);
    assert.equal((await fresh.post('/api/auth/login', { email: u.email, password: newPass })).status, 200);
  });

  test('a suspended account cannot log in and its session stops working', async () => {
    const u = await makeUser();
    await db.query(`update users set account_status = 'suspended' where id = $1`, [u.userId]);
    await db.query('update sessions set revoked_at = now() where user_id = $1', [u.userId]);
    assert.equal((await u.client.get('/api/auth/me')).body.user, null);
    const c = client();
    const r = await c.post('/api/auth/login', { email: u.email, password: u.password });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'account_suspended');
  });

  test('state-changing requests need the CSRF token and a same-site origin', async () => {
    const u = await makeUser();
    const noToken = await u.client.post('/api/auth/profile', { full_name: 'X' }, { headers: { 'X-CSRF-Token': 'wrong-token' } });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error.code, 'csrf');

    const crossOrigin = await u.client.patch('/api/auth/profile', { full_name: 'X' }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.body.error.code, 'csrf_origin');

    assert.equal((await u.client.patch('/api/auth/profile', { full_name: 'New Name' })).status, 200);
  });

  test('protected routes reject anonymous callers', async () => {
    const anon = client();
    for (const [method, url] of [['get', '/api/me/saved'], ['get', '/api/me/videos'], ['post', '/api/videos'], ['get', '/api/me/channel/details']]) {
      const r = await anon[method](url, method === 'post' ? {} : undefined);
      assert.equal(r.status, 401, `${method} ${url} should be 401, got ${r.status}`);
    }
  });
});
