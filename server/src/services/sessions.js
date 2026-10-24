import { db } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256, ipHash } from '../lib/crypto.js';
import { cookieOpts, USER_COOKIE, ADMIN_COOKIE } from '../middleware/core.js';

export async function createSession(req, res, userId, scope = 'user') {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const ttlMs = scope === 'admin' ? config.session.adminTtlHours * 3600e3 : config.session.userTtlDays * 86400e3;
  await db.query(
    `insert into sessions (user_id, token_hash, csrf_token, scope, ip_hash, user_agent, expires_at)
     values ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7::double precision))`,
    [userId, sha256(token), csrf, scope, ipHash(req.ip), (req.get('user-agent') || '').slice(0, 200), ttlMs / 1000],
  );
  res.cookie(scope === 'admin' ? ADMIN_COOKIE : USER_COOKIE, token, cookieOpts({ strict: scope === 'admin', maxAgeMs: ttlMs }));
  return { csrf };
}

export async function destroySession(req, res, scope = 'user') {
  const name = scope === 'admin' ? ADMIN_COOKIE : USER_COOKIE;
  const token = req.cookies?.[name];
  if (token) await db.query('update sessions set revoked_at = now() where token_hash = $1', [sha256(token)]);
  res.clearCookie(name, cookieOpts({ strict: scope === 'admin' }));
}

export const revokeAllSessions = (userId, exceptSessionId) =>
  db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2::uuid)', [userId, exceptSessionId || null]);
