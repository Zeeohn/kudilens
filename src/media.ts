// Audio conversion and photo annotation with ffmpeg (no npm packages).

import { spawn } from 'node:child_process';

function ffmpeg(args: string[], input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`)));
    p.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input; the exit code reports it
    p.stdin.end(input);
  });
}

/** Any voice note (OGG/Opus from Telegram and WhatsApp, M4A, MP3) → 16 kHz mono 16-bit WAV, capped at 5 minutes. */
export function toWav(audio: Uint8Array): Promise<Uint8Array> {
  return ffmpeg(['-i', 'pipe:0', '-t', '300', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], audio);
}

/** Seconds of audio in a 16-bit mono WAV. */
export function wavSeconds(wav: Uint8Array, rate = 16000): number {
  return Math.max(0, (wav.length - 44) / (rate * 2));
}

export interface Mark { box: [number, number, number, number]; label: string; ok: boolean }

/**
 * Draw numbered boxes on a photo: green for lines that passed every check, orange for
 * lines that need the trader. Boxes are on a 0–1000 scale; ffmpeg's iw/ih scale them.
 */
export function annotate(image: Uint8Array, marks: Mark[]): Promise<Uint8Array> {
  if (!marks.length) return Promise.resolve(image);
  const filters = ['scale=w=min(iw\\,1280):h=-2'];
  for (const m of marks) {
    const [x1, y1, x2, y2] = m.box;
    const color = m.ok ? '0x16a34a' : '0xf97316';
    const x = `iw*${x1 / 1000}`, y = `ih*${y1 / 1000}`;
    filters.push(`drawbox=x=${x}:y=${y}:w=iw*${Math.max(1, x2 - x1) / 1000}:h=ih*${Math.max(1, y2 - y1) / 1000}:color=${color}@0.9:t=4`);
    filters.push(`drawtext=text='${m.label.replace(/[^0-9A-Za-z ]/g, '')}':x=max(0\\,w*${x1 / 1000}-th*1.4):y=h*${y1 / 1000}:fontsize=h/40:fontcolor=white:box=1:boxcolor=${color}@0.95:boxborderw=6`);
  }
  return ffmpeg(['-i', 'pipe:0', '-vf', filters.join(','), '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], image);
}

/** Boxes around counted items on a shelf photo (pixel coordinates from SAM). */
export function annotatePixels(image: Uint8Array, boxes: { x1: number; y1: number; x2: number; y2: number; color: string }[], size: { width: number; height: number }): Promise<Uint8Array> {
  if (!boxes.length || !size.width) return Promise.resolve(image);
  const filters = boxes.map((b) =>
    `drawbox=x=iw*${b.x1 / size.width}:y=ih*${b.y1 / size.height}:w=iw*${(b.x2 - b.x1) / size.width}:h=ih*${(b.y2 - b.y1) / size.height}:color=${b.color}@0.9:t=3`);
  return ffmpeg(['-i', 'pipe:0', '-vf', ['scale=w=min(iw\\,1280):h=-2', ...filters].join(','), '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], image);
}

/** Cut one region out of a photo; the region is given as fractions of its width and height. */
export function cropImage(image: Uint8Array, r: { x: number; y: number; w: number; h: number }): Promise<Uint8Array> {
  const f = (v: number) => v.toFixed(4);
  return ffmpeg(['-i', 'pipe:0', '-vf', `crop=w=iw*${f(r.w)}:h=ih*${f(r.h)}:x=iw*${f(r.x)}:y=ih*${f(r.y)}`, '-frames:v', '1', '-q:v', '2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], image);
}

/**
 * Cut each box out of the photo into its own numbered tile, laid out on one sheet, so a vision
 * model judges one unit at a time instead of reading small numbers on a crowded shelf.
 */
export function contactSheet(image: Uint8Array, boxes: { x1: number; y1: number; x2: number; y2: number }[], size: { width: number; height: number }, cols = 8): Promise<Uint8Array> {
  const W = 150, H = 200, TOP = 26;
  const tiles = boxes.map((b, i) => {
    const f = (v: number, d: number) => Math.min(1, Math.max(0, v / d)).toFixed(4);
    return `[s${i}]crop=w=iw*${f(b.x2 - b.x1, size.width)}:h=ih*${f(b.y2 - b.y1, size.height)}:x=iw*${f(b.x1, size.width)}:y=ih*${f(b.y1, size.height)},`
      + `scale=${W}:${H - TOP}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:${TOP}:color=white,`
      + `drawtext=text='${i + 1}':x=6:y=3:fontsize=22:fontcolor=black[t${i}]`;
  });
  const layout = boxes.map((_, i) => `${(i % cols) * W}_${Math.floor(i / cols) * H}`).join('|');
  const graph = boxes.length === 1
    ? `[0:v]split=1[s0];${tiles[0]};[t0]null[out]`
    : `[0:v]split=${boxes.length}${boxes.map((_, i) => `[s${i}]`).join('')};${tiles.join(';')};${boxes.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${boxes.length}:layout=${layout}:fill=white[out]`;
  return ffmpeg(['-i', 'pipe:0', '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], image);
}

export function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  return 'application/octet-stream';
}
