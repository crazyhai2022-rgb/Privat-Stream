// Turns fetched HTML into plain, bounded facts. Nothing is executed or rendered: scripts, styles and
// markup are stripped with a tokenizer-light approach and only text is kept.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', copy: '©' };
const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const safeChar = (n) => (n > 31 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ');
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e]', 'g');
const clean = (s, max) => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const attr = (tag, name) => { const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[2] ?? m[3] ?? m[4]) : ''; };
function metaMap(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, 'name') || attr(tag, 'property')).toLowerCase();
    const val = attr(tag, 'content');
    if (key && val && !(key in map)) map[key] = clean(val, 400);
  }
  return map;
}

export const STOP = new Set(('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just like me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours yourself ' +
  'click read menu home login sign signup subscribe cookie cookies privacy policy terms contact copyright rights reserved share facebook twitter instagram youtube linkedin newsletter search skip content').split(' '));

/** Extracts title, description, headings, body text and candidate keywords from HTML. */
export function extractPage(html, { maxText = 8000 } = {}) {
  const head = html.slice(0, 200_000);
  const title = clean((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1], 160);
  const meta = metaMap(head);
  const lang = clean((html.match(/<html[^>]*\blang\s*=\s*["']?([\w-]+)/i) || [])[1], 12);

  // Remove everything that is not reader text before collecting headings and body.
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|form|nav|footer|header|aside)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const headings = [];
  for (const m of body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) {
    const t = clean(m[2], 140);
    if (t.length >= 4 && !headings.includes(t)) headings.push(t);
    if (headings.length >= 14) break;
  }
  const paragraphs = [];
  for (const m of body.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const t = clean(m[2], 400);
    if (t.split(' ').length >= 6) paragraphs.push(t);
    if (paragraphs.length >= 60) break;
  }
  let text = paragraphs.join(' ');
  if (text.length < 200) text = clean(body, maxText);
  text = text.slice(0, maxText);

  const description = meta['og:description'] || meta.description || meta['twitter:description'] || '';
  const siteName = meta['og:site_name'] || '';
  return {
    title: meta['og:title'] ? clean(meta['og:title'], 160) : title,
    pageTitle: title, description, siteName, lang, headings, text,
    keywords: rankKeywords({ title, description, headings, text, metaKeywords: meta.keywords }),
  };
}

/** Frequency-based keyword candidates, boosted when they appear in the title, description or headings. */
export function rankKeywords({ title = '', description = '', headings = [], text = '', metaKeywords = '' }, limit = 14) {
  const tokenize = (s) => (String(s).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).map((w) => w.replace(/['’]s$/, ''));
  const score = new Map();
  const add = (words, weight) => {
    for (let i = 0; i < words.length; i++) {
      for (const n of [1, 2]) {
        const g = words.slice(i, i + n);
        if (g.length < n || g.some((w) => STOP.has(w) || w.length < 3 || /^\d+$/.test(w))) continue;
        if (n === 2 && (STOP.has(g[0]) || STOP.has(g[1]))) continue;
        const k = g.join(' ');
        score.set(k, (score.get(k) || 0) + weight * (n === 2 ? 1.6 : 1));
      }
    }
  };
  add(tokenize(text), 1); add(tokenize(description), 4); add(tokenize(title), 6);
  for (const hd of headings) add(tokenize(hd), 4);
  for (const k of String(metaKeywords).split(',').slice(0, 15)) add(tokenize(k), 3);
  const ranked = [...score.entries()].filter(([k, v]) => v >= 3 || k.includes(' ')).sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [k] of ranked) {
    if (out.some((o) => o === k || o.includes(k) || k.includes(o))) continue;   // drop near-duplicates ("video" vs "video editing")
    out.push(k);
    if (out.length >= limit) break;
  }
  return out;
}
