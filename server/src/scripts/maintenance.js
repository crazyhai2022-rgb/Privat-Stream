// Run the earnings/analytics upkeep once, then exit.
//
// For hosts where the web app is stopped when idle (cPanel/Passenger). Set RUN_MAINTENANCE=false on the
// web app and run this from cron, once an hour is plenty:
//
//   0 * * * * cd ~/viralx/server && /home/USER/nodevenv/viralx/server/22/bin/node src/scripts/maintenance.js >> ~/logs/viralx-maintenance.log 2>&1
//
// Safe to overlap: every step is idempotent.
import { initDb, db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { runMaintenance } from '../services/maintenance.js';

try {
  await initDb();
  await migrate({ quiet: true });
  const out = await runMaintenance();
  console.log(`[${new Date().toISOString()}] maintenance ok`, JSON.stringify({ days: out.earnings.aggregated.length, approved: out.earnings.approved, purged: out.purged_visitor_rows }));
  await db.close();
  process.exit(0);
} catch (e) {
  console.error('maintenance failed:', e.message);
  process.exit(1);
}
