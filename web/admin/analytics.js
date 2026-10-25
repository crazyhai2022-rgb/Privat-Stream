// Visitor analytics: pseudonymous daily counts only. No IP addresses or page paths are collected.
import { h, fmtCount } from '../js/util.js';
import { api } from '../js/api.js';
import { chart } from '../js/charts.js';

const stat = (label, value, sub) => h('div', { class: 'stat' }, h('span', null, label), h('b', null, value), sub ? h('small', { class: 'muted' }, sub) : null);
const panel = (title, ...kids) => h('section', { class: 'panel' }, h('h3', null, title), ...kids);
const delta = (now, before) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% vs yesterday` : 'No data yesterday');

export async function visitorsPage() {
  const body = h('div');
  const sel = h('select', { class: 'select', style: 'max-width:180px', 'aria-label': 'Range' }, [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([v, l]) => h('option', { value: v, selected: v === 30 }, l)));
  async function load() {
    const d = await api.get(`/api/admin/analytics/visitors?days=${sel.value}`);
    const t = d.totals;
    const labels = d.series.map((x) => x.day.slice(5));
    const kinds = Object.fromEntries(d.by_kind.map((k) => [k.kind, k]));
    body.replaceChildren(
      h('div', { class: 'stat-grid' },
        stat('Visitors today', fmtCount(d.today.visitors), delta(d.today.visitors, d.yesterday.visitors)),
        stat('Page views today', fmtCount(d.today.pageviews), delta(d.today.pageviews, d.yesterday.pageviews)),
        stat('Unique visitors', fmtCount(t.unique_visitors), `Last ${d.days} days`),
        stat('New visitors', fmtCount(t.new_visitors), t.unique_visitors ? `${Math.round((t.new_visitors / t.unique_visitors) * 100)}% of visitors` : ''),
        stat('Signed in', fmtCount(t.signed_in), t.unique_visitors ? `${Math.round((t.signed_in / t.unique_visitors) * 100)}% of visitors` : ''),
        stat('Page views', fmtCount(t.pageviews), `Last ${d.days} days`),
        stat('Short viewers', fmtCount(kinds.short?.viewers || 0), `${fmtCount(kinds.short?.views || 0)} views`),
        stat('Long-video viewers', fmtCount(kinds.long?.viewers || 0), `${fmtCount(kinds.long?.views || 0)} views`)),
      panel('Visitors per day', chart({ type: 'bar', stacked: true, labels, series: [
        { name: 'New', color: '#5aa9ff', values: d.series.map((x) => x.new_visitors) },
        { name: 'Returning', color: '#6bd08a', values: d.series.map((x) => x.returning_visitors) }], fmt: (n) => fmtCount(Math.round(n)) })),
      panel('Page views per day', chart({ type: 'line', labels, series: [{ name: 'Page views', color: '#ff5a5f', values: d.series.map((x) => x.pageviews) }], fmt: (n) => fmtCount(Math.round(n)) })),
      panel('Video views by hour (UTC)', chart({ type: 'bar', labels: d.by_hour_utc.map((x) => String(x.hour)), series: [{ name: 'Views', color: '#e6c36a', values: d.by_hour_utc.map((x) => x.views) }], fmt: (n) => fmtCount(Math.round(n)) })),
      panel('Most watched videos', h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Video'), h('th', null, 'Channel'), h('th', { class: 'num' }, 'Views'))),
        h('tbody', null, d.top_videos.length ? d.top_videos.map((v) => h('tr', null,
          h('td', null, h('a', { href: `/watch/${v.public_id}`, target: '_blank', rel: 'noopener' }, v.title), ' ', h('span', { class: 'muted small' }, v.kind)),
          h('td', null, v.channel_name), h('td', { class: 'num' }, fmtCount(v.views))))
          : h('tr', null, h('td', { colspan: 3, style: 'text-align:center;color:var(--text-2);padding:28px' }, 'No views in this range.')))))),
      h('p', { class: 'muted small' }, 'Counts are one pseudonymous visitor per day. Bots, administrators and visitors who send Do Not Track are excluded. No IP addresses or page paths are stored.'));
  }
  sel.onchange = load;
  const root = h('div', null, h('div', { style: 'margin-bottom:12px' }, sel), body);
  await load();
  return root;
}
