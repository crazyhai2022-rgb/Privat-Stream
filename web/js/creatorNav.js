import { h, icon } from './util.js';

/** Upload / Research switcher shown at the top of both creator tools. Plain links, so client-side navigation keeps state. */
export function creatorTabs(active) {
  const tab = (key, href, label, ic) => h('a', { href, class: key === active ? 'on' : '', 'aria-current': key === active ? 'page' : null }, icon(ic), label);
  return h('nav', { class: 'tabs creator-tabs', 'aria-label': 'Creator tools' },
    tab('upload', '/upload', 'Upload', 'upload'), tab('research', '/research', 'Research', 'search'),
    h('a', { href: '/studio/earnings' }, icon('sliders'), 'Earnings'), h('a', { href: '/studio' }, icon('film'), 'Studio'));
}

/** Creator studio tabs: videos, earnings and payments all live under the studio. */
export function studioTabs(active) {
  const t = (key, href, label) => h('a', { href, class: key === active ? 'on' : '', 'aria-current': key === active ? 'page' : null }, label);
  return h('nav', { class: 'tabs studio-tabs', 'aria-label': 'Creator studio' },
    t('dashboard', '/studio', 'Dashboard'), t('videos', '/studio/videos', 'Videos'), t('overview', '/studio/earnings', 'Earnings'),
    t('payouts', '/studio/payouts', 'Payment history'), t('settings', '/studio/payments', 'Payment settings'), t('defaults', '/studio/upload-defaults', 'Upload defaults'));
}
