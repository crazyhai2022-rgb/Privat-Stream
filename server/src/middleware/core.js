import { ZodError } from 'zod';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sha256, safeEqual, hmac, randomToken } from '../lib/crypto.js';
import { HttpError, unauthorized, forbidden } from '../lib/errors.js';

// `req.path` loses the mount prefix inside a mounted router, so admin requests are
// recognised from the original URL instead.
export const isAdminRequest = (req) => /^\/api\/admin(\/|$|\?)/.test(req.originalUrl || req.url || '');

export const USER_COOKIE = 'ps_session';
export const ADMIN_COOKIE = 'ps_admin';
export const ANON_COOKIE = 'ps_aid';

export function cookieOpts({ strict = false, maxAgeMs, httpOnly = true } = {}) {
  return { httpOnly, secure: config.session.cookieSecure, sameSite: strict ? 'strict' : 'lax', path: '/', maxAge: maxAgeMs };
}

async function loadSession(token, scope) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const row = await db.one(
    `select s.id as session_id, s.csrf_token, s.scope, s.expires_at, u.*
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.scope = $2 and s.revoked_at is null and s.expires_at > now()`,
    [sha256(token), scope],
  );
  if (!row) return null;
  const { session_id, csrf_token, expires_at, scope: sc, password_hash, ...user } = row;
  return { session: { id: session_id, csrf_token, expires_at, scope: sc }, user };
}

// Attach req.user/req.session (public site) and req.admin/req.adminSession (admin panel).
export async function attachSessions(req, res, next) {
  try {
    req.user = null; req.session = null; req.admin = null; req.adminSession = null;
    const u = await loadSession(req.cookies?.[USER_COOKIE], 'user');
    if (u && u.user.account_status === 'active') { req.user = u.user; req.session = u.session; }
    if (isAdminRequest(req) || /^\/(api\/admin|stream|thumb)/.test(req.path)) {
      const a = await loadSession(req.cookies?.[ADMIN_COOKIE], 'admin');
      if (a && a.user.account_status === 'active' && ['super_admin', 'moderator'].includes(a.user.role)) {
        req.admin = a.user; req.adminSession = a.session;
        // Admin actions are attributed to the admin account.
        req.user = a.user;
      }
    }
    next();
  } catch (e) { next(e); }
}

function allowedOrigins() {
  const set = new Set([config.baseUrl, ...config.extraOrigins]);
  return set;
}

// CSRF defence in depth: SameSite cookies + Origin check + per-session token.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !allowedOrigins().has(origin)) return next(forbidden('Cross-site request blocked', 'csrf_origin'));
  const admin = isAdminRequest(req);
  const sess = admin ? req.adminSession : req.session;
  if (sess) {
    if (!safeEqual(req.get('x-csrf-token'), sess.csrf_token)) return next(forbidden('Invalid or missing CSRF token', 'csrf'));
  } else if (admin) {
    // No admin session: let the route's own authorization answer with 401 rather than a CSRF error,
    // but still require a non-form request so a cross-site form post cannot reach it.
    if (req.get('x-requested-with') !== 'fetch') return next(forbidden('Missing request header', 'csrf'));
  } else if (req.get('x-requested-with') !== 'fetch') {
    return next(forbidden('Missing request header', 'csrf'));
  }
  next();
}

export const requireAuth = (req, res, next) => (req.user ? next() : next(unauthorized()));

/** Requires a logged-in user, and a verified email only while the platform asks for one. */
export const requireVerified = async (req, res, next) => {
  try {
    if (!req.user) return next(unauthorized());
    if (req.user.email_verified_at) return next();
    const { getSetting } = await import('../services/settings.js');
    const { require_email_verification: needed } = await getSetting('moderation');
    if (needed) return next(forbidden('Please verify your email address first', 'email_unverified'));
    next();
  } catch (e) { next(e); }
};

export function requireAdmin(permission) {
  return async (req, res, next) => {
    try {
      if (!req.admin) return next(unauthorized('Admin login required'));
      if (permission) {
        const r = await db.one('select permissions from admin_roles where role = $1', [req.admin.role]);
        if (!r?.permissions?.includes(permission)) return next(forbidden('Your role cannot perform this action'));
      }
      next();
    } catch (e) { next(e); }
  };
}

// Anonymous reaction identity: opaque random id in an HttpOnly cookie; only an HMAC is stored.
export function actorFor(req, res, { create = false } = {}) {
  if (req.user && !isAdminRequest(req)) return { key: `u:${req.user.id}`, userId: req.user.id };
  let aid = req.cookies?.[ANON_COOKIE];
  if (!aid || typeof aid !== 'string' || aid.length < 20 || aid.length > 80) {
    if (!create) return null;
    aid = randomToken(24);
    res.cookie(ANON_COOKIE, aid, cookieOpts({ maxAgeMs: 400 * 24 * 3600 * 1000 }));
  }
  return { key: `a:${hmac('aid:' + aid).slice(0, 40)}`, userId: null };
}

export function limiter({ windowMs, max, message = 'Too many requests, please try again later.', keyGenerator }) {
  if (config.rateLimitDisabled) return (req, res, next) => next();
  return rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator,
    handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message } }),
  });
}

export function notFoundApi(req, res, next) {
  next(new HttpError(404, 'Not found', 'not_found'));
}

export function errorHandler(err, req, res, _next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return res.status(400).json({ error: { code: 'validation', message: issues[0] ? `${issues[0].path ? issues[0].path + ': ' : ''}${issues[0].message}` : 'Invalid input', details: issues } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Service-layer errors that carry their own client status (state-machine and validation failures).
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.code) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than the allowed size' : `Upload error: ${err.message}`;
    return res.status(status).json({ error: { code: 'upload', message } });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body' } });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large' } });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong' } });
}
