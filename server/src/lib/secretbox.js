// AES-256-GCM for payout account identifiers (UPI ids, wallet addresses).
//
// The key comes from PAYOUT_ENCRYPTION_KEY (32 random bytes, base64/base64url/hex) when set,
// otherwise it is derived from APP_SECRET with HKDF under a purpose label. Either way the
// plaintext is never written to the database. Rotating APP_SECRET without setting
// PAYOUT_ENCRYPTION_KEY makes stored identifiers undecryptable, so production should set the
// dedicated key and keep it.
import crypto from 'node:crypto';
import { config } from '../config.js';

let cached;
function key() {
  if (cached) return cached;
  const raw = process.env.PAYOUT_ENCRYPTION_KEY;
  if (raw) {
    let buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64url');
    if (buf.length !== 32) throw new Error('PAYOUT_ENCRYPTION_KEY must decode to exactly 32 bytes');
    cached = buf;
  } else {
    cached = Buffer.from(crypto.hkdfSync('sha256', config.secret, 'viralx', 'payout-methods-v1', 32));
  }
  return cached;
}

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function open(boxed) {
  const [v, iv, tag, ct] = String(boxed).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
