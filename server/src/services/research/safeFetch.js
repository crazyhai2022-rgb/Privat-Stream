// Fetching a creator-supplied URL is a classic SSRF vector, so every step is checked:
//  - http/https only, no credentials, ports 80/443 only
//  - the hostname is resolved by *our* lookup function at connect time and every address must be public,
//    which also defeats DNS rebinding (the checked address is the one that is connected to)
//  - redirects are followed manually (max 3) and each hop is validated again
//  - total time, response size and content type are capped; compressed responses are not requested
//  - cookies and credentials are never sent, and robots.txt is respected
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { config } from '../../config.js';

export class ResearchError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2002::', 16], ['100::', 64], ['2001::', 32],
]) blocked.addSubnet(a, p, 'ipv6');

/** True when the address is loopback, private, link-local, multicast, reserved or otherwise not public. */
export function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 4) return blocked.check(ip, 'ipv4');
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) { const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16); return isBlockedIp([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.')); }
  return blocked.check(ip, 'ipv6');
}

const allowPrivate = () => config.env === 'test' && process.env.RESEARCH_ALLOW_PRIVATE === '1';

export function validateUrl(input, { allowPrivateHosts = allowPrivate() } = {}) {
  let u;
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2000) throw new ResearchError('invalid_url', 'Enter a website address like https://example.com/page');
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { throw new ResearchError('invalid_url', 'That does not look like a valid web address.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ResearchError('invalid_url', 'Only http:// and https:// addresses can be analysed.');
  if (u.username || u.password) throw new ResearchError('invalid_url', 'Addresses containing a username or password are not allowed.');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!allowPrivateHosts && ![80, 443].includes(port)) throw new ResearchError('blocked_url', 'Only standard web ports (80 and 443) are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivateHosts) {
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host) || !host.includes('.') && !net.isIP(host)) {
      throw new ResearchError('blocked_url', 'That address points to a private or internal network and cannot be analysed.');
    }
    if (net.isIP(host) && isBlockedIp(host)) throw new ResearchError('blocked_url', 'That address points to a private or internal network and cannot be analysed.');
    // Odd numeric spellings (2130706433, 0x7f.1, 017700000001) that URL() normalises to a literal are caught above; reject leftovers.
    if (/^[0-9x.]+$/i.test(host) && !net.isIP(host)) throw new ResearchError('blocked_url', 'That address format is not allowed.');
  }
  u.hash = '';
  return u;
}

function safeLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).filter((a) => allowPrivate() || !isBlockedIp(a.address));
    if (!ok.length || ((addrs || []).length !== ok.length && !allowPrivate())) {
      return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    return opts?.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
  });
}

const UA = () => `viralX-Research/1.0 (+${config.baseUrl || 'https://viralx.site'})`;

function once(url, { maxBytes, timeoutMs, accept }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET', lookup: safeLookup, timeout: timeoutMs, agent: false,
      headers: { 'User-Agent': UA(), Accept: accept, 'Accept-Encoding': 'identity', 'Accept-Language': 'en' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location, status }); }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes * 4) { res.destroy(); return reject(new ResearchError('too_large', 'That page is too large to analyse.')); }
      const chunks = []; let size = 0; let truncated = false;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { truncated = true; res.destroy(); return; }
        chunks.push(c);
      });
      res.on('close', () => resolve({ status, type, body: Buffer.concat(chunks), truncated, headers: res.headers }));
      res.on('error', (e) => (truncated ? resolve({ status, type, body: Buffer.concat(chunks), truncated, headers: res.headers }) : reject(e)));
    });
    const hardStop = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs + 1000);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => { clearTimeout(hardStop); reject(e); });
    req.on('close', () => clearTimeout(hardStop));
    req.end();
  });
}

function mapNetError(e) {
  if (e instanceof ResearchError) return e;
  if (e.code === 'EBLOCKED') return new ResearchError('blocked_url', 'That address points to a private or internal network and cannot be analysed.');
  if (e.code === 'ETIMEDOUT') return new ResearchError('fetch_failed', 'The website took too long to respond.');
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return new ResearchError('fetch_failed', 'That website could not be found. Check the address.');
  if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') return new ResearchError('fetch_failed', 'The website refused the connection.');
  if (/certificate|SSL|TLS|self.signed/i.test(`${e.code} ${e.message}`)) return new ResearchError('fetch_failed', 'The website’s security certificate could not be verified.');
  return new ResearchError('fetch_failed', 'The page could not be retrieved.');
}

/** Minimal robots.txt check for our user agent (and *). Missing or unreadable robots.txt means allowed. */
export function robotsAllows(text, path) {
  const groups = []; let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) { if (!line.trim()) cur = null; continue; }
    const k = m[1].toLowerCase();
    if (k === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(m[2].toLowerCase()); }
    else if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push([k, m[2]]);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a && 'viralx-research'.includes(a.replace(/\*/g, '')) && a !== '*'));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  let best = null;
  for (const [kind, pat] of rules) {
    if (!pat) continue;
    const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || pat.length >= best.len)) best = { len: pat.length, allow: kind === 'allow' };
  }
  return !best || best.allow;
}

/**
 * Fetches a page safely. Returns { url, finalUrl, status, contentType, text, truncated }.
 * Throws ResearchError with a message that is safe to show to the creator.
 */
export async function safeFetchPage(input, { maxBytes = 1_500_000, timeoutMs = 8000, robots = true } = {}) {
  let url = validateUrl(input);
  const start = url;
  const deadline = Date.now() + 15000;
  for (let hop = 0; hop <= 3; hop++) {
    if (Date.now() > deadline) throw new ResearchError('fetch_failed', 'The website took too long to respond.');
    if (robots && hop === 0) {
      try {
        const rb = await once(new URL('/robots.txt', url), { maxBytes: 200_000, timeoutMs: 4000, accept: 'text/plain' });
        if (rb.status === 200 && !rb.redirect && !robotsAllows(rb.body.toString('utf8'), url.pathname + url.search)) {
          throw new ResearchError('robots_disallowed', 'This website asks automated tools not to read that page (robots.txt), so it was not fetched.');
        }
      } catch (e) { if (e instanceof ResearchError) throw e; /* robots unreadable: continue */ }
    }
    let r;
    try { r = await once(url, { maxBytes, timeoutMs, accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5' }); } catch (e) { throw mapNetError(e); }
    if (r.redirect) {
      if (hop === 3) throw new ResearchError('fetch_failed', 'The website redirected too many times.');
      try { url = validateUrl(new URL(r.redirect, url).toString()); } catch (e) { throw e instanceof ResearchError ? new ResearchError('blocked_url', 'The website redirected to an address that cannot be analysed.') : e; }
      continue;
    }
    if ([401, 403, 407, 429, 451].includes(r.status)) throw new ResearchError('blocked_by_site', 'That website does not allow automated access (it needs a login or blocks bots), so it cannot be analysed.');
    if (r.status === 404 || r.status === 410) throw new ResearchError('fetch_failed', 'That page was not found (404). Check the address.');
    if (r.status < 200 || r.status >= 300) throw new ResearchError('fetch_failed', `The website responded with an error (${r.status}).`);
    if (!/^(text\/(html|plain)|application\/xhtml\+xml)/.test(r.type)) throw new ResearchError('not_html', 'That address is not a web page (it returned a different kind of file).');
    let charset = (r.type.match(/charset=([\w-]+)/) || [])[1] || 'utf-8';
    let text;
    try { text = new TextDecoder(charset, { fatal: false }).decode(r.body); } catch { text = new TextDecoder('utf-8').decode(r.body); }
    return { url: start.toString(), finalUrl: url.toString(), status: r.status, contentType: r.type.split(';')[0], text, truncated: r.truncated };
  }
  throw new ResearchError('fetch_failed', 'The page could not be retrieved.');
}
