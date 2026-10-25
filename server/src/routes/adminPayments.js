// Super Admin "Creator Payments": eligibility, method verification, monthly batches, manual payouts,
// adjustments, exports and reconciliation. Nothing here moves money: an administrator pays outside
// the platform and records the reference, and a payout is never "paid" without one.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { wrap, badRequest, notFound } from '../lib/errors.js';
import { requireAdmin } from '../middleware/core.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { revealIdentifier, methodDto } from '../services/paymentMethods.js';
import { buildBatch, transitionPayout, PAYOUT_TRANSITIONS, rateHistory, nextPayoutDate, round2 } from '../services/earnings.js';

const r = Router();
r.use(requireAdmin('payments'));

const paging = (req, def = 25) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || def, 1), 100);
  const page = Math.max(Number(req.query.page) || 0, 0);
  return { limit, page, offset: page * limit };
};
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const num = (v) => Number(v ?? 0);
const money = (v) => round2(num(v));
const like = (s) => `%${String(s).replace(/[%_\\]/g, (m) => '\\' + m)}%`;

// ---------------- Summary + graphs (real ledger data only) ----------------
r.get('/summary', wrap(async (req, res) => {
  const m = await getSetting('monetization');
  const cards = await db.one(
    `select
       (select coalesce(sum(amount),0) from earning_entries where status = 'pending') as pending,
       (select coalesce(sum(amount),0) from earning_entries where status = 'approved' and payout_id is null) as approved_unpaid,
       (select coalesce(sum(amount),0) from payout_adjustments where payout_id is null) as adjustments_unpaid,
       (select coalesce(sum(amount),0) from payouts where status in ('eligible','approved','processing')) as in_flight,
       (select coalesce(sum(amount),0) from payouts where status = 'on_hold') as on_hold,
       (select coalesce(sum(amount),0) from payouts where status = 'failed') as failed,
       (select coalesce(sum(amount),0) from payouts where status = 'paid') as paid_total,
       (select coalesce(sum(amount),0) from payouts where status = 'paid' and paid_at >= date_trunc('month', now())) as paid_this_month,
       (select count(*)::int from payout_methods where status = 'pending') as methods_pending,
       (select count(*)::int from payouts where source = 'request' and status = 'eligible') as requests_waiting`);
  const eligible = await db.one(
    `select count(*)::int as n, coalesce(sum(p),0) as total from (
       select c.id, coalesce((select sum(amount) from earning_entries e where e.channel_id = c.id and e.status = 'approved' and e.payout_id is null),0)
            + coalesce((select sum(amount) from payout_adjustments a where a.channel_id = c.id and a.payout_id is null),0) as p
         from channels c) t where p >= $1`, [m.min_payout]);
  const monthly = await db.query(
    `select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month, sum(amount) as amount, count(*)::int as payouts
       from payouts where status = 'paid' and paid_at >= date_trunc('month', now()) - interval '11 months'
      group by 1 order by 1`);
  const daily = await db.query(
    `select day::text as day, sum(amount) filter (where kind = 'short') as short, sum(amount) filter (where kind = 'long') as long
       from earning_entries where status <> 'invalidated' and day >= current_date - 29 group by day order by day`);
  const byStatus = await db.query(`select status, count(*)::int as n, coalesce(sum(amount),0) as amount from payouts group by status`);
  const methods = await db.query(
    `select coalesce(method_type,'none') || coalesce(':' || method_asset,'') as method, count(*)::int as n, coalesce(sum(amount),0) as amount
       from payouts where status = 'paid' group by 1 order by 3 desc`);
  const top = await db.query(
    `select c.id as channel_id, c.name, c.handle, sum(p.amount) as amount from payouts p join channels c on c.id = p.channel_id
      where p.status = 'paid' group by c.id order by 4 desc limit 10`);
  res.json({
    currency: 'INR', min_payout: num(m.min_payout), next_payout_date: nextPayoutDate(m.payout_day),
    cards: Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, ['methods_pending', 'requests_waiting'].includes(k) ? v : money(v)])),
    eligible: { channels: eligible.n, amount: money(eligible.total) },
    monthly: monthly.map((x) => ({ ...x, amount: money(x.amount) })),
    daily: daily.map((x) => ({ day: x.day, short: money(x.short), long: money(x.long) })),
    by_status: byStatus.map((x) => ({ ...x, amount: money(x.amount) })),
    by_method: methods.map((x) => ({ ...x, amount: money(x.amount) })),
    top_creators: top.map((x) => ({ ...x, amount: money(x.amount) })),
  });
}));

// ---------------- Every creator's earnings ----------------
r.get('/creators', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const sort = { payable: 'payable', lifetime: 'lifetime', paid: 'paid', pending: 'pending' }[req.query.sort] || 'lifetime';
  const params = [];
  let q = '';
  if (req.query.q) { params.push(like(req.query.q)); q = `where c.name ilike $1 or c.handle ilike $1 or u.email ilike $1`; }
  params.push(limit + 1, offset);
  const rows = await db.query(
    `select c.id as channel_id, c.name, c.handle, c.status as channel_status, u.email,
            coalesce((select sum(amount) from earning_entries e where e.channel_id = c.id and e.status <> 'invalidated'),0) as lifetime,
            coalesce((select sum(amount) from earning_entries e where e.channel_id = c.id and e.status = 'pending'),0) as pending,
            coalesce((select sum(amount) from earning_entries e where e.channel_id = c.id and e.status = 'approved' and e.payout_id is null),0)
          + coalesce((select sum(amount) from payout_adjustments a where a.channel_id = c.id and a.payout_id is null),0) as payable,
            coalesce((select sum(amount) from payouts p where p.channel_id = c.id and p.status in ('eligible','approved','processing','on_hold')),0) as in_flight,
            coalesce((select sum(amount) from payouts p where p.channel_id = c.id and p.status = 'paid'),0) as paid,
            coalesce((select sum(eligible_views) from earning_entries e where e.channel_id = c.id and e.status <> 'invalidated'),0)::bigint as eligible_views,
            (select status from payout_methods pm where pm.channel_id = c.id and pm.is_default limit 1) as method_status
       from channels c join users u on u.id = c.user_id ${q}
      order by ${sort} desc, c.name limit $${params.length - 1} offset $${params.length}`, params);
  const m = await getSetting('monetization');
  res.json({
    items: rows.slice(0, limit).map((x) => ({ ...x, lifetime: money(x.lifetime), pending: money(x.pending), payable: money(x.payable), in_flight: money(x.in_flight),
      paid: money(x.paid), eligible_views: Number(x.eligible_views), meets_minimum: num(x.payable) >= num(m.min_payout) })),
    has_more: rows.length > limit, page, min_payout: num(m.min_payout),
  });
}));

// ---------------- Eligibility ----------------
r.get('/eligibility', wrap(async (req, res) => {
  const m = await getSetting('monetization');
  const { limit, offset, page } = paging(req);
  const params = [m.min_payout];
  let q = '';
  if (req.query.q) { params.push(like(req.query.q)); q = `and (name ilike $${params.length} or handle ilike $${params.length})`; }
  const filter = ['eligible', 'below', 'no_method'].includes(req.query.filter) ? req.query.filter : 'all';
  params.push(limit + 1, offset);
  const rows = await db.query(
    `select *, (payable >= $1::numeric) as meets from (
       select c.id as channel_id, c.name, c.handle, c.status as channel_status,
              coalesce((select sum(amount) from earning_entries e where e.channel_id = c.id and e.status = 'approved' and e.payout_id is null),0)
            + coalesce((select sum(amount) from payout_adjustments a where a.channel_id = c.id and a.payout_id is null),0) as payable,
              coalesce((select sum(amount) from earning_entries e where e.channel_id = c.id and e.status = 'pending'),0) as pending,
              (select status from payout_methods pm where pm.channel_id = c.id and pm.is_default limit 1) as method_status,
              (select masked from payout_methods pm where pm.channel_id = c.id and pm.is_default limit 1) as method_masked
         from channels c) t
      where payable > 0 ${q}
        ${filter === 'eligible' ? 'and payable >= $1::numeric' : filter === 'below' ? 'and payable < $1::numeric' : filter === 'no_method' ? `and (method_status is null or method_status <> 'verified')` : ''}
      order by payable desc limit $${params.length - 1} offset $${params.length}`, params);
  res.json({
    items: rows.slice(0, limit).map((x) => ({ ...x, payable: money(x.payable), pending: money(x.pending), meets_minimum: x.meets })),
    has_more: rows.length > limit, page, min_payout: num(m.min_payout),
  });
}));

// ---------------- Payout methods: review ----------------
r.get('/methods', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const status = ['pending', 'verified', 'rejected', 'changes_requested'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = await db.query(
    `select pm.*, c.name as channel_name, c.handle from payout_methods pm join channels c on c.id = pm.channel_id
      where pm.status = $1 order by pm.created_at limit $2 offset $3`, [status, limit + 1, offset]);
  res.json({ items: rows.slice(0, limit).map((x) => ({ ...methodDto(x), channel_id: x.channel_id, channel_name: x.channel_name, handle: x.handle })), has_more: rows.length > limit, page });
}));

r.post('/methods/:id/review', wrap(async (req, res) => {
  const b = z.object({
    action: z.enum(['verify', 'reject', 'request_changes']),
    reason: z.string().trim().max(500).optional().default(''),
  }).parse(req.body);
  if (b.action !== 'verify' && b.reason.length < 3) throw badRequest('Tell the creator why (at least 3 characters)');
  const status = { verify: 'verified', reject: 'rejected', request_changes: 'changes_requested' }[b.action];
  const row = await db.one(
    `update payout_methods set status = $2, status_reason = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now()
      where id = $1 returning *`, [req.params.id, status, b.reason || null, req.admin.id]);
  if (!row) throw notFound('Payment method not found');
  await audit(req, `payment_method.${b.action}`, 'payout_method', row.id, { channel_id: row.channel_id, reason: b.reason });
  res.json({ method: methodDto(row) });
}));

// Reveals the full account identifier so an administrator can pay it. Every reveal is audited.
r.post('/methods/:id/reveal', wrap(async (req, res) => {
  const row = await db.one('select * from payout_methods where id = $1', [req.params.id]);
  if (!row) throw notFound('Payment method not found');
  await audit(req, 'payment_method.reveal', 'payout_method', row.id, { channel_id: row.channel_id });
  res.set('Cache-Control', 'no-store');
  res.json({ identifier: revealIdentifier(row), holder_name: row.holder_name, type: row.type, asset: row.asset, network: row.network });
}));

// ---------------- Batches ----------------
r.get('/batches', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req, 12);
  const rows = await db.query(
    `select b.*, (select count(*)::int from payouts p where p.batch_id = b.id and p.status = 'paid') as paid_count
       from payout_batches b order by b.period_start desc limit $1 offset $2`, [limit + 1, offset]);
  res.json({ items: rows.slice(0, limit).map(batchDto), has_more: rows.length > limit, page });
}));

const batchDto = (b) => ({ ...b, total_amount: money(b.total_amount), carried_amount: money(b.carried_amount), min_payout: num(b.min_payout) });

r.post('/batches', wrap(async (req, res) => {
  const b = z.object({ period_start: z.string().optional() }).parse(req.body || {});
  if (b.period_start && !isDay(b.period_start)) throw badRequest('Period start must be a date (YYYY-MM-DD)');
  if (b.period_start && !b.period_start.endsWith('-01')) throw badRequest('A payout period starts on the 1st of a month');
  try {
    const batch = await buildBatch({ periodStart: b.period_start, adminId: req.admin.id });
    await audit(req, 'payout_batch.build', 'payout_batch', batch.id, { period_start: batch.period_start, payouts: batch.payout_count, total: batch.total_amount });
    res.status(201).json({ batch: batchDto(batch) });
  } catch (e) {
    if (e.code === 'batch_exists') throw Object.assign(badRequest(e.message), { status: 409 });
    throw e;
  }
}));

r.get('/batches/:id', wrap(async (req, res) => {
  const batch = await db.one('select * from payout_batches where id = $1', [req.params.id]);
  if (!batch) throw notFound('Batch not found');
  const rows = await db.query(
    `select p.*, c.name as channel_name, c.handle, pm.status as method_status
       from payouts p join channels c on c.id = p.channel_id left join payout_methods pm on pm.id = p.method_id
      where p.batch_id = $1 order by p.amount desc`, [batch.id]);
  res.json({ batch: batchDto(batch), payouts: rows.map(payoutDto) });
}));

async function syncBatch(batchId) {
  if (!batchId) return;
  const [s] = await db.query(
    `select count(*) filter (where status in ('eligible','on_hold','failed'))::int as open,
            count(*) filter (where status in ('approved','processing'))::int as active,
            count(*) filter (where status = 'paid')::int as paid
       from payouts where batch_id = $1`, [batchId]);
  const status = s.open === 0 && s.active === 0 ? (s.paid ? 'completed' : 'cancelled') : (s.active || s.paid ? 'processing' : null);
  if (status) await db.query(`update payout_batches set status = $2, completed_at = case when $2 = 'completed' then now() else completed_at end, updated_at = now()
                               where id = $1 and status in ('review','approved','processing')`, [batchId, status]);
}

// Approves every payout in the batch whose creator has a verified method; the rest are listed back.
r.post('/batches/:id/approve', wrap(async (req, res) => {
  if (req.body?.confirm !== true) throw badRequest('Please confirm this action', { code: 'confirmation_required' });
  const batch = await db.one('select * from payout_batches where id = $1', [req.params.id]);
  if (!batch) throw notFound('Batch not found');
  const rows = await db.query(
    `select p.id, p.channel_id, p.status, pm.status as method_status from payouts p
       left join payout_methods pm on pm.id = p.method_id where p.batch_id = $1 and p.status = 'eligible'`, [batch.id]);
  const approved = [], skipped = [];
  for (const p of rows) {
    if (p.method_status !== 'verified') { skipped.push({ payout_id: p.id, reason: 'No verified payment method' }); continue; }
    await transitionPayout(p.id, 'approved', { adminId: req.admin.id });
    approved.push(p.id);
  }
  if (approved.length) await db.query(`update payout_batches set status = 'approved', updated_at = now() where id = $1 and status = 'review'`, [batch.id]);
  await audit(req, 'payout_batch.approve', 'payout_batch', batch.id, { approved: approved.length, skipped: skipped.length });
  res.json({ approved: approved.length, skipped });
}));

r.post('/batches/:id/cancel', wrap(async (req, res) => {
  if (req.body?.confirm !== true) throw badRequest('Please confirm this action', { code: 'confirmation_required' });
  const batch = await db.one('select * from payout_batches where id = $1', [req.params.id]);
  if (!batch) throw notFound('Batch not found');
  const paid = await db.one(`select count(*)::int as n from payouts where batch_id = $1 and status in ('processing','paid')`, [batch.id]);
  if (paid.n) throw Object.assign(badRequest('This batch already has payouts in progress or paid, so it cannot be cancelled'), { status: 409 });
  const rows = await db.query(`select id from payouts where batch_id = $1 and status not in ('cancelled','paid')`, [batch.id]);
  for (const p of rows) await transitionPayout(p.id, 'cancelled', { adminId: req.admin.id });
  await db.query(`update payout_batches set status = 'cancelled', updated_at = now() where id = $1`, [batch.id]);
  await audit(req, 'payout_batch.cancel', 'payout_batch', batch.id, { payouts: rows.length });
  res.json({ ok: true, cancelled: rows.length });
}));

// ---------------- Payouts ----------------
const payoutDto = (p) => ({
  id: p.id, batch_id: p.batch_id, channel_id: p.channel_id, channel_name: p.channel_name, handle: p.handle,
  amount: money(p.amount), currency: p.currency, status: p.status, method_id: p.method_id, method_type: p.method_type,
  method_masked: p.method_masked, method_asset: p.method_asset, method_network: p.method_network,
  source: p.source, method_status: p.method_status || null, transaction_ref: p.transaction_ref, tx_hash: p.tx_hash, tx_network: p.tx_network,
  paid_currency: p.paid_currency, paid_amount: p.paid_amount === null || p.paid_amount === undefined ? null : num(p.paid_amount),
  exchange_rate: p.exchange_rate === null || p.exchange_rate === undefined ? null : num(p.exchange_rate), fees: money(p.fees),
  failure_reason: p.failure_reason, hold_reason: p.hold_reason, note: p.note, paid_at: p.paid_at, created_at: p.created_at,
  next: PAYOUT_TRANSITIONS[p.status] || [],
});

r.get('/payouts', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const params = [];
  const where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`p.status = $${params.length}`); }
  if (req.query.source === 'request') where.push(`p.source = 'request'`);
  if (req.query.q) { params.push(like(req.query.q)); where.push(`(c.name ilike $${params.length} or c.handle ilike $${params.length})`); }
  if (isDay(req.query.from)) { params.push(req.query.from); where.push(`p.created_at >= $${params.length}::date`); }
  if (isDay(req.query.to)) { params.push(req.query.to); where.push(`p.created_at < $${params.length}::date + 1`); }
  params.push(limit + 1, offset);
  const rows = await db.query(
    `select p.*, c.name as channel_name, c.handle, pm.status as method_status
       from payouts p join channels c on c.id = p.channel_id left join payout_methods pm on pm.id = p.method_id
      ${where.length ? 'where ' + where.join(' and ') : ''} order by p.created_at desc limit $${params.length - 1} offset $${params.length}`, params);
  res.json({ items: rows.slice(0, limit).map(payoutDto), has_more: rows.length > limit, page });
}));

const transitionBody = z.object({
  to: z.enum(['approved', 'processing', 'paid', 'failed', 'on_hold', 'cancelled', 'eligible']),
  transaction_ref: z.string().trim().max(120).optional(),
  tx_hash: z.string().trim().max(200).optional(),
  tx_network: z.string().trim().max(40).optional(),
  paid_currency: z.string().trim().max(10).optional(),
  paid_amount: z.number().positive().optional(),
  exchange_rate: z.number().positive().optional(),
  fees: z.number().min(0).optional(),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).optional(),
});

r.post('/payouts/:id/transition', wrap(async (req, res) => {
  const b = transitionBody.parse(req.body);
  const p = await db.one(
    `select p.*, pm.status as method_status from payouts p left join payout_methods pm on pm.id = p.method_id where p.id = $1`, [req.params.id]);
  if (!p) throw notFound('Payout not found');
  const needsReason = ['failed', 'on_hold', 'cancelled'].includes(b.to);
  if (needsReason && (b.reason || '').length < 3) throw badRequest('A reason is required (at least 3 characters)');
  if (['approved', 'processing', 'paid'].includes(b.to) && p.method_status !== 'verified') {
    throw badRequest('This creator has no verified payment method for this payout');
  }
  if (b.to === 'paid' && p.method_type === 'crypto') {
    if (!b.tx_hash) throw badRequest('Enter the transaction hash');
    if (!b.tx_network) throw badRequest('Enter the network the transfer was sent on');
    if (p.method_network && b.tx_network.toLowerCase() !== p.method_network) {
      throw badRequest(`The payout method uses ${p.method_network}; the transfer network must match`);
    }
  }
  const fields = {};
  for (const k of ['transaction_ref', 'tx_hash', 'tx_network', 'paid_currency', 'paid_amount', 'exchange_rate', 'fees']) if (b[k] !== undefined) fields[k] = b[k];
  if (b.to === 'failed') fields.failure_reason = b.reason;
  if (b.to === 'on_hold') fields.hold_reason = b.reason;
  if (b.to === 'cancelled') fields.note = b.reason;
  if (b.note) fields.note = b.note;
  const updated = await transitionPayout(p.id, b.to, { adminId: req.admin.id, fields });
  await syncBatch(updated.batch_id);
  await audit(req, `payout.${b.to}`, 'payout', p.id, { from: p.status, amount: money(p.amount), channel_id: p.channel_id, reason: b.reason, ref: b.transaction_ref || b.tx_hash });
  res.json({ payout: payoutDto({ ...updated, method_status: p.method_status }) });
}));

// ---------------- Adjustments ----------------
r.get('/adjustments', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const rows = await db.query(
    `select a.*, c.name as channel_name, c.handle, u.full_name as by_name from payout_adjustments a
       join channels c on c.id = a.channel_id left join users u on u.id = a.created_by
      order by a.created_at desc limit $1 offset $2`, [limit + 1, offset]);
  res.json({ items: rows.slice(0, limit).map((x) => ({ ...x, amount: money(x.amount) })), has_more: rows.length > limit, page });
}));

r.post('/adjustments', wrap(async (req, res) => {
  const b = z.object({
    channel_id: z.string().uuid(),
    amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 1000000, 'Enter a non-zero amount up to 10,00,000'),
    reason: z.string().trim().min(5, 'A reason is required (at least 5 characters)').max(500),
  }).parse(req.body);
  const ch = await db.one('select id from channels where id = $1', [b.channel_id]);
  if (!ch) throw notFound('Channel not found');
  const row = await db.one(
    `insert into payout_adjustments (channel_id, amount, reason, created_by) values ($1,$2,$3,$4) returning *`,
    [b.channel_id, b.amount.toFixed(4), b.reason, req.admin.id]);
  await audit(req, 'payout_adjustment.create', 'channel', b.channel_id, { amount: b.amount, reason: b.reason });
  res.status(201).json({ adjustment: { ...row, amount: money(row.amount) } });
}));

// ---------------- Rates ----------------
r.get('/rates', wrap(async (req, res) => {
  res.json({ items: await rateHistory(50), monetization: await getSetting('monetization') });
}));

// ---------------- Reconciliation ----------------
// Every payout must equal the ledger entries + adjustments attached to it. Anything else is flagged.
r.get('/reconciliation', wrap(async (req, res) => {
  const mismatches = await db.query(
    `select p.id, p.status, p.amount, c.name as channel_name, c.handle,
            coalesce((select sum(amount) from earning_entries e where e.payout_id = p.id),0)
          + coalesce((select sum(amount) from payout_adjustments a where a.payout_id = p.id),0) as attached
       from payouts p join channels c on c.id = p.channel_id
      where p.status <> 'cancelled'
        and abs(p.amount - (coalesce((select sum(amount) from earning_entries e where e.payout_id = p.id),0)
                          + coalesce((select sum(amount) from payout_adjustments a where a.payout_id = p.id),0))) > 0.0001`);
  const paidNoRef = await db.query(
    `select p.id, p.amount, c.name as channel_name from payouts p join channels c on c.id = p.channel_id
      where p.status = 'paid' and coalesce(p.transaction_ref, p.tx_hash, '') = ''`);
  const totals = await db.one(
    `select (select coalesce(sum(amount),0) from earning_entries where status <> 'invalidated') as ledger_earnings,
            (select coalesce(sum(amount),0) from payout_adjustments) as adjustments,
            (select coalesce(sum(amount),0) from payouts where status <> 'cancelled') as payouts_total,
            (select coalesce(sum(amount),0) from earning_entries where status = 'approved' and payout_id is null) as unpaid_approved,
            (select coalesce(sum(amount),0) from earning_entries where status = 'pending') as pending,
            (select coalesce(sum(amount),0) from payout_adjustments where payout_id is null) as unpaid_adjustments`);
  const drift = num(totals.ledger_earnings) + num(totals.adjustments) - num(totals.payouts_total) - num(totals.unpaid_approved) - num(totals.pending) - num(totals.unpaid_adjustments);
  res.json({
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)])),
    unexplained: round2(drift),
    balanced: Math.abs(drift) < 0.01 && !mismatches.length && !paidNoRef.length,
    mismatches: mismatches.map((x) => ({ ...x, amount: money(x.amount), attached: money(x.attached) })),
    paid_without_reference: paidNoRef.map((x) => ({ ...x, amount: money(x.amount) })),
  });
}));

// ---------------- CSV export ----------------
// Cells that start with = + - @ are prefixed so spreadsheets never run them as formulas.
const cell = (v) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (res, name, head, rows) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.send('﻿' + [head.join(','), ...rows.map((x) => head.map((k) => cell(x[k])).join(','))].join('\r\n') + '\r\n');
};

r.get('/export/payouts.csv', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`p.status = $${params.length}`); }
  if (isDay(req.query.from)) { params.push(req.query.from); where.push(`p.created_at >= $${params.length}::date`); }
  if (isDay(req.query.to)) { params.push(req.query.to); where.push(`p.created_at < $${params.length}::date + 1`); }
  const rows = await db.query(
    `select p.id, b.period_start, c.name as channel, c.handle, p.amount, p.currency, p.status, p.method_type, p.method_asset,
            p.method_network, p.method_masked, p.transaction_ref, p.tx_hash, p.tx_network, p.paid_currency, p.paid_amount,
            p.exchange_rate, p.fees, p.paid_at, p.failure_reason, p.hold_reason, p.created_at
       from payouts p join channels c on c.id = p.channel_id left join payout_batches b on b.id = p.batch_id
      ${where.length ? 'where ' + where.join(' and ') : ''} order by p.created_at desc limit 20000`, params);
  await audit(req, 'export.payouts', 'payout', null, { rows: rows.length });
  csv(res, 'payouts.csv', ['id', 'period_start', 'channel', 'handle', 'amount', 'currency', 'status', 'method_type', 'method_asset', 'method_network',
    'method_masked', 'transaction_ref', 'tx_hash', 'tx_network', 'paid_currency', 'paid_amount', 'exchange_rate', 'fees', 'paid_at', 'failure_reason', 'hold_reason', 'created_at'], rows);
}));

r.get('/export/earnings.csv', wrap(async (req, res) => {
  const from = isDay(req.query.from) ? req.query.from : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = isDay(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  const rows = await db.query(
    `select e.day::text as day, c.name as channel, c.handle, e.kind, e.eligible_views, e.rate_per_1000, e.amount, e.status, e.payout_id
       from earning_entries e join channels c on c.id = e.channel_id where e.day between $1::date and $2::date order by e.day desc, c.name limit 50000`, [from, to]);
  await audit(req, 'export.earnings', 'earning', null, { from, to, rows: rows.length });
  csv(res, 'earnings.csv', ['day', 'channel', 'handle', 'kind', 'eligible_views', 'rate_per_1000', 'amount', 'status', 'payout_id'], rows);
}));

export default r;
