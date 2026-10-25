import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { client, makeCreator, shutdown } from './helpers.js';
import { isBlockedIp, validateUrl, robotsAllows, safeFetchPage, ResearchError } from '../src/services/research/safeFetch.js';
import { extractPage } from '../src/services/research/extract.js';
import { normalizeSuggestions } from '../src/services/research/generate.js';

process.env.RESEARCH_ALLOW_PRIVATE = '1';       // the fixture server lives on 127.0.0.1; checks below turn it off
after(shutdown);

const ARTICLE = `<!doctype html><html lang="en"><head><title>Home Coffee Brewing Guide</title>
<meta name="description" content="Learn how to brew great coffee at home with simple tools and a little practice.">
<script>alert('do not run this')</script><style>.x{}</style></head><body><nav>Home About Contact</nav>
<h1>Home Coffee Brewing Guide</h1>
<p>Brewing coffee at home starts with fresh beans, clean water and a grinder that gives an even grind size every time.</p>
<h2>Pour over coffee for beginners</h2><p>Pour over coffee rewards patience, because a slow circular pour extracts sweetness without bitterness from the grounds.</p>
<h2>French press coffee method</h2><p>The French press method steeps coarse grounds for four minutes before a gentle plunge that keeps sediment out of the cup.</p>
<h2>Cold brew coffee recipe</h2><p>Cold brew coffee uses a long steep in cool water, which produces a smooth concentrate that keeps for days in the fridge.</p>
<h2>Espresso machine basics</h2><p>An espresso machine forces hot water through tightly packed grounds, so tamping pressure and grind size matter a great deal.</p>
<h2>Choosing a coffee grinder</h2><p>A burr grinder beats a blade grinder because it crushes beans to a uniform size and gives repeatable brewing results at home.</p>
<footer>© 2026 Somebody</footer></body></html>`;

let srv, base;
before(async () => {
  srv = http.createServer((req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(body); };
    if (req.url === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /private\n');
    if (req.url === '/article') return send(200, 'text/html; charset=utf-8', ARTICLE);
    if (req.url === '/private/page') return send(200, 'text/html', ARTICLE);
    if (req.url === '/forbidden') return send(403, 'text/html', 'no');
    if (req.url === '/login') return send(401, 'text/html', 'no');
    if (req.url === '/missing') return send(404, 'text/html', 'no');
    if (req.url === '/json') return send(200, 'application/json', '{"a":1}');
    if (req.url === '/tiny') return send(200, 'text/html', '<html><body><script>1</script></body></html>');
    if (req.url === '/big') return send(200, 'text/html', ARTICLE.replace('</body>', `<p>${'filler words here '.repeat(200000)}</p></body>`));
    if (req.url === '/go') return send(302, 'text/html', '', { location: '/article' });
    if (req.url === '/loop') return send(302, 'text/html', '', { location: '/loop' });
    send(404, 'text/plain', 'x');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

describe('SSRF protections', () => {
  test('private, loopback, link-local and reserved addresses are blocked, public ones are not', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::192.168.0.1', '2002:7f00:1::1', 'not-an-ip']) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '172.32.0.1']) assert.equal(isBlockedIp(ip), false, ip);
  });

  test('bad schemes, credentials, internal hostnames, odd ports and numeric tricks are refused', () => {
    const off = { allowPrivateHosts: false };
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.com', 'https://user:pw@example.com/',
      'http://localhost/', 'http://LOCALHOST:8080/', 'http://foo.localhost/', 'http://printer.local/', 'http://intranet/', 'http://service.internal/',
      'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'https://example.com:22/', 'https://example.com:6379/', '', 'x'.repeat(3000)]) {
      assert.throws(() => validateUrl(u, off), ResearchError, u.slice(0, 50));
    }
    assert.equal(validateUrl('example.com/page', off).toString(), 'https://example.com/page');
    assert.equal(validateUrl('https://Example.com:443/a#frag', off).hash, '');
  });

  test('with protections on, a local server cannot be fetched at all', async () => {
    process.env.RESEARCH_ALLOW_PRIVATE = '0';
    try {
      await assert.rejects(() => safeFetchPage(`${base}/article`), (e) => e.code === 'blocked_url');
    } finally { process.env.RESEARCH_ALLOW_PRIVATE = '1'; }
  });
});

describe('fetching', () => {
  test('reads a page, follows a safe redirect and honours size and type limits', async () => {
    const ok = await safeFetchPage(`${base}/article`);
    assert.equal(ok.status, 200); assert.match(ok.text, /Coffee Brewing/);
    const viaRedirect = await safeFetchPage(`${base}/go`);
    assert.ok(viaRedirect.finalUrl.endsWith('/article'));
    const big = await safeFetchPage(`${base}/big`);
    assert.equal(big.truncated, true); assert.ok(big.text.length <= 1_500_000);
    await assert.rejects(() => safeFetchPage(`${base}/json`), (e) => e.code === 'not_html');
    await assert.rejects(() => safeFetchPage(`${base}/loop`), /redirected too many times/);
  });

  test('sites that block bots, need logins, are missing or disallow crawling give clear errors', async () => {
    await assert.rejects(() => safeFetchPage(`${base}/forbidden`), (e) => e.code === 'blocked_by_site');
    await assert.rejects(() => safeFetchPage(`${base}/login`), (e) => e.code === 'blocked_by_site');
    await assert.rejects(() => safeFetchPage(`${base}/missing`), /not found/);
    await assert.rejects(() => safeFetchPage(`${base}/private/page`), (e) => e.code === 'robots_disallowed');
    await assert.rejects(() => safeFetchPage('http://127.0.0.1:1/'), (e) => e.code === 'fetch_failed');
  });

  test('robots.txt rules', () => {
    const t = 'User-agent: *\nDisallow: /a\nAllow: /a/ok\n\nUser-agent: viralx-research\nDisallow: /only-us\n';
    assert.equal(robotsAllows(t, '/a/x'), true, 'our own group wins');
    assert.equal(robotsAllows(t, '/only-us'), false);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a/ok', '/a/ok/1'), true);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a/ok', '/a/no'), false);
    assert.equal(robotsAllows('User-agent: *\nDisallow:', '/anything'), true);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/x'), false);
  });
});

describe('extraction and generation', () => {
  test('scripts and styles are dropped, headings and keywords are found, entities are decoded', () => {
    const p = extractPage(ARTICLE.replaceAll('Brewing', 'Brewing &amp; Tasting'));
    assert.match(p.title, /Home Coffee Brewing & Tasting Guide/);
    assert.ok(!/alert|do not run/.test(p.text + p.headings.join(' ')));
    assert.equal(p.headings.length, 6);
    assert.ok(p.keywords.some((k) => k.includes('coffee')), p.keywords.join('|'));
    assert.match(p.headings[0], /Brewing & Tasting/);
    assert.ok(p.keywords.every((k) => !/^(the|and|with)$/.test(k)));
  });

  test('normalisation gives exactly five unique hashtags and drops duplicate titles', () => {
    const page = extractPage(ARTICLE);
    const out = normalizeSuggestions([
      { title: 'Pour over coffee for beginners', description: 'd', hashtags: ['#Coffee', 'coffee', 'pour over'], keywords: ['coffee'] },
      { title: 'POUR OVER COFFEE FOR BEGINNERS', description: 'dup', hashtags: [], keywords: [] },
      { title: 'x', description: 'too short title', hashtags: [], keywords: [] },
    ], page, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].hashtags.length, 5);
    assert.equal(new Set(out[0].hashtags).size, 5);
    assert.ok(out[0].hashtags.every((t) => /^#[\p{L}\p{N}]+$/u.test(t)));
  });
});

describe('POST /api/research/analyze', () => {
  test('needs an approved creator', async () => {
    assert.equal((await client().post('/api/research/analyze', { url: `${base}/article`, count: 2 })).status, 401);
    const pending = await makeCreator({ approve: false });
    assert.equal((await pending.client.post('/api/research/analyze', { url: `${base}/article`, count: 2 })).status, 403);
  });

  test('1 to 5 suggestions come back distinct, each with exactly five hashtags', async () => {
    const c = await makeCreator();
    for (const n of [1, 2, 3, 4, 5]) {
      const r = await c.client.post('/api/research/analyze', { url: `${base}/article`, count: n });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.suggestions.length, n);
      assert.equal(new Set(r.body.suggestions.map((s) => s.title.toLowerCase())).size, n, 'titles are not repeats');
      for (const s of r.body.suggestions) {
        assert.equal(s.hashtags.length, 5);
        assert.ok(s.title.length >= 6 && s.title.length <= 100);
        assert.ok(s.description.length > 20 && s.description.length <= 400);
      }
      assert.equal(r.body.mode, 'template');
      assert.match(r.body.notes.join(' '), /No AI service is configured/);
      assert.match(r.body.notes.join(' '), /No search-volume/);
    }
  });

  test('validation and failure messages', async () => {
    const c = await makeCreator();
    assert.equal((await c.client.post('/api/research/analyze', { url: `${base}/article`, count: 6 })).status, 400);
    assert.equal((await c.client.post('/api/research/analyze', { url: `${base}/article`, count: 0 })).status, 400);
    let r = await c.client.post('/api/research/analyze', { url: 'not a url at all', count: 2 });
    assert.equal(r.status, 422); assert.equal(r.body.error.code, 'invalid_url');
    r = await c.client.post('/api/research/analyze', { url: `${base}/forbidden`, count: 2 });
    assert.equal(r.status, 422); assert.equal(r.body.error.code, 'blocked_by_site');
    r = await c.client.post('/api/research/analyze', { url: `${base}/tiny`, count: 2 });
    assert.equal(r.status, 422); assert.equal(r.body.error.code, 'empty_content');
  });
});
