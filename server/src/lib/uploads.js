import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { fileId } from './crypto.js';

fs.mkdirSync(config.storage.tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.storage.tmpDir),
  // Never use the client's filename on disk.
  filename: (req, file, cb) => cb(null, `up-${fileId()}.bin`),
});

/** Build a multer middleware with request-specific limits. fields: [{name, maxBytes}] */
export function uploader(fields) {
  const maxBytes = Math.max(...fields.map((f) => f.maxBytes));
  const sizes = Object.fromEntries(fields.map((f) => [f.name, f.maxBytes]));
  const m = multer({
    storage,
    limits: { fileSize: maxBytes, files: fields.length, fields: 20, fieldSize: 20 * 1024, parts: 40 },
    fileFilter: (req, file, cb) => (sizes[file.fieldname] ? cb(null, true) : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname))),
  }).fields(fields.map((f) => ({ name: f.name, maxCount: 1 })));
  return (req, res, next) => m(req, res, async (err) => {
    if (err) { await cleanupFiles(req); return next(err); }
    // Per-field size limits (multer only has one global limit).
    for (const [name, arr] of Object.entries(req.files || {})) {
      if (arr[0].size > sizes[name]) {
        await cleanupFiles(req);
        return next(Object.assign(new multer.MulterError('LIMIT_FILE_SIZE', name)));
      }
    }
    next();
  });
}

export async function cleanupFiles(req) {
  const all = Object.values(req.files || {}).flat();
  await Promise.all(all.map((f) => fs.promises.rm(f.path, { force: true })));
}

export const extFor = (format) => ({ mp4: '.mp4', mov: '.mov', webm: '.webm', jpg: '.jpg', png: '.png', webp: '.webp' }[format] || path.extname(format));
