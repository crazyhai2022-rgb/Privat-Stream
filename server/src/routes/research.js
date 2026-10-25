import { Router } from 'express';
import { z } from 'zod';
import { wrap, HttpError } from '../lib/errors.js';
import { requireAuth, limiter } from '../middleware/core.js';
import { requireUploader } from './videos.js';
import { analyzeUrl, ResearchError } from '../services/research/index.js';
import { audit } from '../services/audit.js';

const r = Router();

const body = z.object({ url: z.string().max(2000), count: z.number().int().min(1).max(5).default(3) });

// Each analysis makes outbound requests and may call a paid AI service, so it is rate limited per account.
const perUser = limiter({ windowMs: 60_000, max: 8, message: 'You are analysing too quickly. Wait a minute and try again.', keyGenerator: (req) => `research:${req.user?.id || req.ip}` });

r.post('/research/analyze', requireAuth, requireUploader, perUser, wrap(async (req, res) => {
  const { url, count } = body.parse(req.body);
  try {
    const result = await analyzeUrl(url, count);
    await audit(req, 'research.analyze', 'research', null, { host: new URL(result.source.final_url).hostname, count, mode: result.mode });
    res.json(result);
  } catch (e) {
    if (e instanceof ResearchError) throw new HttpError(e.status, e.message, e.code);
    throw e;
  }
}));

export default r;
