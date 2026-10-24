// Drain the video processing queue once, then exit.
//
// For hosts where a background worker cannot stay running (cPanel/Passenger apps are
// stopped when idle). Run it from cron every minute with RUN_WORKER=false on the web app:
//
//   * * * * * cd ~/viralx/server && /home/USER/nodevenv/viralx/server/22/bin/node src/scripts/process-jobs.js >> ~/logs/viralx-worker.log 2>&1
//
// Safe to overlap: jobs are claimed with FOR UPDATE SKIP LOCKED, so two runs never
// process the same video.
import { initDb, db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { drainJobs } from '../services/processing.js';

const started = Date.now();
try {
  await initDb();
  await migrate({ quiet: true });
  const { n } = await db.one(`select count(*)::int as n from video_jobs where status in ('queued', 'running')`);
  if (n > 0) {
    await drainJobs();
    console.log(`[${new Date().toISOString()}] processed ${n} job(s) in ${Math.round((Date.now() - started) / 1000)}s`);
  }
  await db.close();
  process.exit(0);
} catch (e) {
  console.error(`[${new Date().toISOString()}] worker failed:`, e.message);
  try { await db.close(); } catch { /* ignore */ }
  process.exit(1);
}
