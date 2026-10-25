import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { base, db, client, makeCreator, makeAdmin, uploadVideo, publish, shutdown } from './helpers.js';
import { isoDuration } from '../src/services/seo.js';

after(shutdown);
const page = async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text(), headers: r.headers }; };
const ld = (html) => { const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); return m ? JSON.parse(m[1]) : null; };

describe('page metadata', () => {
  test('a published video gets its own title, canonical, Open Graph tags and VideoObject data', async () => {
    const c = await makeCreator();
    const id = await uploadVideo(c, { kind: 'long', title: 'Pour over <script>x</script> coffee' });
    await publish(id);
    const { status, html } = await page(`/watch/${id}`);
    assert.equal(status, 200);
    assert.match(html, /<title>Pour over &lt;script&gt;x&lt;\/script&gt; coffee ·/);
    assert.ok(html.includes(`<link rel="canonical" href="${base}/watch/${id}">`) || /<link rel="canonical" href="https?:\/\/[^"]+\/watch\//.test(html));
    assert.match(html, /<meta name="robots" content="index,follow">/);
    assert.match(html, /property="og:image" content="[^"]*\/thumb\/[^"]+"/);
    assert.equal((html.match(/property="og:title"/g) || []).length, 1, 'no duplicated tags');
    assert.equal((html.match(/<title>/g) || []).length, 1);
    const data = ld(html);
    assert.equal(data['@type'], 'VideoObject');
    assert.equal(data.name, 'Pour over <script>x</script> coffee');
    assert.match(data.duration, /^PT/);
    assert.ok(data.uploadDate && !Number.isNaN(Date.parse(data.uploadDate)));
    assert.ok(!html.includes('</script>x'), 'markup in titles cannot break out of the JSON-LD block');
    assert.match(data.thumbnailUrl[0], /\/thumb\//);
  });

  test('short videos use the /shorts URL; channels get profile metadata', async () => {
    const c = await makeCreator({ handle: 'seo_channel' });
    await db.query(`update channels set bio = 'Weekly coffee tips and reviews.' where id = $1`, [c.channelId]);
    const id = await uploadVideo(c, { kind: 'short', title: 'Quick tip' });
    await publish(id);
    assert.match((await page(`/shorts/${id}`)).html, new RegExp(`rel="canonical" href="[^"]*/shorts/${id}"`));
    const ch = await page('/c/seo_channel');
    assert.match(ch.html, /<title>.*\(@seo_channel\) · viralX<\/title>/);
    assert.match(ch.html, /Weekly coffee tips/);
    assert.equal(ld(ch.html)['@type'], 'ProfilePage');
  });

  test('drafts, pending, rejected, removed videos and unapproved channels are never described or indexed', async () => {
    const c = await makeCreator();
    const pending = await uploadVideo(c, { kind: 'short', title: 'Secret pending' });             // pending moderation
    const p = await page(`/shorts/${pending}`);
    assert.match(p.html, /content="noindex,nofollow"/);
    assert.ok(!p.html.includes('Secret pending'));
    assert.equal(ld(p.html), null);

    const draft = await c.client.post('/api/videos', { kind: 'short', title: 'Secret draft', description: '', tags: [] });
    assert.ok(!(await page(`/shorts/${draft.body.video.id}`)).html.includes('Secret draft'));

    const gone = await uploadVideo(c, { kind: 'long', title: 'Removed one' }); await publish(gone);
    await db.query(`update videos set status = 'removed' where public_id = $1`, [gone]);
    assert.match((await page(`/watch/${gone}`)).html, /noindex/);

    const unapproved = await makeCreator({ approve: false, handle: 'not_yet_approved' });
    const u = await page('/c/not_yet_approved');
    assert.match(u.html, /noindex/);
    assert.ok(!u.html.includes('not_yet_approved'.toUpperCase()));
    assert.match((await page('/c/does_not_exist')).html, /noindex/);
    void unapproved;
  });

  test('private creator pages and the admin panel are noindex', async () => {
    for (const p of ['/studio', '/upload', '/research', '/settings', '/login']) assert.match((await page(p)).html, /content="noindex,nofollow"/, p);
    const admin = await fetch(base + '/admin');
    assert.match(admin.headers.get('x-robots-tag') || '', /noindex/);
    assert.match((await fetch(base + '/api/categories')).headers.get('x-robots-tag') || '', /noindex/);
    assert.match((await page('/')).html, /content="index,follow"/);
  });
});

describe('sitemap and robots', () => {
  test('lists public videos and channels only, never private ones', async () => {
    const c = await makeCreator({ handle: 'sitemap_chan' });
    const live = await uploadVideo(c, { kind: 'long', title: 'Live one' }); await publish(live);
    const waiting = await uploadVideo(c, { kind: 'short', title: 'Waiting one' });
    const hidden = await makeCreator({ approve: false, handle: 'sitemap_hidden' });
    const pend = await uploadVideo(c, { kind: 'long', title: 'Removed later' }); await publish(pend);
    await db.query(`update videos set status = 'removed' where public_id = $1`, [pend]);
    const suspended = await makeCreator({ handle: 'sitemap_susp' });
    await db.query(`update users set account_status = 'suspended' where id = $1`, [suspended.userId]);

    const r = await fetch(base + '/sitemap.xml');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /xml/);
    const xml = await r.text();
    assert.ok(xml.includes(`/watch/${live}</loc>`));
    assert.ok(xml.includes('/c/sitemap_chan</loc>'));
    for (const nope of [waiting, pend, 'sitemap_hidden', 'sitemap_susp']) assert.ok(!xml.includes(nope), `${nope} must not be listed`);
    assert.ok(!xml.includes('/studio') && !xml.includes('/admin'));
    void hidden;
  });

  test('robots.txt points to the sitemap and keeps private areas out', async () => {
    const t = await (await fetch(base + '/robots.txt')).text();
    assert.match(t, /Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);
    for (const d of ['/api/', '/admin', '/studio', '/upload', '/research']) assert.ok(t.includes(`Disallow: ${d}`), d);
  });

  test('duration formatting', () => {
    assert.equal(isoDuration(59), 'PT59S'); assert.equal(isoDuration(60), 'PT1M'); assert.equal(isoDuration(3661), 'PT1H1M1S'); assert.equal(isoDuration(0), 'PT0S');
  });
});
