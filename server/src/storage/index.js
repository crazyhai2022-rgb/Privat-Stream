import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/;
function assertKey(key) {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) throw new Error('Invalid storage key');
}

// -------- Local filesystem driver (development / single server) --------
function localDriver() {
  const root = path.resolve(config.storage.localDir);
  const abs = (key) => {
    assertKey(key);
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return p;
  };
  return {
    name: 'local',
    async put(key, localPath) {
      const dest = abs(key);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(fs.createReadStream(localPath), fs.createWriteStream(dest));
    },
    async download(key, destPath) {
      await fsp.copyFile(abs(key), destPath);
    },
    async remove(key) {
      await fsp.rm(abs(key), { force: true });
    },
    async exists(key) {
      try { await fsp.access(abs(key)); return true; } catch { return false; }
    },
    // Streams with HTTP Range support (express handles Range/If-Modified-Since for sendFile).
    async serve(req, res, key, { contentType, cache = 'private, max-age=0' } = {}) {
      const file = abs(key);
      if (contentType) res.type(contentType);
      res.setHeader('Cache-Control', cache);
      await new Promise((resolve, reject) => {
        res.sendFile(file, { acceptRanges: true, headers: { 'X-Content-Type-Options': 'nosniff' } }, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// -------- S3-compatible driver (AWS S3, Cloudflare R2, MinIO, Backblaze B2 ...) --------
async function s3Driver() {
  const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const c = config.storage.s3;
  if (!c.bucket || !c.accessKeyId || !c.secretAccessKey) throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for STORAGE_DRIVER=s3');
  const client = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  return {
    name: 's3',
    async put(key, localPath, contentType) {
      assertKey(key);
      // lib-storage streams the file in parts: the whole video is never loaded into memory.
      await new Upload({
        client,
        params: { Bucket: c.bucket, Key: key, Body: fs.createReadStream(localPath), ContentType: contentType || 'application/octet-stream' },
      }).done();
    },
    async download(key, destPath) {
      assertKey(key);
      const out = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
      await pipeline(out.Body, fs.createWriteStream(destPath));
    },
    async remove(key) {
      assertKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    },
    async exists(key) {
      try { await client.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key })); return true; } catch { return false; }
    },
    async serve(req, res, key, { contentType } = {}) {
      assertKey(key);
      const url = await getSignedUrl(client, new GetObjectCommand({
        Bucket: c.bucket, Key: key, ResponseContentType: contentType,
      }), { expiresIn: 300 });
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.redirect(302, url);
    },
  };
}

let driver;
export async function getStorage() {
  if (driver) return driver;
  driver = config.storage.driver === 's3' ? await s3Driver() : localDriver();
  if (driver.name === 'local') await fsp.mkdir(config.storage.localDir, { recursive: true });
  return driver;
}
