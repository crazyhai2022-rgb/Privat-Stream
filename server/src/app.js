import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config, REPO_ROOT } from './config.js';
import { attachSessions, csrfGuard, errorHandler, notFoundApi, limiter } from './middleware/core.js';
import authRoutes from './routes/auth.js';
import channelRoutes from './routes/channels.js';
import videoRoutes from './routes/videos.js';
import engagementRoutes from './routes/engagement.js';
import adminRoutes from './routes/admin.js';
import adminPaymentRoutes from './routes/adminPayments.js';
import { maybeRunMaintenance } from './services/maintenance.js';
import earningsRoutes from './routes/earnings.js';
import researchRoutes from './routes/research.js';
import { api as publicApi, media } from './routes/public.js';
import { db } from './db/index.js';
import { renderShell, buildSitemap, robotsTxt } from './services/seo.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...(config.cdn.baseUrl ? [config.cdn.baseUrl] : [])],
        mediaSrc: ["'self'", 'blob:', ...(config.cdn.baseUrl ? [config.cdn.baseUrl] : [])],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.isProd,
  }));
  app.use(cookieParser());

  // Media (needs sessions to authorise unpublished previews)
  app.use(attachSessions);
  app.use(media);

  app.get('/healthz', async (req, res) => {
    try { await db.query('select 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api', (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex'); next(); });
  app.use('/api', express.json({ limit: '100kb' }));
  app.use('/api', limiter({ windowMs: 60e3, max: 600 }));
  app.use('/api', (req, res, next) => { maybeRunMaintenance(); next(); });
  app.use('/api', csrfGuard);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin/payments', adminPaymentRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', publicApi);
  app.use('/api', channelRoutes);
  app.use('/api', earningsRoutes);
  app.use('/api', researchRoutes);
  app.use('/api', videoRoutes);
  app.use('/api', engagementRoutes);

  if (config.exposeOutbox) {
    // Development helper: read verification / reset links without an SMTP server.
    // Guarded again here: anything that is not a direct local request is treated as not found.
    app.get('/api/dev/outbox', async (req, res, next) => {
      const addr = req.socket?.remoteAddress || '';
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
      if (!local || config.trustProxy) return next();
      const to = String(req.query.to || '').toLowerCase();
      const rows = await db.query('select to_email, subject, link, created_at from email_outbox where ($1 = \'\' or lower(to_email) = $1) order by id desc limit 20', [to]);
      res.json({ items: rows });
    });
  }
  app.use('/api', notFoundApi);

  // Static front-end (no build step)
  const webDir = path.join(REPO_ROOT, 'web');
  app.use('/admin', (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
  app.use('/admin', express.static(path.join(webDir, 'admin'), { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
  app.use(express.static(webDir, { index: false, maxAge: config.isProd ? '1h' : 0 }));
  app.get('/robots.txt', (req, res) => { res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsTxt(req)); });
  app.get('/sitemap.xml', async (req, res, next) => {
    try { res.type('application/xml').set('Cache-Control', 'public, max-age=900').send(await buildSitemap(req)); } catch (e) { next(e); }
  });
  app.get(/^\/(?!api\/|stream\/|thumb\/|media\/).*/, async (req, res, next) => {
    if (req.path.startsWith('/admin')) { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); return res.sendFile(path.join(webDir, 'admin', 'index.html')); }
    if (path.extname(req.path)) return next();
    try {
      const html = await renderShell(req);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(html);
    } catch (e) { next(e); }
  });

  app.use(errorHandler);
  return app;
}
