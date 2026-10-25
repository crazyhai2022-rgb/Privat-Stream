// Background upkeep: build recent earnings from view events, approve entries whose review window has
// passed, and trim old analytics. It never builds or pays a payout batch: that stays a deliberate
// administrator action. Everything here is idempotent, so overlapping runs are harmless.
import { config } from '../config.js';
import { runEarningsMaintenance } from './earnings.js';
import { purgeOldVisitors } from './visitors.js';

export async function runMaintenance() {
  const earnings = await runEarningsMaintenance({ days: 7 });
  const purged = await purgeOldVisitors();
  return { earnings, purged_visitor_rows: purged };
}

let timer = null;
let running = false;
let lastRun = 0;

async function tick() {
  if (running) return;
  running = true;
  lastRun = Date.now();
  try { await runMaintenance(); } catch (e) { console.error('[maintenance]', e.message); } finally { running = false; }
}

/**
 * Hosts like cPanel put an idle app to sleep and cannot run a cron job beside the embedded database,
 * so a timer alone would rarely fire. Calling this on API traffic makes sure the upkeep still happens
 * within the configured interval whenever the site is in use.
 */
export function maybeRunMaintenance() {
  if (!config.maintenance.inline || running) return;
  if (Date.now() - lastRun < config.maintenance.everyMinutes * 60_000) return;
  tick();
}

export function startMaintenance() {
  if (!config.maintenance.inline || timer) return;
  setTimeout(tick, 30_000).unref?.();                       // soon after boot, once the app has settled
  timer = setInterval(tick, config.maintenance.everyMinutes * 60_000);
  timer.unref?.();
}
export function stopMaintenance() { if (timer) clearInterval(timer); timer = null; }
