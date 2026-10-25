import { h, icon, setTitle, toast, fmtDate, qs, confirmDialog } from '../util.js';
import { api, state, refreshMe } from '../api.js';
import { navigate } from '../router.js';
import { chart } from '../charts.js';
import { emptyState } from '../cards.js';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inrShort = (n) => (n >= 1000 ? `₹${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `₹${Number(n).toFixed(n % 1 ? 1 : 0)}`);
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const PALETTE = { views: '#7aa7ff', est: '#d9a441', ok: '#58c28a', paid: '#c792ea' };
const shortDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthLabel = (m) => new Date(m + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

const METHOD_LABEL = (m) => (m.type === 'upi' ? 'UPI' : ({ btc: 'Bitcoin', eth: 'Ethereum', usdt: 'USDT' }[m.asset] + ' · ' + ({ bitcoin: 'Bitcoin', ethereum: 'ERC20/Ethereum', tron: 'TRC20', bsc: 'BEP20' }[m.network])));
const VSTATUS = { pending: ['Pending verification', 'pending'], verified: ['Verified', 'approved'], rejected: ['Rejected', 'rejected'], changes_requested: ['Requires changes', 'suspended'] };

async function render({ root }, tab) {
  setTitle('Earnings & Payments');
  if (!state.user) { navigate('/login?next=/studio/earnings', { replace: true }); return; }
  await refreshMe();
  const page = h('div', { class: 'page' });
  root.append(page);
  page.append(h('h1', { class: 'title', style: 'margin-bottom:6px' }, 'Earnings & Payments'));
  if (!state.channel) { page.append(emptyState('No channel yet', 'Create a channel to start earning.', h('a', { class: 'btn primary', href: '/channel/setup', style: 'margin-top:12px' }, 'Set up channel'))); return; }
  if (state.channel.status !== 'approved') { page.append(h('div', { class: 'notice warn' }, 'Earnings and payment settings open once your channel is approved.')); return; }

  tab = tab || 'overview';
  const tabs = h('div', { class: 'tabs' },
    ...[['overview', '/studio/earnings', 'Overview'], ['payouts', '/studio/payouts', 'Payment history'], ['settings', '/studio/payments', 'Payment settings']]
      .map(([k, href, label]) => h('a', { href, class: k === tab ? 'on' : '' }, label)));
  const body = h('div');
  page.append(tabs, body);
  try {
    if (tab === 'overview') await overview(body);
    else if (tab === 'payouts') await history(body);
    else await methodsTab(body);
  } catch (e) { body.append(h('p', { class: 'err' }, e.message)); }
}

export default (ctx) => render(ctx, 'overview');
export const payouts = (ctx) => render(ctx, 'payouts');
export const settings = (ctx) => render(ctx, 'settings');

// ---------------------------------------------------------------------------
async function overview(body) {
  const s = await api.get('/api/me/earnings');
  const b = s.balance;
  const pct = Math.round(b.progress * 100);
  body.append(
    h('div', { class: 'stat-grid earn-cards' },
      stat('Estimated earnings', inr(b.estimated_total), 'All time, before approval'),
      stat('Pending approval', inr(b.pending), `Approved after a short review window`),
      stat('Payable balance', inr(b.payable), b.meets_minimum ? 'Will be paid on the next payout date' : `Carried forward until ${inr(b.min_payout)}`),
      stat('Paid to date', inr(b.paid_to_date), s.last_payout ? `Last: ${inr(s.last_payout.amount)} on ${fmtDate(s.last_payout.paid_at)}` : 'No payouts yet'),
      stat('Eligible views', num(b.eligible_views), 'Views that count toward earnings'),
      stat('Next payout date', fmtDate(b.next_payout_date), 'Monthly, on the 7th')),
    h('div', { class: 'card', style: 'margin:16px 0' },
      h('div', { class: 'row between' }, h('b', null, `Progress to ${inr(b.min_payout)} minimum payout`), h('span', { class: 'muted' }, `${inr(b.payable)} / ${inr(b.min_payout)}`)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${pct}%` })),
      h('p', { class: 'muted small', style: 'margin-top:8px' }, b.meets_minimum
        ? 'You have reached the minimum. The full balance is paid on the next payout date.'
        : `Payouts are made in full only. Below ${inr(b.min_payout)} your balance simply carries forward to the next month — nothing is lost.`),
      s.converted.amounts.USD != null ? h('p', { class: 'muted small' }, `Estimated ≈ $${s.converted.amounts.USD.toFixed(2)} USD (indicative only; updated ${fmtDate(s.converted.rates_updated_at)})`) : null),
    h('div', { class: 'notice', style: 'margin-bottom:16px' },
      h('b', null, 'Rates: '), `Shorts ${inr(s.rates.short_per_1000 * 5)} per 5,000 eligible views · Long videos ${inr(s.rates.long_per_1000)} per 1,000 eligible views. `,
      'Figures are estimates until approved. Only genuine, unique-viewer views count.'));

  // Filters
  let range = '30', from = '', to = '';
  const chartsHost = h('div'), topHost = h('div');
  const mkBtn = (r, label) => h('button', { class: r === range ? 'on' : '', onclick: () => { range = r; customRow.hidden = r !== 'custom'; if (r !== 'custom') load(); drawBtns(); } }, label);
  const btns = h('div', { class: 'tabs', style: 'margin:0' });
  const fromI = h('input', { type: 'date', class: 'input', 'aria-label': 'From' }), toI = h('input', { type: 'date', class: 'input', 'aria-label': 'To' });
  const customRow = h('div', { class: 'row wrap', hidden: true, style: 'margin:8px 0' }, fromI, toI,
    h('button', { class: 'btn sm primary', onclick: () => { from = fromI.value; to = toI.value; load(); } }, 'Apply'));
  const drawBtns = () => btns.replaceChildren(mkBtn('7', 'Last 7 days'), mkBtn('30', 'Last 30 days'), mkBtn('90', 'Last 90 days'), mkBtn('custom', 'Custom'));
  drawBtns();
  body.append(h('h2', { style: 'margin:8px 0' }, 'Performance'), btns, customRow, chartsHost, topHost);

  async function load() {
    const q = qs({ range, from: range === 'custom' ? from : '', to: range === 'custom' ? to : '' });
    try {
      const [c, t] = await Promise.all([api.get('/api/me/earnings/chart' + q), api.get('/api/me/earnings/videos' + q)]);
      const labels = c.daily.map((d) => shortDay(d.day));
      const total = c.daily.reduce((a, d) => a + d.estimated, 0), views = c.daily.reduce((a, d) => a + d.eligible_views, 0);
      chartsHost.replaceChildren(
        h('p', { class: 'muted small' }, `${shortDay(c.from)} – ${shortDay(c.to)} · ${num(views)} eligible views · ${inr(total)} estimated`),
        card('Daily eligible views', chart({ labels, series: [
          { name: 'Shorts', color: PALETTE.views, values: c.daily.map((d) => d.short_views) },
          { name: 'Long videos', color: '#5b6b8c', values: c.daily.map((d) => d.long_views) }], stacked: true, fmt: (n) => num(Math.round(n)) })),
        card('Estimated vs approved earnings', chart({ labels, series: [
          { name: 'Estimated', color: PALETTE.est, values: c.daily.map((d) => d.estimated) },
          { name: 'Approved', color: PALETTE.ok, values: c.daily.map((d) => d.approved) }], fmt: inrShort })),
        card('Monthly views', chart({ labels: c.monthly.map((m) => monthLabel(m.month)), series: [{ name: 'Eligible views', color: PALETTE.views, values: c.monthly.map((m) => m.eligible_views) }], fmt: (n) => num(Math.round(n)) })),
        card('Monthly earnings and payments', chart({ labels: [...new Set([...c.monthly.map((m) => m.month), ...c.paid_monthly.map((m) => m.month)])].sort().map(monthLabel), series: (() => {
          const months = [...new Set([...c.monthly.map((m) => m.month), ...c.paid_monthly.map((m) => m.month)])].sort();
          return [{ name: 'Estimated', color: PALETTE.est, values: months.map((m) => c.monthly.find((x) => x.month === m)?.estimated || 0) },
            { name: 'Approved', color: PALETTE.ok, values: months.map((m) => c.monthly.find((x) => x.month === m)?.approved || 0) },
            { name: 'Paid', color: PALETTE.paid, values: months.map((m) => c.paid_monthly.find((x) => x.month === m)?.paid || 0) }];
        })(), fmt: inrShort })));
      topHost.replaceChildren(card('Top earning videos', t.items.length
        ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ...['Video', 'Type', 'Eligible views', 'Estimated'].map((x) => h('th', null, x)))),
          h('tbody', null, ...t.items.map((v) => h('tr', null, h('td', null, h('a', { href: `/watch/${v.public_id}` }, v.title)), h('td', null, v.kind === 'short' ? 'Short' : 'Video'), h('td', null, num(v.eligible_views)), h('td', null, inr(v.estimated)))))))
        : h('p', { class: 'muted' }, 'No earnings in this period yet.')));
    } catch (e) { chartsHost.replaceChildren(h('p', { class: 'err' }, e.message)); }
  }
  await load();
}

const stat = (label, value, sub) => h('div', { class: 'stat' }, h('span', null, label), h('b', null, value), h('small', { class: 'muted' }, sub));
const card = (title, ...kids) => h('div', { class: 'card', style: 'margin:12px 0' }, h('b', { style: 'display:block;margin-bottom:8px' }, title), ...kids);

// ---------------------------------------------------------------------------
async function history(body) {
  const d = await api.get('/api/me/payouts');
  if (!d.items.length) { body.append(emptyState('No payouts yet', 'Payouts are made on the 7th of each month once your balance reaches ₹500.')); return; }
  body.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ...['Date', 'Amount', 'Method', 'Status', 'Reference'].map((x) => h('th', null, x)))),
    h('tbody', null, ...d.items.map((p) => h('tr', null,
      h('td', null, fmtDate(p.paid_at || p.created_at)), h('td', null, inr(p.amount)),
      h('td', null, p.method_masked ? `${p.method_type === 'upi' ? 'UPI' : (p.method_asset || '').toUpperCase()} ${p.method_masked}` : '—'),
      h('td', null, h('span', { class: `status ${p.status === 'paid' ? 'approved' : p.status === 'failed' ? 'rejected' : 'pending'}` }, p.display_status),
        p.failure_reason ? h('div', { class: 'muted small' }, p.failure_reason) : null, p.hold_reason ? h('div', { class: 'muted small' }, p.hold_reason) : null),
      h('td', { class: 'mono small' }, p.transaction_ref || p.tx_hash || '—')))))));
}

// ---------------------------------------------------------------------------
async function methodsTab(body) {
  const d = await api.get('/api/me/payment-methods');
  const list = h('div');
  const draw = (items) => {
    list.replaceChildren(...(items.length ? items.map((m) => {
      const [label, cls] = VSTATUS[m.status];
      return h('div', { class: 'card', style: 'margin-bottom:10px' },
        h('div', { class: 'row between wrap' },
          h('div', null, h('b', null, METHOD_LABEL(m)), h('div', { class: 'mono' }, m.masked), h('div', { class: 'muted small' }, m.holder_name)),
          h('div', { class: 'row wrap' }, m.is_default ? h('span', { class: 'status approved' }, 'Default') : null, h('span', { class: `status ${cls}` }, label))),
        m.status_reason ? h('p', { class: 'muted small', style: 'margin-top:6px' }, `Note from reviewer: ${m.status_reason}`) : null,
        h('div', { class: 'row wrap', style: 'margin-top:10px' },
          !m.is_default && m.status !== 'rejected' ? h('button', { class: 'btn sm', onclick: async () => { try { draw((await api.post(`/api/me/payment-methods/${m.id}/default`)).items); toast('Default updated'); } catch (e) { toast(e.message, 'bad'); } } }, 'Make default') : null,
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (!(await confirmDialog({ title: 'Remove this payment method?', text: 'Past payouts are not affected.', confirmText: 'Remove', danger: true }))) return;
            try { draw((await api.del(`/api/me/payment-methods/${m.id}`)).items); } catch (e) { toast(e.message, 'bad'); }
          } }, 'Remove')));
    }) : [h('p', { class: 'muted' }, 'No payment method yet. Add one below to receive payouts.')]));
  };
  draw(d.items);

  // Form
  const type = h('select', { class: 'select', id: 'pm-type' }, h('option', { value: 'upi' }, 'UPI (India)'), h('option', { value: 'crypto' }, 'Crypto wallet'));
  const holder = h('input', { class: 'input', id: 'pm-holder', maxlength: 100, autocomplete: 'off', placeholder: 'Name on the account' });
  const value = h('input', { class: 'input', id: 'pm-value', maxlength: 200, autocomplete: 'off', spellcheck: 'false' });
  const coin = h('select', { class: 'select', id: 'pm-coin' }, ...d.crypto_options.map((o, i) => h('option', { value: i }, o.label)));
  const confirm = h('input', { type: 'checkbox', id: 'pm-confirm' });
  const cryptoBox = h('div', { hidden: true },
    field('Coin and network', coin, 'Choose the network carefully. Funds sent on the wrong network cannot be recovered.'),
    h('label', { class: 'row small', style: 'margin:0 0 14px' }, confirm, 'I confirm this address is on the network selected above.'));
  const valLabel = h('label', { for: 'pm-value' }, 'UPI ID');
  const err = h('p', { class: 'err', hidden: true });
  const sync = () => { const c = type.value === 'crypto'; cryptoBox.hidden = !c; valLabel.textContent = c ? 'Wallet address' : 'UPI ID'; value.placeholder = c ? 'Paste the full address' : 'name@bank'; };
  type.addEventListener('change', sync); sync();
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Save payment method');
  const form = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; submit.disabled = true;
    try {
      const o = d.crypto_options[Number(coin.value)];
      const payload = { type: type.value, holder_name: holder.value, value: value.value.trim() };
      if (type.value === 'crypto') Object.assign(payload, { asset: o.asset, network: o.network, network_confirmed: confirm.checked });
      await api.post('/api/me/payment-methods', payload);
      value.value = ''; confirm.checked = false;
      draw((await api.get('/api/me/payment-methods')).items);
      toast('Saved. An administrator will verify it before your first payout.');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    submit.disabled = false;
  } },
    h('b', { style: 'display:block;margin-bottom:10px' }, 'Add a payment method'),
    field('Type', type), field('Account holder name', holder),
    cryptoBox, h('div', { class: 'field' }, valLabel, value), err, submit);

  body.append(
    h('div', { class: 'notice', style: 'margin-bottom:14px' },
      'Payouts are calculated in INR. Crypto payouts, where offered, are converted at the time of payment and the amount you receive may differ from any estimate shown. ',
      'Your account details are encrypted and only shown masked. A new method must be verified by an administrator before it can be paid.'),
    h('h2', { style: 'margin:8px 0' }, 'Your payment methods'), list, form);
}
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
