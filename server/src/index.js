import fs from 'node:fs';
import { config } from './config.js';
import { initDb, db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startWorker, stopWorker } from './services/processing.js';

fs.mkdirSync(config.storage.tmpDir, { recursive: true });
await initDb();
await migrate({ quiet: true });
const { ensureDefaultCategories } = await import('./services/bootstrap.js');
await ensureDefaultCategories();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Privat Stream running on ${config.baseUrl}  (db: ${db.driver}, storage: ${config.storage.driver}, env: ${config.env})`);
  const hasAdmin = null;
  void hasAdmin;
});
if (config.worker.inline) startWorker();

const shutdown = async () => {
  stopWorker();
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
