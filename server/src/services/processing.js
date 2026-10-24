import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getStorage } from '../storage/index.js';
import { getSetting } from './settings.js';
import { hasFfmpeg, probe, makeThumbnail, transcode } from '../lib/media.js';
import { fileId } from '../lib/crypto.js';

class PermanentError extends Error {}

export async function enqueueProcessing(videoId) {
  await db.query(`insert into video_jobs (video_id, type, status) values ($1, 'process', 'queued')`, [videoId]);
  kick();
}

async function claimJob() {
  const rows = await db.query(
    `update video_jobs set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
      where id = (select id from video_jobs where status = 'queued' and run_after <= now()
                  order by created_at limit 1 for update skip locked)
      returning *`,
  );
  return rows[0] || null;
}

async function recoverStale() {
  await db.query(`update video_jobs set status = 'queued', locked_at = null, updated_at = now()
                   where status = 'running' and locked_at < now() - interval '30 minutes'`);
}

async function processVideo(job) {
  const video = await db.one('select * from videos where id = $1', [job.video_id]);
  if (!video || video.status !== 'processing') return; // removed or changed while queued
  const storage = await getStorage();
  const upload = await getSetting('upload');
  const mod = await getSetting('moderation');

  const work = path.join(config.storage.tmpDir, `job-${job.id}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const ext = path.extname(video.original_key) || '.mp4';
    const src = path.join(work, `original${ext}`);
    await storage.download(video.original_key, src);

    let info = { duration: null, width: null, height: null, hasAudio: true };
    const ff = await hasFfmpeg();
    if (ff) {
      try { info = await probe(src); } catch (e) { throw new PermanentError(`Could not read the video file: ${e.message}`); }
      const max = video.kind === 'short' ? upload.short_max_seconds : upload.long_max_seconds;
      if (!(info.duration > 0.5)) throw new PermanentError('The video appears to be empty or unreadable.');
      if (info.duration > max + 0.5) {
        throw new PermanentError(`This ${video.kind === 'short' ? 'Short' : 'long video'} is ${Math.round(info.duration)}s long; the limit is ${max}s.`);
      }
    } else if (config.requireFfmpeg) {
      throw new Error(
        'ffmpeg/ffprobe were not found. Install them, point FFMPEG_PATH and FFPROBE_PATH at a '
        + 'static build, or set REQUIRE_FFMPEG=false to accept uploads without processing.');
    }

    let thumbKey = video.thumbnail_key;
    if (ff && !video.custom_thumbnail) {
      const t = path.join(work, 'thumb.jpg');
      await makeThumbnail(src, t, { kind: video.kind, at: Math.min(1, (info.duration || 2) / 2) });
      thumbKey = `thumbs/${fileId()}.jpg`;
      await storage.put(thumbKey, t, 'image/jpeg');
    }

    let playbackKey = video.original_key;
    let mime = video.mime;
    if (!ff && !/^video\/(mp4|webm)$/.test(String(mime))) {
      // Nothing can re-encode it and browsers cannot play the original as-is.
      throw new PermanentError('This file needs converting before it can play, but video processing is unavailable on this server. Please upload an MP4.');
    }
    if (ff && config.worker.transcode) {
      const fmt = config.worker.playbackFormat;
      const out = path.join(work, `playback.${fmt}`);
      await transcode(src, out, { hasAudio: info.hasAudio, format: fmt });
      playbackKey = `playback/${fileId()}.${fmt}`;
      mime = fmt === 'webm' ? 'video/webm' : 'video/mp4';
      await storage.put(playbackKey, out, mime);
    }

    const channel = await db.one(
      `select c.status as channel_status, u.account_status from channels c join users u on u.id = c.user_id where c.id = $1`,
      [video.channel_id],
    );
    const autoPublish = !mod.require_video_moderation && channel?.channel_status === 'approved' && channel?.account_status === 'active';

    await db.query(
      `update videos set playback_key = $2, thumbnail_key = $3, mime = $4, duration_seconds = $5, width = $6, height = $7,
              status = $8, published_at = case when $8 = 'published' then now() else published_at end,
              error_message = null, updated_at = now()
        where id = $1 and status = 'processing'`,
      [video.id, playbackKey, thumbKey, mime, info.duration, info.width, info.height, autoPublish ? 'published' : 'pending_moderation'],
    );
    await db.query(`update video_jobs set status = 'done', updated_at = now(), last_error = null where id = $1`, [job.id]);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function failJob(job, err, permanent) {
  const exhausted = permanent || job.attempts >= config.worker.maxAttempts;
  if (exhausted) {
    await db.query(`update video_jobs set status = 'failed', last_error = $2, updated_at = now() where id = $1`, [job.id, String(err.message).slice(0, 500)]);
    // Back to Draft so the creator sees the reason and can retry or re-upload.
    await db.query(`update videos set status = 'draft', error_message = $2, updated_at = now() where id = $1 and status = 'processing'`,
      [job.video_id, permanent ? String(err.message).slice(0, 300) : 'Processing failed. Please retry or upload a different file.']);
  } else {
    await db.query(
      `update video_jobs set status = 'queued', last_error = $2, run_after = now() + make_interval(secs => $3::int), locked_at = null, updated_at = now() where id = $1`,
      [job.id, String(err.message).slice(0, 500), job.attempts * 20],
    );
  }
}

let running = false;
let timer = null;
let stopped = false;

export async function runPendingJobs() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = await claimJob();
      if (!job) break;
      try {
        await processVideo(job);
      } catch (e) {
        console.error(`[worker] job ${job.id} failed:`, e.message);
        await failJob(job, e, e instanceof PermanentError);
      }
    }
  } finally {
    running = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until every queued/running job has finished (used by the seed script and tests). */
export async function drainJobs() {
  for (;;) {
    await runPendingJobs();
    while (running) await sleep(100);
    const { n } = await db.one(`select count(*)::int as n from video_jobs where status in ('queued', 'running')`);
    if (!n) return;
    await sleep(250);
  }
}

function kick() {
  if (!config.worker.inline || stopped) return;
  setImmediate(() => runPendingJobs().catch((e) => console.error('[worker]', e)));
}

export function startWorker() {
  stopped = false;
  recoverStale().catch(() => {});
  timer = setInterval(() => runPendingJobs().catch((e) => console.error('[worker]', e)), config.worker.pollMs);
  timer.unref?.();
  kick();
}
export function stopWorker() { stopped = true; if (timer) clearInterval(timer); timer = null; }
