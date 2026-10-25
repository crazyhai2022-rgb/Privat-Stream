// Creator-facing earnings and payment settings. Everything is scoped to the caller's own
// channel; no endpoint accepts a channel id from the client.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { wrap, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { requireAuth } from '../middleware/core.js';
import { balanceFor, round2, toMoney, formatINR, withdrawalBlocker, requestWithdrawal } from '../services/earnings.js';
import { getSetting } from '../services/settings.js';
import { addMethod, listMethods, methodDto, CRYPTO_OPTIONS } from '../services/paymentMethods.js';
import { audit } from '../services/audit.js';

const r = Router();

async function myChannel(req) {
  const ch = await db.one('select id, status, name, handle from channels where user_id = $1', [req.user.id]);
  if (!ch) throw forbidden('Create a channel first', 'no_channel');
  return ch;
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({
  range: z.enum(['7', '30', '90', 'custom']).default('30'),
  from: isoDay.optional(),
  to: isoDay.optional(),
});

/** Resolves a range filter to inclusive [from, to] days, capped at one year. */
export function resolveRange(query, now = new Date()) {
  const q = rangeQuery.parse(query);
  const today = now.toISOString().slice(0, 10);
  const shift = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  let from, to = today;
  if (q.range === 'custom') {
    if (!q.from || !q.to) throw badRequest('Choose a start and end date');
    from = q.from; to = q.to;
    if (from > to) throw badRequest('The start date must be before the end date');
    if (to > today) to = today;
    if ((new Date(to) - new Date(from)) / 86400000 > 366) throw badRequest('Pick a range of one year or less');
  } else {
    from = shift(today, -(Number(q.range) - 1));
  }
  return { from, to };
}

const fillDays = (from, to, byDay, blank) => {
  const out = [];
  for (let d = from; d <= to; d = new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)) {
    out.push({ day: d, ...blank, ...(byDay.get(d) || {}) });
  }
  return out;
};

async function conversion(amountInr) {
  const c = await getSetting('currency');
  const out = { INR: round2(amountInr) };
  if (c.usd_per_inr > 0 && c.display.includes('USD')) out.USD = round2(amountInr * c.usd_per_inr);
  return { amounts: out, estimated: true, rates_updated_at: c.rates_updated_at || null };
}

r.get('/me/earnings', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const m = await getSetting('monetization');
  const bal = await balanceFor(ch.id);
  const [last] = await db.query(
    `select amount, paid_at, status from payouts where channel_id = $1 and status = 'paid' order by paid_at desc limit 1`, [ch.id]);
  const today = new Date().toISOString().slice(0, 10);
  const [t] = await db.query(
    `select coalesce(sum(eligible_views),0)::int as views, coalesce(sum(amount),0) as amount
       from earning_entries where channel_id = $1 and day >= $2::date - 29`, [ch.id, today]);
  res.json({
    channel: { id: ch.id, name: ch.name, handle: ch.handle, status: ch.status },
    monetization_enabled: m.enabled,
    rates: { short_per_1000: Number(m.rate_short_per_1000), long_per_1000: Number(m.rate_long_per_1000) },
    balance: bal,
    last_payout: last ? { amount: toMoney(last.amount), paid_at: last.paid_at } : null,
    last_30_days: { eligible_views: t?.views || 0, estimated: round2(t?.amount || 0) },
    converted: await conversion(bal.payable),
    note: 'Earnings are estimates until approved. Only eligible views count; see the earnings policy.',
  });
}));

r.get('/me/earnings/chart', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const { from, to } = resolveRange(req.query);

  const daily = await db.query(
    `select day::text as day,
            sum(eligible_views)::int as eligible_views,
            sum(amount) as estimated,
            coalesce(sum(amount) filter (where status = 'approved'), 0) as approved,
            coalesce(sum(eligible_views) filter (where kind = 'short'), 0)::int as short_views,
            coalesce(sum(eligible_views) filter (where kind = 'long'), 0)::int as long_views
       from earning_entries
      where channel_id = $1 and day between $2::date and $3::date and status <> 'invalidated'
      group by day order by day`, [ch.id, from, to]);
  const byDay = new Map(daily.map((d) => [d.day, {
    eligible_views: d.eligible_views, estimated: round2(d.estimated), approved: round2(d.approved),
    short_views: d.short_views, long_views: d.long_views,
  }]));

  const monthly = await db.query(
    `select to_char(date_trunc('month', day), 'YYYY-MM') as month,
            sum(eligible_views)::int as eligible_views, sum(amount) as estimated,
            coalesce(sum(amount) filter (where status = 'approved'), 0) as approved
       from earning_entries
      where channel_id = $1 and day >= (date_trunc('month', $2::date) - interval '11 months')::date and status <> 'invalidated'
      group by 1 order by 1`, [ch.id, to]);
  const paid = await db.query(
    `select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month, sum(amount) as paid
       from payouts where channel_id = $1 and status = 'paid' group by 1 order by 1`, [ch.id]);

  res.json({
    from, to,
    daily: fillDays(from, to, byDay, { eligible_views: 0, estimated: 0, approved: 0, short_views: 0, long_views: 0 }),
    monthly: monthly.map((x) => ({ month: x.month, eligible_views: x.eligible_views, estimated: round2(x.estimated), approved: round2(x.approved) })),
    paid_monthly: paid.map((x) => ({ month: x.month, paid: round2(x.paid) })),
  });
}));

r.get('/me/earnings/videos', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const { from, to } = resolveRange(req.query);
  const rows = await db.query(
    `select v.public_id, v.title, v.kind, sum(e.eligible_views)::int as eligible_views, sum(e.amount) as estimated
       from earning_entries e join videos v on v.id = e.video_id
      where e.channel_id = $1 and e.day between $2::date and $3::date and e.status <> 'invalidated'
      group by v.id order by sum(e.amount) desc, v.title limit 10`, [ch.id, from, to]);
  res.json({ from, to, items: rows.map((x) => ({ ...x, estimated: round2(x.estimated) })) });
}));

r.get('/me/withdrawal', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const blocker = await withdrawalBlocker(ch.id);
  res.json({ can_request: !blocker, reason: blocker });
}));

r.post('/me/withdrawals', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const p = await requestWithdrawal(ch.id);
  await audit(req, 'withdrawal.request', 'payout', p.id, { amount: round2(p.amount), channel_id: ch.id });
  res.status(201).json({ payout: { id: p.id, amount: round2(p.amount), status: p.status } });
}));

r.get('/me/payouts', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const page = Math.max(1, Number(req.query.page) || 1), size = 20;
  const rows = await db.query(
    `select id, amount, currency, status, method_type, method_masked, method_asset, method_network,
            paid_at, transaction_ref, tx_hash, failure_reason, hold_reason, created_at, source
       from payouts where channel_id = $1 order by created_at desc limit $2 offset $3`, [ch.id, size, (page - 1) * size]);
  const [{ n }] = await db.query('select count(*)::int as n from payouts where channel_id = $1', [ch.id]);
  res.json({
    page, total: n,
    items: rows.map((p) => ({
      ...p, amount: round2(p.amount),
      // Creators see a plain status; internal workflow states are folded together.
      display_status: { eligible: 'Requested — waiting for approval', approved: 'Approved', processing: 'Processing', paid: 'Paid',
        failed: 'Failed — will be retried', on_hold: 'On hold', cancelled: 'Cancelled' }[p.status] || p.status,
    })),
  });
}));

// ---- Payment settings -----------------------------------------------------

r.get('/me/payment-methods', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const c = await getSetting('currency');
  res.json({ items: await listMethods(ch.id), crypto_options: CRYPTO_OPTIONS, base_currency: 'INR', display_currencies: c.display });
}));

const addSchema = z.object({
  type: z.enum(['upi', 'crypto']),
  holder_name: z.string().max(100),
  value: z.string().max(200),
  asset: z.enum(['btc', 'eth', 'usdt']).optional(),
  network: z.enum(['bitcoin', 'ethereum', 'tron', 'bsc']).optional(),
  network_confirmed: z.boolean().optional(),
});

r.post('/me/payment-methods', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  if (ch.status !== 'approved') throw forbidden('Payment settings open once your channel is approved', 'channel_not_approved');
  const row = await addMethod(ch.id, addSchema.parse(req.body));
  await audit(req, 'payment_method.added', 'payout_method', row.id, { type: row.type, asset: row.asset, network: row.network });
  res.status(201).json({ method: methodDto(row) });
}));

r.post('/me/payment-methods/:id/default', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  await db.tx(async (q) => {
    const [m] = await q('select id, status from payout_methods where id = $1 and channel_id = $2 for update', [req.params.id, ch.id]);
    if (!m) throw notFound('Payment method not found');
    if (m.status === 'rejected') throw conflict('A rejected method cannot be used. Add a corrected one.');
    await q('update payout_methods set is_default = false where channel_id = $1 and is_default', [ch.id]);
    await q('update payout_methods set is_default = true, updated_at = now() where id = $1', [m.id]);
  });
  await audit(req, 'payment_method.default', 'payout_method', req.params.id);
  res.json({ ok: true, items: await listMethods(ch.id) });
}));

r.delete('/me/payment-methods/:id', requireAuth, wrap(async (req, res) => {
  const ch = await myChannel(req);
  const [m] = await db.query('select id, is_default from payout_methods where id = $1 and channel_id = $2', [req.params.id, ch.id]);
  if (!m) throw notFound('Payment method not found');
  const [busy] = await db.query(
    `select 1 from payouts where method_id = $1 and status in ('approved','processing')`, [m.id]);
  if (busy) throw conflict('A payout using this method is being processed. Try again once it completes.');
  await db.query('delete from payout_methods where id = $1', [m.id]);
  await audit(req, 'payment_method.removed', 'payout_method', m.id);
  res.json({ ok: true, items: await listMethods(ch.id) });
}));

export default r;
