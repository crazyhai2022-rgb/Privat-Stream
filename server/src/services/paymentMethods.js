// Payout methods: validation, masking and encrypted storage.
//
// The creator picks an asset AND a network and must confirm the network. Sending USDT on the
// wrong chain loses the funds, so the two are never inferred from each other.
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { seal, open } from '../lib/secretbox.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';

export const CRYPTO_OPTIONS = [
  { asset: 'btc',  network: 'bitcoin',  label: 'Bitcoin (BTC)' },
  { asset: 'eth',  network: 'ethereum', label: 'Ethereum (ETH)' },
  { asset: 'usdt', network: 'tron',     label: 'USDT — TRON (TRC20)' },
  { asset: 'usdt', network: 'bsc',      label: 'USDT — BNB Smart Chain (BEP20)' },
  { asset: 'usdt', network: 'ethereum', label: 'USDT — Ethereum (ERC20)' },
];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.from(hex === '00' ? '' : hex, 'hex');
  const zeros = s.length - s.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}
const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();

/** Base58Check: checks the 4-byte checksum and returns the version byte, or null. */
function base58check(s) {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const body = raw.subarray(0, -4);
  return dsha(body).subarray(0, 4).equals(raw.subarray(-4)) ? { version: body[0], length: body.length } : null;
}

const VALIDATORS = {
  bitcoin(a) {
    if (/^bc1[ac-hj-np-z02-9]{11,87}$/.test(a)) return true;                // bech32/bech32m, mainnet, lowercase
    const c = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a) && base58check(a);
    return !!c && (c.version === 0x00 || c.version === 0x05) && c.length === 21;
  },
  // Checksum casing (EIP-55) needs keccak-256, which Node does not ship; the format is checked
  // and an administrator verifies the address before any payout.
  ethereum: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
  bsc: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
  tron(a) {
    const c = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) && base58check(a);
    return !!c && c.version === 0x41 && c.length === 21;
  },
};

export const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,40}$/;

export function maskIdentifier(type, value) {
  if (type === 'upi') {
    const [name, handle] = value.split('@');
    return `${name.slice(0, Math.min(3, Math.max(1, name.length - 2)))}${'*'.repeat(4)}@${handle}`;
  }
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '••••';
}

/** Validates a submission and returns the normalised pieces. Throws a 400 with a plain message. */
export function validateMethod(input) {
  const holder = String(input.holder_name || '').trim();
  if (holder.length < 2 || holder.length > 100) throw badRequest('Enter the account holder name');
  const value = String(input.value || '').trim();
  if (input.type === 'upi') {
    if (!UPI_RE.test(value)) throw badRequest('Enter a valid UPI ID, like name@bank');
    return { type: 'upi', asset: null, network: null, holder, value: value.toLowerCase() };
  }
  if (input.type !== 'crypto') throw badRequest('Unknown payment method');
  const opt = CRYPTO_OPTIONS.find((o) => o.asset === input.asset && o.network === input.network);
  if (!opt) throw badRequest('Choose a supported coin and network');
  if (input.network_confirmed !== true) {
    throw badRequest(`Confirm that this is a ${opt.label} address. Funds sent on the wrong network cannot be recovered.`);
  }
  if (!VALIDATORS[opt.network](value)) throw badRequest(`That is not a valid ${opt.label} address`);
  return { type: 'crypto', asset: opt.asset, network: opt.network, holder, value };
}

export const methodDto = (m) => ({
  id: m.id, type: m.type, asset: m.asset, network: m.network, holder_name: m.holder_name,
  masked: m.masked, status: m.status, status_reason: m.status_reason, is_default: m.is_default,
  created_at: m.created_at, reviewed_at: m.reviewed_at,
});

export async function listMethods(channelId) {
  const rows = await db.query('select * from payout_methods where channel_id = $1 order by created_at desc', [channelId]);
  return rows.map(methodDto);
}

export async function addMethod(channelId, input) {
  const v = validateMethod(input);
  const hash = sha256(`${v.type}:${v.network || ''}:${v.value}`);
  return db.tx(async (q) => {
    const [dupe] = await q('select id from payout_methods where channel_id = $1 and secret_hash = $2', [channelId, hash]);
    if (dupe) throw badRequest('You have already added this account');
    const [{ n }] = await q('select count(*)::int as n from payout_methods where channel_id = $1', [channelId]);
    if (n >= 5) throw badRequest('You can keep up to 5 payment methods. Remove one first.');
    const [row] = await q(
      `insert into payout_methods (channel_id, type, asset, network, holder_name, secret_cipher, masked, secret_hash, is_default)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [channelId, v.type, v.asset, v.network, v.holder, seal(v.value), maskIdentifier(v.type, v.value), hash, n === 0]);
    return row;
  });
}

/** Decrypts an identifier. Only administrators processing a payout should ever call this. */
export const revealIdentifier = (row) => open(row.secret_cipher);
