// Development seed: demo creators + generated sample videos so the UI has real content.
// Uses ffmpeg test sources and the same processing pipeline as real uploads.
// Engagement rows are written as real events/reactions (actor keys prefixed "a:seed") and counters are recomputed from them.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { initDb, db } from './index.js';
import { migrate } from './migrate.js';
import { ensureDefaultCategories } from '../services/bootstrap.js';
import { hashPassword } from '../lib/password.js';
import { getStorage } from '../storage/index.js';
import { publicId, fileId } from '../lib/crypto.js';
import { enqueueProcessing, drainJobs } from '../services/processing.js';
import { recountVideo } from '../services/videos.js';
import { hasFfmpeg } from '../lib/media.js';

if (config.isProd) { console.error('Refusing to seed in production.'); process.exit(1); }

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-300)))));
});

const SOURCES = [
  (s) => `testsrc2=size=${s}:rate=24`,
  (s) => `mandelbrot=size=${s}:rate=24`,
  (s) => `gradients=size=${s}:rate=24:speed=0.03`,
  (s) => `life=size=${s}:rate=24:mold=10:life_color=#00ff88:death_color=#220044`,
  (s) => `cellauto=size=${s}:rate=24:rule=110`,
  (s) => `smptehdbars=size=${s}:rate=24`,
];
const SHORT_TITLES = ['Morning routine in 10 seconds', 'Quick desk setup tour', 'One-pan dinner idea', 'Cat vs. cardboard box', 'Sunset timelapse', 'Pocket-sized travel tips',
  'Three-note melody', 'Budget gadget test', 'Plant care in a minute', 'City walk at night', 'Trying a new coffee trick', 'Tiny workout, big effect'];
const LONG_TITLES = ['Complete beginner guide to home studio audio', 'A week of street photography: lessons learned', 'Build a small web app from scratch',
  'Weekend hiking vlog: ridge trail', 'How I plan my content calendar', 'Cooking a five-course dinner at home', 'Retro gaming collection tour', 'Understanding personal budgeting'];
const CREATORS = [
  ['Aarav Mehta', 'aarav@demo.local', 'aarav', 'Aarav Creates', 'Short stories, gadgets and everyday experiments.', 'tech'],
  ['Diya Sharma', 'diya@demo.local', 'diyacooks', 'Diya in the Kitchen', 'Simple recipes and kitchen hacks.', 'lifestyle'],
  ['Kabir Singh', 'kabir@demo.local', 'kabirplays', 'Kabir Plays', 'Gaming clips, retro finds and music.', 'gaming'],
];

async function main() {
  await initDb();
  await migrate({ quiet: true });
  await ensureDefaultCategories();
  if (!(await hasFfmpeg())) throw new Error('ffmpeg/ffprobe are required to seed sample videos');
  const existing = await db.one(`select count(*)::int as n from users where email like '%@demo.local'`);
  if (existing.n > 0) { console.log('Demo data already present. Nothing to do.'); return; }

  const storage = await getStorage();
  const cats = await db.query('select id, slug from categories');
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const password = crypto.randomBytes(9).toString('base64url') + '7';
  const hash = await hashPassword(password);

  const channels = [];
  for (const [name, email, handle, cname, bio, cat] of CREATORS) {
    const u = await db.one(`insert into users (email, full_name, password_hash, email_verified_at) values ($1,$2,$3, now()) returning id`, [email, name, hash]);
    const c = await db.one(`insert into channels (user_id, name, handle, bio, status, reviewed_at) values ($1,$2,$3,$4,'approved', now()) returning id`, [u.id, cname, handle, bio]);
    await db.query('insert into channel_categories (channel_id, category_id) values ($1,$2)', [c.id, catBySlug[cat]]);
    channels.push({ id: c.id });
  }

  const tmp = path.join(config.storage.tmpDir, 'seed');
  await fsp.mkdir(tmp, { recursive: true });
  const slugs = cats.map((c) => c.slug);
  const made = [];
  const plan = [
    ...SHORT_TITLES.map((t, i) => ({ kind: 'short', title: t, i })),
    ...LONG_TITLES.map((t, i) => ({ kind: 'long', title: t, i })),
  ];
  for (const [n, p] of plan.entries()) {
    const size = p.kind === 'short' ? '360x640' : '640x360';
    const dur = p.kind === 'short' ? 6 : 12;
    const file = path.join(tmp, `${p.kind}-${p.i}.mp4`);
    await run(['-f', 'lavfi', '-i', SOURCES[(p.i + (p.kind === 'long' ? 2 : 0)) % SOURCES.length](size), '-f', 'lavfi', '-i', `sine=frequency=${220 + p.i * 40}:sample_rate=44100`,
      '-t', String(dur), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file]);
    const key = `originals/${fileId()}.mp4`;
    await storage.put(key, file, 'video/mp4');
    const ch = channels[n % channels.length];
    const cat = catBySlug[slugs[(n + 1) % slugs.length]];
    const v = await db.one(
      `insert into videos (public_id, channel_id, kind, title, description, category_id, tags, status, original_key, mime, size_bytes)
       values ($1,$2,$3,$4,$5,$6,$7,'processing',$8,'video/mp4',$9) returning id`,
      [publicId(), ch.id, p.kind, p.title, p.kind === 'short' ? 'Sample caption for a demo Short.' : `Sample description for "${p.title}". This video was generated for development.`,
        cat, ['demo', p.kind], key, (await fsp.stat(file)).size]);
    await enqueueProcessing(v.id);
    made.push(v.id);
  }
  console.log('Processing sample videos...');
  await drainJobs();
  await fsp.rm(tmp, { recursive: true, force: true });

  // Publish with staggered dates, then generate real (seed-tagged) engagement rows.
  for (const [i, id] of made.entries()) {
    await db.query(`update videos set status = 'published', published_at = now() - make_interval(hours => $2::int) where id = $1 and status = 'pending_moderation'`, [id, i * 5 + 1]);
    const views = 3 + ((i * 7) % 23), hearts = (i * 3) % 9, dislikes = i % 3 === 0 ? 1 : 0;
    for (let k = 0; k < views; k++) await db.query(`insert into video_events (video_id, type, actor_key, created_at) values ($1,'view',$2, now() - make_interval(mins => $3::int))`, [id, `a:seed${i}-${k}`, (k * 37) % 2000]);
    for (let k = 0; k < hearts; k++) await db.query(`insert into reactions (video_id, actor_key, type) values ($1,$2,'heart')`, [id, `a:seedh${i}-${k}`]);
    for (let k = 0; k < dislikes; k++) await db.query(`insert into reactions (video_id, actor_key, type) values ($1,$2,'dislike')`, [id, `a:seedd${i}-${k}`]);
    await db.tx((q) => recountVideo(q, id));
  }
  const bad = await db.one(`select count(*)::int as n from videos where status <> 'published'`);
  console.log(`Seeded ${CREATORS.length} demo creators and ${made.length - bad.n} videos.`);
  console.log(`Demo creator logins (password for all): ${password}`);
  console.log(CREATORS.map((c) => `  ${c[1]}`).join('\n'));
  console.log('Create your admin with: npm run create-admin -- --email you@example.com --name "Your Name"');
}

main().then(() => db.close()).catch(async (e) => { console.error(e); try { await db.close(); } catch { /* ignore */ } process.exit(1); });
