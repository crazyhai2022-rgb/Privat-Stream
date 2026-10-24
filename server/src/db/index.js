import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// A tiny adapter so the rest of the app uses one API for both drivers:
//   db.query(sql, params) -> rows[]
//   db.tx(async (q) => { await q(sql, params) ... })
let impl = null;

async function initPg() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  return {
    driver: 'pg',
    async query(sql, params = []) {
      const r = await pool.query(sql, params);
      return r.rows;
    },
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q = async (sql, params = []) => (await client.query(sql, params)).rows;
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

// PGlite is an embedded database: exactly one process may open a data directory.
// This lock turns the resulting silent "my writes are invisible" confusion into a clear error.
function pgliteLock(dataDir) {
  const file = path.join(dataDir, '.process.lock');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { pid, role } = JSON.parse(raw);
    if (pid !== process.pid) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) {
        throw new Error(
          `The embedded database at ${dataDir} is already open by ${role || 'another process'} (pid ${pid}).\n` +
          'PGlite allows one process at a time. Stop the server and run this command again,\n' +
          'or set DATABASE_URL to a PostgreSQL server so several processes can connect.');
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  const role = process.env.PS_ROLE || (process.argv[1] || '').split('/').pop() || 'process';
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, role, at: new Date().toISOString() }));
  const release = () => { try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* ignore */ } };
  process.once('exit', release);
  return release;
}

async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  let dataDir = config.pgliteDir;
  let release = () => {};
  if (dataDir === 'memory://') {
    // in-memory (tests)
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    release = pgliteLock(dataDir);
  }
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  return {
    driver: 'pglite',
    async query(sql, params = []) {
      const r = await pg.query(sql, params);
      return r.rows;
    },
    async exec(sql) { await pg.exec(sql); },
    async tx(fn) {
      return pg.transaction(async (t) => fn(async (sql, params = []) => (await t.query(sql, params)).rows));
    },
    async close() { await pg.close(); release(); },
  };
}

export async function initDb() {
  if (impl) return impl;
  if (config.databaseUrl) impl = await initPg();
  else {
    if (config.isProd && !config.allowEmbeddedDb) {
      throw new Error('DATABASE_URL is required in production (or set ALLOW_EMBEDDED_DB=true to use the embedded database)');
    }
    impl = await initPglite();
  }
  return impl;
}

export const db = {
  get driver() { return impl?.driver; },
  query: (sql, params) => impl.query(sql, params),
  one: async (sql, params) => (await impl.query(sql, params))[0] || null,
  exec: (sql) => impl.exec(sql),
  tx: (fn) => impl.tx(fn),
  close: async () => { if (impl) { await impl.close(); impl = null; } },
};
