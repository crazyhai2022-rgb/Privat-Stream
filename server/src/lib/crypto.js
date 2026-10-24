import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { config } from '../config.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', config.secret).update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Short, URL-safe, unambiguous ids for canonical video URLs.
export const publicId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 11);
export const fileId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 24);
export const ipHash = (ip) => hmac('ip:' + (ip || 'unknown')).slice(0, 32);
