import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { config } from '../config.js';

function run(cmd, args, { timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 5e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 5e5) err = err.slice(-1e5); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err.split('\n').slice(-6).join(' ').slice(0, 400)}`));
    });
  });
}

const FFMPEG = () => config.ffmpegPath;
const FFPROBE = () => config.ffprobePath;

let ffAvailable;
export async function hasFfmpeg() {
  if (ffAvailable !== undefined) return ffAvailable;
  try {
    await run(FFPROBE(), ['-version'], { timeoutMs: 8000 });
    await run(FFMPEG(), ['-version'], { timeoutMs: 8000 });
    ffAvailable = true;
  } catch { ffAvailable = false; }
  return ffAvailable;
}

export async function probe(file) {
  const { out } = await run(FFPROBE(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('File does not contain a video stream');
  let w = Number(v.width), h = Number(v.height);
  const rot = Number(v.tags?.rotate || v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [w, h] = [h, w];
  const duration = Number(j.format?.duration || v.duration || 0);
  return { duration, width: w, height: h, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'), codec: v.codec_name };
}

export async function makeThumbnail(src, dest, { kind, at = 1 }) {
  // Short: 9:16 crop 360x640; Long: 16:9 crop 640x360.
  const vf = kind === 'short'
    ? 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640'
    : 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360';
  await run(FFMPEG(), ['-y', '-v', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '4', dest], { timeoutMs: 120000 });
}

export async function transcode(src, dest, { hasAudio, format = 'mp4' }) {
  const args = ['-y', '-v', 'error', '-i', src,
    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"];
  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1');
    if (hasAudio) args.push('-c:a', 'libopus', '-b:a', '96k'); else args.push('-an');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k'); else args.push('-an');
  }
  args.push(dest);
  await run(FFMPEG(), args);
}

// Re-encode an uploaded image to a safe, metadata-free JPEG at a bounded size.
export async function processImage(src, dest, { width, height, crop }) {
  const vf = crop
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale='min(${width},iw)':-2`;
  await run(FFMPEG(), ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', vf, '-map_metadata', '-1', '-q:v', '3', dest], { timeoutMs: 60000 });
}

// ---- Magic-byte sniffing: never trust file extensions or client-supplied MIME types ----
export async function sniff(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(32);
    await fh.read(buf, 0, 32, 0);
    const ascii = (a, b) => buf.toString('latin1', a, b);
    if (ascii(4, 8) === 'ftyp') {
      const brand = ascii(8, 12);
      return { type: 'video', format: brand.startsWith('qt') ? 'mov' : 'mp4', mime: brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4' };
    }
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { type: 'video', format: 'webm', mime: 'video/webm' };
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image', format: 'jpg', mime: 'image/jpeg' };
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image', format: 'png', mime: 'image/png' };
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image', format: 'webp', mime: 'image/webp' };
  } finally {
    await fh.close();
  }
  return null;
}
