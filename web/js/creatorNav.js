import { h, icon } from './util.js';

/** Upload / Research switcher shown at the top of both creator tools. Plain links, so client-side navigation keeps state. */
export function creatorTabs(active) {
  const tab = (key, href, label, ic) => h('a', { href, class: key === active ? 'on' : '', 'aria-current': key === active ? 'page' : null }, icon(ic), label);
  return h('nav', { class: 'tabs creator-tabs', 'aria-label': 'Creator tools' },
    tab('upload', '/upload', 'Upload', 'upload'), tab('research', '/research', 'Research', 'search'),
    h('a', { href: '/studio/earnings' }, icon('sliders'), 'Earnings'), h('a', { href: '/studio' }, icon('film'), 'Studio'));
}
