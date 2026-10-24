// Secure bootstrap for the first Super Admin. There is NO default admin account.
//
//   npm run create-admin -- --email you@example.com --name "Your Name"
//   (prompts for a password; or set ADMIN_PASSWORD; or pass --generate to print a one-time password)
//   --promote   promote an existing user instead of creating one
import readline from 'node:readline';
import crypto from 'node:crypto';
import { initDb, db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../lib/password.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput;
    rl._writeToOutput = function (s) { if (s.includes(question)) orig.call(rl, s); else if (s === '\r\n' || s === '\n') orig.call(rl, s); };
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

function strong(pw) {
  return pw.length >= 12 && /[a-z]/i.test(pw) && /[0-9]/.test(pw);
}

async function main() {
  const email = (opt('email') || '').trim().toLowerCase();
  const name = (opt('name') || 'Super Admin').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Provide --email you@example.com');
  await initDb();
  await migrate({ quiet: true });

  const existing = await db.one('select * from users where lower(email) = $1', [email]);
  if (existing) {
    if (!flag('promote')) throw new Error('That email already has an account. Re-run with --promote to make it a Super Admin.');
    await db.query(`update users set role = 'super_admin', email_verified_at = coalesce(email_verified_at, now()), account_status = 'active' where id = $1`, [existing.id]);
    await db.query(`insert into audit_logs (actor_id, action, target_type, target_id, metadata) values (null, 'admin.bootstrap_promote', 'user', $1, '{}'::jsonb)`, [existing.id]);
    console.log(`Promoted ${email} to Super Admin.`);
    return;
  }

  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (flag('generate')) { password = crypto.randomBytes(18).toString('base64url'); generated = true; }
  if (!password) {
    if (!process.stdin.isTTY) throw new Error('No TTY: set ADMIN_PASSWORD or use --generate');
    password = await promptHidden('Password (12+ characters, letters and numbers): ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) throw new Error('Passwords do not match');
  }
  if (!strong(password)) throw new Error('Password must be at least 12 characters and contain letters and numbers');

  const u = await db.one(
    `insert into users (email, full_name, password_hash, role, email_verified_at) values ($1,$2,$3,'super_admin', now()) returning id`,
    [email, name, await hashPassword(password)],
  );
  await db.query(`insert into audit_logs (actor_id, action, target_type, target_id, metadata) values (null, 'admin.bootstrap_create', 'user', $1, '{}'::jsonb)`, [u.id]);
  console.log(`Super Admin created: ${email}`);
  if (generated) console.log(`One-time password (change it after first login): ${password}`);
  console.log('Sign in at /admin');
}

main().then(() => db.close()).catch(async (e) => { console.error('Error:', e.message); try { await db.close(); } catch { /* ignore */ } process.exit(1); });
