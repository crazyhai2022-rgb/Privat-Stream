// Server-side metadata for crawlers and link previews.
//
// The front-end is a single-page app, so the HTML shell is the same for every URL. This module fills the shell in per
// request: <title>, description, canonical URL, Open Graph / Twitter tags, robots directives and VideoObject JSON-LD.
// Only content that is publicly visible is described. Anything else (drafts, pending, rejected, removed, unapproved
// channels, suspended accounts, private tool pages) gets "noindex" and no details.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { config, REPO_ROOT } from '../config.js';

const SHELL = path.join(REPO_ROOT, 'web', 'index.html');
let shell = null;
const getShell = () => (shell && config.isProd ? shell : (shell = fs.readFileSync(SHELL, 'utf8')));

export const baseUrlFor = (req) => (config.baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s; };
const iso = (d) => (d ? new Date(d).toISOString() : undefined);
export function isoDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${r || (!h && !m) ? `${r}S` : ''}`;
}
const LS = new RegExp('[\\u2028\\u2029]', 'g');
// Escaping "<" keeps any markup inside titles from closing the script block.
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c').replace(LS, '')}</script>`;

const PRIVATE_PREFIXES = ['/studio', '/upload', '/research', '/settings', '/saved', '/login', '/register', '/verify-email', '/forgot-password', '/reset-password', '/channel/setup', '/search'];
const SECTION_TITLES = { '/shorts': 'Shorts', '/long': 'Long videos', '/categories': 'Categories' };

async function metaFor(req) {
  const base = baseUrlFor(req);
  const p = req.path.replace(/\/+$/, '') || '/';
  const site = 'viralX';
  const def = {
    title: site, description: 'viralX — short videos first, with long-form videos from independent creators.',
    canonical: `${base}${p === '/' ? '/' : p}`, image: `${base}/assets/viralx-logo.png`, type: 'website', robots: 'index,follow', extra: '', noscript: '',
  };

  if (PRIVATE_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`))) return { ...def, robots: 'noindex,nofollow', canonical: undefined };

  let m;
  if ((m = p.match(/^\/(watch|shorts)\/([A-Za-z0-9_-]{6,20})$/))) {
    const v = await db.one(
      `select v.public_id, v.kind, v.title, v.description, v.tags, v.duration_seconds, v.published_at, v.updated_at, v.views_count, v.thumbnail_key, v.playback_key,
              c.name as channel_name, c.handle as channel_handle
         from videos v join channels c on c.id = v.channel_id join users u on u.id = c.user_id
        where v.public_id = $1 and v.status = 'published' and c.status = 'approved' and u.account_status = 'active'`, [m[2]]);
    if (!v) return { ...def, title: `Video not available · ${site}`, robots: 'noindex,nofollow', canonical: undefined };
    const path = v.kind === 'short' ? `/shorts/${v.public_id}` : `/watch/${v.public_id}`;
    const url = `${base}${path}`;
    const desc = clip(v.description || `${v.title} — a ${v.kind === 'short' ? 'Short' : 'video'} by ${v.channel_name} on ${site}.`, 200);
    const image = v.thumbnail_key ? `${base}/thumb/${v.public_id}` : def.image;
    const ld = {
      '@context': 'https://schema.org', '@type': 'VideoObject', name: v.title, description: desc,
      ...(v.thumbnail_key ? { thumbnailUrl: [image] } : {}),
      uploadDate: iso(v.published_at), ...(v.duration_seconds ? { duration: isoDuration(v.duration_seconds) } : {}),
      ...(v.playback_key ? { contentUrl: `${base}/stream/${v.public_id}` } : {}),
      url, ...(v.tags?.length ? { keywords: v.tags.join(', ') } : {}),
      author: { '@type': 'Person', name: v.channel_name, url: `${base}/c/${v.channel_handle}` },
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'WatchAction' }, userInteractionCount: Number(v.views_count) || 0 },
    };
    return {
      ...def, title: `${v.title} · ${v.channel_name} · ${site}`, description: desc, canonical: url, image, type: 'video.other',
      extra: jsonLd(ld) + `<meta property="og:video:type" content="video/mp4">`,
      noscript: `<article><h1>${esc(v.title)}</h1><p>${esc(desc)}</p><p>By <a href="${esc(`/c/${v.channel_handle}`)}">${esc(v.channel_name)}</a></p></article>`,
    };
  }

  if ((m = p.match(/^\/c\/([a-z0-9_]{3,30})$/i))) {
    const c = await db.one(
      `select c.name, c.handle, c.bio, c.avatar_key, c.banner_key, c.created_at,
              (select count(*)::int from videos v where v.channel_id = c.id and v.status = 'published') as videos,
              (select count(*)::int from channel_subscriptions s where s.channel_id = c.id) as subscribers
         from channels c join users u on u.id = c.user_id
        where lower(c.handle) = $1 and c.status = 'approved' and u.account_status = 'active'`, [m[1].toLowerCase()]);
    if (!c) return { ...def, title: `Channel not found · ${site}`, robots: 'noindex,nofollow', canonical: undefined };
    const url = `${base}/c/${c.handle}`;
    const desc = clip(c.bio || `${c.name} (@${c.handle}) on ${site}: ${c.videos} video${c.videos === 1 ? '' : 's'}.`, 200);
    const image = c.avatar_key ? `${base}/media/img/${c.avatar_key}` : def.image;
    return {
      ...def, title: `${c.name} (@${c.handle}) · ${site}`, description: desc, canonical: url, image, type: 'profile',
      extra: jsonLd({ '@context': 'https://schema.org', '@type': 'ProfilePage', dateCreated: iso(c.created_at),
        mainEntity: { '@type': 'Person', name: c.name, alternateName: `@${c.handle}`, url, description: desc, ...(c.avatar_key ? { image } : {}) } }),
      noscript: `<article><h1>${esc(c.name)}</h1><p>@${esc(c.handle)}</p><p>${esc(desc)}</p></article>`,
    };
  }

  if ((m = p.match(/^\/category\/([a-z0-9-]{1,60})$/))) {
    const cat = await db.one('select name, slug from categories where slug = $1 and is_active', [m[1]]);
    if (!cat) return { ...def, robots: 'noindex,nofollow', canonical: undefined };
    return { ...def, title: `${cat.name} videos · ${site}`, description: `Watch ${cat.name} Shorts and long videos on ${site}.` };
  }
  if (SECTION_TITLES[p]) return { ...def, title: `${SECTION_TITLES[p]} · ${site}` };
  return def;
}

/** Returns the shell HTML with per-page metadata filled in. */
export async function renderShell(req) {
  const m = await metaFor(req);
  const tags = [
    `<meta name="robots" content="${m.robots}">`,
    m.canonical ? `<link rel="canonical" href="${esc(m.canonical)}">` : '',
    `<meta property="og:site_name" content="viralX">`,
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.description)}">`,
    `<meta property="og:type" content="${m.type}">`,
    m.canonical ? `<meta property="og:url" content="${esc(m.canonical)}">` : '',
    `<meta property="og:image" content="${esc(m.image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(m.title)}">`,
    `<meta name="twitter:description" content="${esc(m.description)}">`,
    `<meta name="twitter:image" content="${esc(m.image)}">`,
    m.extra,
  ].filter(Boolean).join('\n  ');
  let html = getShell()
    // The shell's static title and social tags are replaced, not duplicated.
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(m.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(m.description)}">`)
    .replace(/<meta property="og:(title|description|type|image)"[^>]*>\s*/g, '')
    .replace(/<meta name="twitter:card"[^>]*>\s*/g, '')
    .replace('</head>', `  ${tags}\n</head>`);
  if (m.noscript) html = html.replace(/<noscript>[\s\S]*?<\/noscript>/, `<noscript>${m.noscript}<p style="padding:24px">viralX needs JavaScript to play videos.</p></noscript>`);
  return html;
}

// ---- sitemap & robots ------------------------------------------------------------------------
export async function buildSitemap(req) {
  const base = baseUrlFor(req);
  const urls = [{ loc: '/', changefreq: 'hourly' }, { loc: '/shorts' }, { loc: '/long' }, { loc: '/categories' }];
  for (const c of await db.query('select slug from categories where is_active order by slug')) urls.push({ loc: `/category/${c.slug}` });
  for (const c of await db.query(
    `select c.handle, max(v.updated_at) as lastmod from channels c join users u on u.id = c.user_id
       left join videos v on v.channel_id = c.id and v.status = 'published'
      where c.status = 'approved' and u.account_status = 'active' group by c.id order by c.handle limit 20000`)) {
    urls.push({ loc: `/c/${c.handle}`, lastmod: c.lastmod });
  }
  for (const v of await db.query(
    `select v.public_id, v.kind, v.updated_at from videos v join channels c on c.id = v.channel_id join users u on u.id = c.user_id
      where v.status = 'published' and c.status = 'approved' and u.account_status = 'active'
      order by v.published_at desc limit 30000`)) {
    urls.push({ loc: `${v.kind === 'short' ? '/shorts' : '/watch'}/${v.public_id}`, lastmod: v.updated_at });
  }
  const body = urls.map((u) => `  <url><loc>${esc(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${iso(u.lastmod).slice(0, 10)}</lastmod>` : ''}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}</url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export const robotsTxt = (req) => [
  'User-agent: *',
  'Allow: /',
  'Disallow: /api/', 'Disallow: /admin', 'Disallow: /studio', 'Disallow: /upload', 'Disallow: /research', 'Disallow: /settings',
  'Disallow: /saved', 'Disallow: /login', 'Disallow: /register', 'Disallow: /search', 'Disallow: /stream/',
  '',
  `Sitemap: ${baseUrlFor(req)}/sitemap.xml`, '',
].join('\n');
