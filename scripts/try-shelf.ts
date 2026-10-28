// Count items on a shelf photo with SAM 3.1, one concept per call.
import { readFileSync } from 'node:fs';
import { Meta } from '../src/meta.ts';
const m = new Meta({ apiKey: process.env.MODEL_API_KEY ?? '' });
const path = process.argv[2];
const img = { bytes: readFileSync(path), mime: path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
await Promise.all(process.argv.slice(3).map(async (c) => {
  const t = Date.now();
  const r = await m.segment(img, c);
  console.log(c, Date.now() - t, 'ms', r.width, r.height, r.boxes.length, r.boxes.map((b) => b.confidence?.toFixed(2)).join(' '));
}));
