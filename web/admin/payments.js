// Super Admin "Creator payments". Everything shown comes from the ledger; nothing here sends money.
// An administrator pays outside the platform (UPI app, exchange, wallet) and records the reference here.
import { h, toast, openModal, confirmDialog, fmtDateTime, qs } from '../js/util.js';
import { api, ApiError } from '../js/api.js';
import { chart } from '../js/charts.js';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inrK = (n) => (n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : n >= 1000 ? `₹${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `₹${Math.round(n)}`);
const err = (e) => toast(e instanceof ApiError ? e.message : String(e?.message || e), 'bad');
const stat = (label, value, sub) => h('div', { class: 'stat' }, h('span', null, label), h('b', null, value), sub ? h('small', { class: 'muted' }, sub) : null);
const panel = (title, ...kids) => h('section', { class: 'panel' }, h('h3', null, title), ...kids);
const pill = (s) => h('span', { class: `status ${s}` }, String(s).replace(/_/g, ' '));
const MID = '·';

const TABS = [['overview', 'Overview'], ['eligibility', 'Eligibility'], ['methods', 'Payment methods'], ['batches', 'Monthly batches'],
  ['payouts', 'Payouts'], ['adjustments', 'Adjustments'], ['reconciliation', 'Reconciliation'], ['rates', 'Rates & rules']];

function table(cols, rows) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: cols.length, style: 'text-align:center;color:var(--text-2);padding:28px' }, 'Nothing to show.')))));
}
const pager = (res, go) => h('div', { class: 'pager' },
  h('button', { class: 'btn sm', disabled: !res.page, onclick: () => go(res.page - 1) }, 'Previous'),
  h('span', { class: 'muted small', style: 'align-self:center' }, `Page ${res.page + 1}`),
  h('button', { class: 'btn sm', disabled: !res.has_more, onclick: () => go(res.page + 1) }, 'Next'));

/** A small form dialog. fields: [{ key, label, type, required, value, hint, options }]. Resolves with an object or null. */
function formDialog({ title, text, fields, submit = 'Save', danger = false }) {
  return openModal((box, close) => {
    const els = {};
    const errEl = h('div', { class: 'err', hidden: true });
    const rows = fields.map((f) => {
      const el = f.options
        ? h('select', { class: 'select' }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
        : f.type === 'textarea' ? h('textarea', { class: 'textarea', maxlength: 500 })
          : h('input', { class: 'input', type: f.type || 'text', step: f.type === 'number' ? 'any' : undefined, maxlength: 200 });
      if (f.value !== undefined && !f.options) el.value = f.value;
      els[f.key] = el;
      return h('div', { class: 'field' }, h('label', null, f.label), el, f.hint ? h('div', { class: 'hint' }, f.hint) : null);
    });
    box.append(h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null, ...rows, errEl,
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => {
          const out = {};
          for (const f of fields) {
            const raw = els[f.key].value.trim();
            if (f.required && !raw) { errEl.textContent = `${f.label} is required`; errEl.hidden = false; return; }
            if (raw !== '') out[f.key] = f.type === 'number' ? Number(raw) : raw;
          }
          close(out);
        } }, submit)));
  });
}

async function run(fn, ok, after) { try { await fn(); if (ok) toast(ok); await after?.(); } catch (e) { err(e); } }

// ---------------------------------------------------------------------------
async function overview(body) {
  const s = await api.get('/api/admin/payments/summary');
  const c = s.cards;
  body.append(
    h('div', { class: 'stat-grid' },
      stat('Pending approval', inr(c.pending), 'Waiting out the review window'),
      stat('Payable now', inr(c.approved_unpaid + c.adjustments_unpaid), `${s.eligible.channels} creator(s) at or above ${inr(s.min_payout)}`),
      stat('In payouts', inr(c.in_flight), 'Eligible, approved or processing'),
      stat('On hold', inr(c.on_hold)),
      stat('Failed', inr(c.failed), 'Needs a retry or cancel'),
      stat('Paid this month', inr(c.paid_this_month)),
      stat('Paid to date', inr(c.paid_total)),
      stat('Methods to review', String(c.methods_pending), 'Waiting for verification')),
    h('p', { class: 'muted small', style: 'margin:10px 0' }, `Next scheduled payout date: ${s.next_payout_date}. Minimum payout ${inr(s.min_payout)}; smaller balances are carried forward.`),
    panel('Paid per month (last 12 months)', s.monthly.length
      ? chart({ type: 'bar', labels: s.monthly.map((x) => x.month.slice(2)), series: [{ name: 'Paid', color: '#6bd08a', values: s.monthly.map((x) => x.amount) }], fmt: inrK })
      : h('p', { class: 'muted' }, 'No payouts have been marked paid yet.')),
    panel('Creator earnings per day (last 30 days)', s.daily.length
      ? chart({ type: 'bar', stacked: true, labels: s.daily.map((x) => x.day.slice(5)), series: [
        { name: 'Shorts', color: '#ff5a5f', values: s.daily.map((x) => x.short) }, { name: 'Long videos', color: '#5aa9ff', values: s.daily.map((x) => x.long) }], fmt: inrK })
      : h('p', { class: 'muted' }, 'No earnings recorded yet.')),
    h('div', { class: 'two-col' },
      panel('Payouts by status', table([{ label: 'Status' }, { label: 'Count', num: 1 }, { label: 'Amount', num: 1 }],
        s.by_status.map((x) => h('tr', null, h('td', null, pill(x.status)), h('td', { class: 'num' }, x.n), h('td', { class: 'num' }, inr(x.amount)))))),
      panel('Paid by method', table([{ label: 'Method' }, { label: 'Payouts', num: 1 }, { label: 'Amount', num: 1 }],
        s.by_method.map((x) => h('tr', null, h('td', null, x.method.replace(':', ' ').toUpperCase()), h('td', { class: 'num' }, x.n), h('td', { class: 'num' }, inr(x.amount))))))),
    panel('Top paid creators', table([{ label: 'Creator' }, { label: 'Paid', num: 1 }],
      s.top_creators.map((x) => h('tr', null, h('td', null, `${x.name} `, h('span', { class: 'muted' }, `@${x.handle}`)), h('td', { class: 'num' }, inr(x.amount)))))));
}

// ---------------------------------------------------------------------------
async function eligibility(body) {
  const st = { page: 0, filter: 'all', q: '' };
  const list = h('div');
  const q = h('input', { class: 'input', placeholder: 'Search creator', style: 'max-width:220px' });
  const f = h('select', { class: 'select', style: 'max-width:200px' }, [['all', 'All with a balance'], ['eligible', 'At or above minimum'], ['below', 'Below minimum (carried forward)'], ['no_method', 'No verified method']].map(([v, l]) => h('option', { value: v }, l)));
  async function load() {
    const d = await api.get('/api/admin/payments/eligibility' + qs({ page: st.page, filter: st.filter, q: st.q }));
    list.replaceChildren(table([{ label: 'Creator' }, { label: 'Payable', num: 1 }, { label: 'Pending', num: 1 }, { label: 'Default method' }, { label: 'Status' }],
      d.items.map((x) => h('tr', null,
        h('td', null, x.name, ' ', h('span', { class: 'muted' }, `@${x.handle}`)),
        h('td', { class: 'num' }, inr(x.payable)), h('td', { class: 'num' }, inr(x.pending)),
        h('td', null, x.method_masked ? `${x.method_masked} ` : h('span', { class: 'muted' }, 'None'), x.method_status ? pill(x.method_status) : null),
        h('td', null, x.meets_minimum ? pill('approved') : h('span', { class: 'muted small' }, `Carried forward (min ${inr(d.min_payout)})`))))), pager(d, (p) => { st.page = p; load(); }));
  }
  f.onchange = () => { st.filter = f.value; st.page = 0; load(); };
  q.onchange = () => { st.q = q.value.trim(); st.page = 0; load(); };
  body.append(h('div', { class: 'row wrap', style: 'gap:8px;margin-bottom:10px' }, q, f), list);
  await load();
}

// ---------------------------------------------------------------------------
async function reveal(m) {
  try {
    const d = await api.post(`/api/admin/payments/methods/${m.id}/reveal`);
    await openModal((box, close) => {
      box.append(h('h3', null, 'Payment account'),
        h('p', { class: 'muted small' }, 'Viewing this is recorded in the audit log.'),
        h('div', { class: 'field' }, h('label', null, 'Account holder'), h('div', null, d.holder_name)),
        h('div', { class: 'field' }, h('label', null, d.type === 'upi' ? 'UPI ID' : `${(d.asset || '').toUpperCase()} address (${d.network})`),
          h('code', { style: 'word-break:break-all;display:block;padding:8px;background:var(--bg-2);border-radius:8px' }, d.identifier)),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(d.identifier); toast('Copied'); } catch { toast('Copy failed', 'bad'); } } }, 'Copy'),
          h('button', { class: 'btn primary', onclick: () => close(true) }, 'Done')));
    });
  } catch (e) { err(e); }
}

async function methods(body) {
  const st = { page: 0, status: 'pending' };
  const list = h('div');
  const sel = h('select', { class: 'select', style: 'max-width:220px' }, [['pending', 'Waiting for review'], ['verified', 'Verified'], ['changes_requested', 'Changes requested'], ['rejected', 'Rejected']].map(([v, l]) => h('option', { value: v }, l)));
  const review = (m, action) => async () => {
    let reason = '';
    if (action !== 'verify') {
      const r = await confirmDialog({ title: action === 'reject' ? 'Reject this method?' : 'Ask for changes', text: 'The creator will see this reason.', confirmText: 'Send',
        ask: { label: 'Reason', multiline: true, required: true, min: 3, requiredMessage: 'Please give a short reason.' } });
      if (!r) return;
      reason = r === true ? '' : r;
    }
    run(() => api.post(`/api/admin/payments/methods/${m.id}/review`, { action, reason }), 'Updated', load);
  };
  async function load() {
    const d = await api.get('/api/admin/payments/methods' + qs({ page: st.page, status: st.status }));
    list.replaceChildren(table([{ label: 'Creator' }, { label: 'Method' }, { label: 'Holder' }, { label: 'Submitted' }, { label: '' }],
      d.items.map((m) => h('tr', null,
        h('td', null, m.channel_name, ' ', h('span', { class: 'muted' }, `@${m.handle}`)),
        h('td', null, m.type === 'upi' ? 'UPI' : `${m.asset.toUpperCase()} ${MID} ${m.network}`, h('div', { class: 'muted small' }, m.masked)),
        h('td', null, m.holder_name), h('td', { class: 'muted small' }, fmtDateTime(m.created_at)),
        h('td', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
          h('button', { class: 'btn sm', onclick: () => reveal(m) }, 'Show account'),
          m.status !== 'verified' ? h('button', { class: 'btn primary sm', onclick: review(m, 'verify') }, 'Verify') : null,
          m.status === 'pending' || m.status === 'verified' ? h('button', { class: 'btn sm', onclick: review(m, 'request_changes') }, 'Request changes') : null,
          m.status !== 'rejected' ? h('button', { class: 'btn danger sm', onclick: review(m, 'reject') }, 'Reject') : null)))), pager(d, (p) => { st.page = p; load(); }));
  }
  sel.onchange = () => { st.status = sel.value; st.page = 0; load(); };
  body.append(h('div', { style: 'margin-bottom:10px' }, sel), h('p', { class: 'muted small', style: 'margin-bottom:10px' }, 'Check the account holder and, for crypto, the network before verifying. Payouts are only approved to verified methods.'), list);
  await load();
}

// ---------------------------------------------------------------------------
function payoutActions(p, after) {
  const btn = (label, cls, fn) => h('button', { class: `btn ${cls} sm`, onclick: fn }, label);
  const post = (to, extra = {}, ok = 'Updated') => run(() => api.post(`/api/admin/payments/payouts/${p.id}/transition`, { to, ...extra }), ok, after);
  const reasonFlow = (to, title, danger) => async () => {
    const r = await confirmDialog({ title, text: `${p.channel_name} ${MID} ${inr(p.amount)}`, confirmText: 'Confirm', danger,
      ask: { label: 'Reason', multiline: true, required: true, min: 3, requiredMessage: 'Please give a short reason.' } });
    if (r) post(to, { reason: r === true ? '' : r });
  };
  const out = [];
  if (p.method_type) out.push(btn('Show account', '', () => reveal({ id: p.method_id })));
  const nx = p.next || [];
  if (nx.includes('approved')) out.push(btn(p.status === 'failed' ? 'Retry' : 'Approve', 'primary', async () => {
    if (await confirmDialog({ title: 'Approve payout?', text: `${inr(p.amount)} to ${p.channel_name} (${p.method_masked || 'no method'}).`, confirmText: 'Approve' })) post('approved');
  }));
  if (nx.includes('eligible')) out.push(btn('Release hold', '', () => post('eligible')));
  if (nx.includes('processing')) out.push(btn('Mark processing', '', async () => {
    if (await confirmDialog({ title: 'Mark as processing?', text: 'Use this once you have started the transfer outside the platform.', confirmText: 'Yes, started' })) post('processing');
  }));
  if (nx.includes('paid')) out.push(btn('Record payment', 'primary', async () => {
    const crypto = p.method_type === 'crypto';
    const v = await formDialog({
      title: 'Record payment', text: `${inr(p.amount)} to ${p.channel_name}. Only record this after the transfer has really been made.`, submit: 'Mark paid',
      fields: crypto ? [
        { key: 'tx_hash', label: 'Transaction hash', required: true },
        { key: 'tx_network', label: 'Network', required: true, value: p.method_network || '', options: [['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum (ERC20)'], ['tron', 'Tron (TRC20)'], ['bsc', 'BNB Smart Chain (BEP20)']] },
        { key: 'paid_currency', label: 'Coin sent', value: (p.method_asset || '').toUpperCase() },
        { key: 'paid_amount', label: 'Amount sent', type: 'number' },
        { key: 'exchange_rate', label: 'INR per coin at payment time', type: 'number' },
        { key: 'fees', label: 'Fees (INR)', type: 'number' },
      ] : [
        { key: 'transaction_ref', label: 'UPI reference / UTR', required: true },
        { key: 'fees', label: 'Fees (INR)', type: 'number' },
      ],
    });
    if (v) post('paid', v, 'Marked paid');
  }));
  if (nx.includes('failed')) out.push(btn('Mark failed', '', reasonFlow('failed', 'Mark as failed?', true)));
  if (nx.includes('on_hold')) out.push(btn('Hold', '', reasonFlow('on_hold', 'Put on hold?')));
  if (nx.includes('cancelled')) out.push(btn('Cancel', 'danger', reasonFlow('cancelled', 'Cancel this payout? The money returns to the creator’s balance.', true)));
  return h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, out);
}

function payoutRows(items, after) {
  return items.map((p) => h('tr', null,
    h('td', null, p.channel_name, ' ', h('span', { class: 'muted' }, `@${p.handle}`)),
    h('td', { class: 'num' }, inr(p.amount)),
    h('td', null, pill(p.status), p.failure_reason || p.hold_reason ? h('div', { class: 'muted small' }, p.failure_reason || p.hold_reason) : null),
    h('td', null, p.method_masked ? [p.method_type === 'crypto' ? `${(p.method_asset || '').toUpperCase()} ${MID} ` : 'UPI ', h('span', { class: 'muted' }, p.method_masked)] : h('span', { class: 'muted' }, 'No method'),
      p.method_status && p.method_status !== 'verified' ? h('div', null, pill(p.method_status)) : null),
    h('td', { class: 'muted small' }, p.transaction_ref || p.tx_hash || '', p.paid_at ? h('div', null, fmtDateTime(p.paid_at)) : null),
    h('td', null, payoutActions(p, after))));
}
const PAYOUT_COLS = [{ label: 'Creator' }, { label: 'Amount', num: 1 }, { label: 'Status' }, { label: 'Method' }, { label: 'Reference' }, { label: '' }];

async function batches(body, sub) {
  if (sub) return batchDetail(body, sub);
  const st = { page: 0 };
  const list = h('div');
  const build = async () => {
    const v = await formDialog({ title: 'Build a payout batch', submit: 'Build batch',
      text: 'Collects every creator whose approved balance has reached the minimum. Smaller balances are carried forward. This does not pay anyone.',
      fields: [{ key: 'period_start', label: 'Earning month (first day, e.g. 2026-09-01) — leave empty for the previous month', hint: 'Weekend payout dates move to the next business day.' }] });
    if (!v) return;
    try {
      const d = await api.post('/api/admin/payments/batches', v.period_start ? { period_start: v.period_start } : {});
      toast(`Batch built: ${d.batch.payout_count} payout(s), ${inr(d.batch.total_amount)}`);
      location.hash = `#/payments/batches/${d.batch.id}`;
    } catch (e) { err(e); }
  };
  async function load() {
    const d = await api.get('/api/admin/payments/batches' + qs({ page: st.page }));
    list.replaceChildren(table([{ label: 'Earning month' }, { label: 'Pay date' }, { label: 'Status' }, { label: 'Payouts', num: 1 }, { label: 'Total', num: 1 }, { label: 'Carried forward', num: 1 }, { label: '' }],
      d.items.map((b) => h('tr', null,
        h('td', null, `${String(b.period_start).slice(0, 10)} → ${String(b.period_end).slice(0, 10)}`), h('td', null, String(b.scheduled_for).slice(0, 10)), h('td', null, pill(b.status)),
        h('td', { class: 'num' }, `${b.paid_count}/${b.payout_count}`), h('td', { class: 'num' }, inr(b.total_amount)),
        h('td', { class: 'num' }, `${b.carried_count} ${MID} ${inr(b.carried_amount)}`),
        h('td', null, h('a', { class: 'btn sm', href: `#/payments/batches/${b.id}` }, 'Open'))))), pager(d, (p) => { st.page = p; load(); }));
  }
  body.append(h('div', { style: 'margin-bottom:10px' }, h('button', { class: 'btn primary', onclick: build }, 'Build batch')), list);
  await load();
}

async function batchDetail(body, id) {
  const wrap = h('div');
  async function load() {
    const d = await api.get(`/api/admin/payments/batches/${id}`);
    const b = d.batch;
    const canApprove = d.payouts.some((p) => p.status === 'eligible');
    wrap.replaceChildren(
      h('a', { href: '#/payments/batches', class: 'muted small' }, '← All batches'),
      h('div', { class: 'stat-grid', style: 'margin:10px 0' },
        stat('Earning month', String(b.period_start).slice(0, 7)), stat('Pay date', String(b.scheduled_for).slice(0, 10)),
        stat('Status', b.status.replace(/_/g, ' ')), stat('Total', inr(b.total_amount), `${b.payout_count} payout(s)`),
        stat('Carried forward', inr(b.carried_amount), `${b.carried_count} creator(s) under ${inr(b.min_payout)}`)),
      h('div', { class: 'row wrap', style: 'gap:8px;margin-bottom:10px' },
        canApprove ? h('button', { class: 'btn primary', onclick: async () => {
          if (!await confirmDialog({ title: 'Approve this batch?', text: 'Approves every payout whose creator has a verified payment method. Others are skipped and listed.', confirmText: 'Approve all' })) return;
          try {
            const r = await api.post(`/api/admin/payments/batches/${id}/approve`, { confirm: true });
            toast(`${r.approved} approved${r.skipped.length ? `, ${r.skipped.length} skipped (no verified method)` : ''}`); load();
          } catch (e) { err(e); }
        } }, 'Approve batch') : null,
        h('a', { class: 'btn', href: `/api/admin/payments/export/payouts.csv${qs({ })}`, download: '' }, 'Export all payouts (CSV)'),
        ['review', 'approved', 'processing'].includes(b.status) ? h('button', { class: 'btn danger', onclick: async () => {
          if (await confirmDialog({ title: 'Cancel this batch?', text: 'Every unpaid payout is cancelled and its money returns to the creators’ balances.', confirmText: 'Cancel batch', danger: true })) {
            run(() => api.post(`/api/admin/payments/batches/${id}/cancel`, { confirm: true }), 'Batch cancelled', load);
          }
        } }, 'Cancel batch') : null),
      table(PAYOUT_COLS, payoutRows(d.payouts, load)));
  }
  body.append(wrap);
  await load();
}

async function payouts(body) {
  const st = { page: 0, status: '', q: '' };
  const list = h('div');
  const sel = h('select', { class: 'select', style: 'max-width:180px' }, [['', 'All statuses'], ...['eligible', 'approved', 'processing', 'paid', 'failed', 'on_hold', 'cancelled'].map((s) => [s, s.replace('_', ' ')])].map(([v, l]) => h('option', { value: v }, l)));
  const q = h('input', { class: 'input', placeholder: 'Search creator', style: 'max-width:220px' });
  async function load() {
    const d = await api.get('/api/admin/payments/payouts' + qs({ page: st.page, status: st.status, q: st.q }));
    list.replaceChildren(table(PAYOUT_COLS, payoutRows(d.items, load)), pager(d, (p) => { st.page = p; load(); }));
  }
  sel.onchange = () => { st.status = sel.value; st.page = 0; load(); };
  q.onchange = () => { st.q = q.value.trim(); st.page = 0; load(); };
  body.append(h('div', { class: 'row wrap', style: 'gap:8px;margin-bottom:10px' }, sel, q,
    h('a', { class: 'btn', href: '/api/admin/payments/export/payouts.csv', download: '' }, 'Export payouts (CSV)'),
    h('a', { class: 'btn', href: '/api/admin/payments/export/earnings.csv', download: '' }, 'Export last 30 days of earnings (CSV)')), list);
  await load();
}

// ---------------------------------------------------------------------------
async function adjustments(body) {
  const st = { page: 0 };
  const list = h('div');
  const add = async () => {
    const v = await formDialog({ title: 'Manual adjustment', submit: 'Add adjustment',
      text: 'Adds to (positive) or takes from (negative) a creator’s payable balance. It is recorded with your name and reason.',
      fields: [{ key: 'channel_id', label: 'Channel ID', required: true, hint: 'Copy it from the Eligibility or Payouts list URL / audit log.' },
        { key: 'amount', label: 'Amount in ₹ (negative to deduct)', type: 'number', required: true },
        { key: 'reason', label: 'Reason', type: 'textarea', required: true }] });
    if (v) run(() => api.post('/api/admin/payments/adjustments', v), 'Adjustment added', load);
  };
  async function load() {
    const d = await api.get('/api/admin/payments/adjustments' + qs({ page: st.page }));
    list.replaceChildren(table([{ label: 'When' }, { label: 'Creator' }, { label: 'Amount', num: 1 }, { label: 'Reason' }, { label: 'By' }, { label: 'Status' }],
      d.items.map((a) => h('tr', null, h('td', { class: 'muted small' }, fmtDateTime(a.created_at)), h('td', null, a.channel_name, ' ', h('span', { class: 'muted' }, `@${a.handle}`)),
        h('td', { class: 'num' }, inr(a.amount)), h('td', null, a.reason), h('td', { class: 'muted small' }, a.by_name || ''),
        h('td', null, a.payout_id ? pill('paid') : pill('pending'))))), pager(d, (p) => { st.page = p; load(); }));
  }
  body.append(h('div', { style: 'margin-bottom:10px' }, h('button', { class: 'btn primary', onclick: add }, 'New adjustment')), list);
  await load();
}

async function reconciliation(body) {
  const d = await api.get('/api/admin/payments/reconciliation');
  const t = d.totals;
  body.append(
    h('div', { class: 'panel', style: `border-color:${d.balanced ? '#1f3a25' : '#4a2224'}` },
      h('b', null, d.balanced ? 'The books balance.' : 'Something does not add up — review the items below.'),
      h('p', { class: 'muted small' }, `Unexplained difference: ${inr(d.unexplained)}`)),
    h('div', { class: 'stat-grid', style: 'margin:12px 0' },
      stat('Ledger earnings', inr(t.ledger_earnings)), stat('Adjustments', inr(t.adjustments)), stat('In payouts (not cancelled)', inr(t.payouts_total)),
      stat('Approved, not yet in a payout', inr(t.unpaid_approved)), stat('Pending approval', inr(t.pending)), stat('Adjustments not yet paid', inr(t.unpaid_adjustments))),
    panel('Payouts that differ from their ledger entries', table([{ label: 'Creator' }, { label: 'Status' }, { label: 'Payout', num: 1 }, { label: 'Ledger total', num: 1 }],
      d.mismatches.map((x) => h('tr', null, h('td', null, x.channel_name), h('td', null, pill(x.status)), h('td', { class: 'num' }, inr(x.amount)), h('td', { class: 'num' }, inr(x.attached)))))),
    panel('Paid without a reference', table([{ label: 'Creator' }, { label: 'Amount', num: 1 }],
      d.paid_without_reference.map((x) => h('tr', null, h('td', null, x.channel_name), h('td', { class: 'num' }, inr(x.amount)))))));
}

// ---------------------------------------------------------------------------
async function rates(body) {
  const [{ items, monetization: m }] = [await api.get('/api/admin/payments/rates')];
  const num = (v, props = {}) => h('input', { class: 'input', type: 'number', value: v, step: 'any', ...props });
  const check = (v) => { const i = h('input', { type: 'checkbox' }); i.checked = !!v; return i; };
  const f = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
  const e = {
    rate_short_per_1000: num(m.rate_short_per_1000, { min: 0 }), rate_long_per_1000: num(m.rate_long_per_1000, { min: 0 }),
    min_payout: num(m.min_payout, { min: 1 }), payout_day: num(m.payout_day, { min: 1, max: 28, step: 1 }), approval_delay_days: num(m.approval_delay_days, { min: 0, max: 60, step: 1 }),
    dedupe_hours: num(m.dedupe_hours, { min: 0.25 }), max_views_per_actor_per_day: num(m.max_views_per_actor_per_day, { min: 1, step: 1 }),
    max_actors_per_ip_per_day: num(m.max_actors_per_ip_per_day, { min: 1, step: 1 }), client_view_delay_seconds: num(m.client_view_delay_seconds, { min: 0 }),
  };
  const enabled = check(m.enabled), auto = check(m.auto_approve);
  const save = h('button', { class: 'btn primary', style: 'margin-top:10px', onclick: async () => {
    const value = Object.fromEntries(Object.entries(e).map(([k, el]) => [k, Number(el.value)]));
    value.enabled = enabled.checked; value.auto_approve = auto.checked;
    if (!await confirmDialog({ title: 'Save monetization settings?', text: 'New rates apply to views from now on. Earnings already recorded keep the rate they were earned at.', confirmText: 'Save' })) return;
    run(() => api.put('/api/admin/settings/monetization', { value }), 'Saved', () => { body.replaceChildren(); rates(body); });
  } }, 'Save');
  body.append(
    panel('Rates and payout rules',
      h('div', { class: 'setting-grid' },
        f('Shorts: ₹ per 1,000 eligible views', e.rate_short_per_1000, '₹2 per 1,000 = ₹10 per 5,000 views'),
        f('Long videos: ₹ per 1,000 eligible views', e.rate_long_per_1000),
        f('Minimum payout (₹)', e.min_payout), f('Payout day of month (1–28)', e.payout_day, 'Weekends move to the next business day'),
        f('Approval delay (days)', e.approval_delay_days, 'Time to spot abuse before earnings become payable')),
      h('label', { class: 'toggle' }, enabled, 'Monetization enabled'),
      h('label', { class: 'toggle' }, auto, 'Approve earnings automatically after the delay')),
    panel('View eligibility policy',
      h('p', { class: 'muted small', style: 'margin-bottom:10px' }, 'A view earns money only once per viewer per window, after a minimum watch delay, and within the per-viewer and per-network daily limits. Invalid activity is excluded from earnings (not deleted).'),
      h('div', { class: 'setting-grid' },
        f('One paid view per viewer every (hours)', e.dedupe_hours), f('Seconds watched before a view counts', e.client_view_delay_seconds),
        f('Max paid views per viewer per day', e.max_views_per_actor_per_day), f('Max distinct viewers per network per day', e.max_actors_per_ip_per_day)),
      save),
    panel('Rate history', table([{ label: 'Effective from' }, { label: 'Kind' }, { label: '₹ per 1,000', num: 1 }, { label: 'Changed by' }, { label: 'Note' }],
      items.map((r) => h('tr', null, h('td', { class: 'muted small' }, fmtDateTime(r.effective_from)), h('td', null, r.kind), h('td', { class: 'num' }, inr(r.rate_per_1000)), h('td', null, r.changed_by_name || 'System'), h('td', { class: 'muted small' }, r.note || ''))))));
}

// ---------------------------------------------------------------------------
const VIEWS = { overview, eligibility, methods, batches, payouts, adjustments, reconciliation, rates };

export async function paymentsPage(sub, id) {
  const tab = VIEWS[sub] ? sub : 'overview';
  const body = h('div');
  const root = h('div', null,
    h('nav', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `#/payments/${k}`, class: k === tab ? 'on' : '' }, l))),
    body);
  queueMicrotask(async () => {
    try { await VIEWS[tab](body, id); } catch (e) { body.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'Could not load this section'), h('p', null, e.message))); }
  });
  return root;
}
