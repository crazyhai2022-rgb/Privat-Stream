import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const port = num(env.PORT, 4000);
const nodeEnv = env.NODE_ENV || 'development';

export const config = {
  env: nodeEnv,
  isProd: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port,
  // Hosts that inject their own public URL (Render, Railway) are picked up automatically,
  // so a first deploy works before BASE_URL is set by hand.
  baseUrl: (env.BASE_URL
    || env.RENDER_EXTERNAL_URL
    || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')
    || `http://localhost:${port}`).replace(/\/$/, ''),
  extraOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool(env.TRUST_PROXY, !!(env.RENDER || env.RAILWAY_PUBLIC_DOMAIN || env.FLY_APP_NAME)),

  // Database: DATABASE_URL (PostgreSQL) in production. Without it, development falls back to an
  // embedded PostgreSQL (PGlite) stored on disk, so `npm start` works with zero setup.
  databaseUrl: env.DATABASE_URL || '',
  pgliteDir: env.PGLITE_DIR || path.join(SERVER_ROOT, '.data', 'pglite'),
  dbSsl: bool(env.DATABASE_SSL, false),

  session: {
    userTtlDays: num(env.SESSION_TTL_DAYS, 30),
    adminTtlHours: num(env.ADMIN_SESSION_TTL_HOURS, 8),
    cookieSecure: bool(env.COOKIE_SECURE, nodeEnv === 'production'),
  },
  secret: env.APP_SECRET || '', // used to HMAC anonymous identifiers & IP hashes

  storage: {
    driver: env.STORAGE_DRIVER || 'local', // local | s3
    localDir: env.STORAGE_LOCAL_DIR || path.join(SERVER_ROOT, 'storage-data'),
    tmpDir: env.TMP_DIR || path.join(SERVER_ROOT, 'tmp'),
    s3: {
      bucket: env.S3_BUCKET || '',
      region: env.S3_REGION || 'auto',
      endpoint: env.S3_ENDPOINT || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
    },
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: num(env.SMTP_PORT, 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'viralX <no-reply@localhost>',
    secure: bool(env.SMTP_SECURE, false),
  },

  // ffmpeg/ffprobe locations. On shared hosting without root you can drop static builds in
  // your home directory and point these at them (see deploy/install-ffmpeg-static.sh).
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: env.FFPROBE_PATH || 'ffprobe',
  // Set to false only when ffmpeg genuinely cannot be installed. See docs/CPANEL.md for
  // exactly what stops working.
  requireFfmpeg: bool(env.REQUIRE_FFMPEG, true),

  worker: {
    inline: bool(env.RUN_WORKER, true), // run the processing worker inside the API process
    transcode: bool(env.TRANSCODE, true),
    playbackFormat: env.PLAYBACK_FORMAT === 'webm' ? 'webm' : 'mp4', // mp4 (H.264/AAC) is the broadest; webm (VP9/Opus) is for browsers without H.264
    pollMs: num(env.WORKER_POLL_MS, 1500),
    maxAttempts: num(env.WORKER_MAX_ATTEMPTS, 3),
  },

  rateLimitDisabled: bool(env.RATE_LIMIT_DISABLED, false),
  // Dev-only convenience: expose queued emails (verification / reset links) over an API.
  exposeOutbox: bool(env.EXPOSE_EMAIL_OUTBOX, nodeEnv !== 'production'),
};

if (config.isProd) {
  const problems = [];
  if (!config.secret || config.secret.length < 32) problems.push('APP_SECRET must be set (32+ random characters)');
  if (!config.databaseUrl) problems.push('DATABASE_URL must be set in production');
  if (config.exposeOutbox) problems.push('EXPOSE_EMAIL_OUTBOX must be false in production');
  if (problems.length) {
    console.error('Refusing to start in production:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
} else if (!config.secret) {
  // Stable per-machine dev secret so cookies survive restarts; never used in production.
  config.secret = 'dev-only-secret-change-me-dev-only-secret-change-me';
}
