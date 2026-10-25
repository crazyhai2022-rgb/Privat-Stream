// Thumbnail validation and storage, shared by the upload endpoint and "change thumbnail".
//
// Browsers crop to the exact aspect before uploading (see web/js/cropper.js), so the server's job is
// to refuse anything that is not a real image of a usable size, then re-encode it when ffmpeg exists.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { sniff, imageSize, hasFfmpeg, processImage } from '../lib/media.js';
import { extFor } from '../lib/uploads.js';
import { fileId } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';

export const THUMB_SPECS = {
  short: { width: 720, height: 1280, minWidth: 270, minHeight: 480, label: '9:16 (720 × 1280)' },
  long: { width: 1280, height: 720, minWidth: 640, minHeight: 360, label: '16:9 (1280 × 720)' },
};
const MAX_SIDE = 8192;
const TOLERANCE = 0.08; // how far from the target aspect an image may be when the server cannot crop it

export async function checkThumbnail(file, kind) {
  const spec = THUMB_SPECS[kind];
  const t = await sniff(file.path);
  if (!t || t.type !== 'image') throw badRequest('Thumbnail must be a JPEG, PNG or WebP image.');
  const size = await imageSize(file.path);
  if (!size || !size.width || !size.height) throw badRequest('That image could not be read. Try a different file.');
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw badRequest(`That image is too large (${size.width}×${size.height}). Keep each side under ${MAX_SIDE}px.`);
  if (size.width < spec.minWidth || size.height < spec.minHeight) {
    throw badRequest(`That image is too small (${size.width}×${size.height}). Use at least ${spec.minWidth}×${spec.minHeight}; ${spec.label} is recommended.`);
  }
  return { type: t, size, spec };
}

/** Validates an uploaded thumbnail and stores it. Returns the storage key. */
export async function storeThumbnail(file, kind, storage) {
  const { type, size, spec } = await checkThumbnail(file, kind);
  const target = spec.width / spec.height;
  const off = Math.abs(size.width / size.height - target) / target;
  const ff = await hasFfmpeg();
  if (!ff && off > TOLERANCE) {
    throw badRequest(`This image is not ${kind === 'short' ? 'portrait 9:16' : 'landscape 16:9'}. Crop it to that shape and try again.`);
  }
  if (ff) {
    const out = path.join(config.storage.tmpDir, `thumb-${fileId()}.jpg`);
    try {
      await processImage(file.path, out, { width: spec.width, height: spec.height, crop: true });
      const key = `thumbs/${fileId()}.jpg`;
      await storage.put(key, out, 'image/jpeg');
      return key;
    } finally {
      await fsp.rm(out, { force: true });
    }
  }
  const key = `thumbs/${fileId()}${extFor(type.format)}`;
  await storage.put(key, file.path, type.mime);
  return key;
}
