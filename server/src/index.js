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

const { hasFfmpeg } = await import('./lib/media.js');
if (!(await hasFfmpeg())) {
  const how = `(looked for "${config.ffmpegPath}" and "${config.ffprobePath}")`;
  if (config.requireFfmpeg) {
    console.error(`ffmpeg/ffprobe not found ${how}.`);
    console.error('Uploads will fail until they are available. Install them, set FFMPEG_PATH and');
    console.error('FFPROBE_PATH to a static build, or set REQUIRE_FFMPEG=false to run without them.');
  } else {
    console.warn(`Running without ffmpeg ${how}: no thumbnails, no duration limit enforcement,`);
    console.warn('and only MP4/WebM uploads will play. See docs/CPANEL.md.');
  }
}

if (config.exposeOutbox) {
  console.warn('EXPOSE_EMAIL_OUTBOX is on: /api/dev/outbox serves verification and password-reset');
  console.warn('links to local requests. Use it only on your own machine, never on a live server.');
}
if (config.isProd && config.smtp.transport === 'log' && !config.smtp.host) {
  console.warn('MAIL_TRANSPORT=log: verification and reset links go to this log, not to inboxes.');
  console.warn('Configure SMTP_* before real users sign up.');
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`viralX running on ${config.baseUrl}  (db: ${db.driver}, storage: ${config.storage.driver}, env: ${config.env})`);
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
