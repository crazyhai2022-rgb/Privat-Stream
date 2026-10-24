import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, db } from './index.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate({ quiet = false } = {}) {
  await initDb();
  await db.exec(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query('select name from schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.exec('begin;\n' + sql + '\ncommit;').catch(async (e) => {
      try { await db.exec('rollback;'); } catch { /* ignore */ }
      throw new Error(`Migration ${f} failed: ${e.message}`);
    });
    await db.query('insert into schema_migrations (name) values ($1)', [f]);
    applied++;
    if (!quiet) console.log(`applied ${f}`);
  }
  if (!quiet) console.log(applied ? `Migrations complete (${applied} applied).` : 'Database already up to date.');
  return applied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => db.close())
    .catch((e) => { console.error(e); process.exit(1); });
}
