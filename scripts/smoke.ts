// Live end-to-end run through the App with a fake chat channel (real Meta models, temp data).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, type Incoming, type Reply } from '../src/app.ts';
import { Ledger } from '../src/ledger.ts';
import { Meta } from '../src/meta.ts';

const dir = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'kl-'));
const meta = new Meta({ apiKey: process.env.MODEL_API_KEY ?? '' });
const app = new App({ meta, ledger: new Ledger(join(dir, 'db.sqlite')), dataDir: dir, publicUrl: 'http://localhost:8080', log: (e, d) => console.log('  [log]', e, JSON.stringify(d).slice(0, 200)) });
let last: Reply | null = null;
let photos = 0;
const send = async (r: Reply) => {
  last = r;
  if (r.photo) { const p = join(dir, `out-${++photos}.jpg`); writeFileSync(p, r.photo); console.log(`  <photo ${p}> ${r.caption ?? ''}`); }
  if (r.text) console.log('  ' + r.text.replaceAll('\n', '\n  '));
  if (r.buttons) console.log('  [buttons] ' + r.buttons.flat().map((b) => `${b.title} (${b.id.slice(0, 20)})`).join(' | '));
};
const say = async (m: Partial<Incoming>) => { console.log(`\n>>> ${m.type} ${m.text ?? ''}`); const t = Date.now(); await app.handle({ channel: 'test', user: '1', displayName: 'Ada', ...m } as Incoming, send); console.log(`  (${Date.now() - t} ms)`); };
const file = (p: string) => async () => readFileSync(p);
const btn = (prefix: string) => last?.buttons?.flat().find((b) => b.id.startsWith(prefix))?.id ?? '';

for (const step of (process.argv[2] ?? 'all').split(',')) {
  if (step === 'all' || step === 'page') {
    await say({ type: 'text', text: 'hi' });
    await say({ type: 'button', text: 'lang:pcm' });
    await say({ type: 'photo', file: file('eval/samples/page-sales.jpg') });
    await say({ type: 'button', text: btn('ok:') });
    await say({ type: 'photo', file: file('eval/samples/page-debts.jpg') });
    await say({ type: 'button', text: btn('fix:') });
    await say({ type: 'text', text: 'line 4 na 1,000 not 1,500' });
    await say({ type: 'button', text: btn('ok:') });
    await say({ type: 'text', text: 'I sell 3 crates egg give Bisi 13,500, she go pay Friday' });
    await say({ type: 'button', text: btn('ok:') });
    await say({ type: 'text', text: 'who dey owe me pass?' });
    await say({ type: 'text', text: '/today' });
    await say({ type: 'text', text: '/debtors' });
    await say({ type: 'button', text: btn('rem:') });
    await say({ type: 'text', text: '/passport' });
  }
  if (step === 'all' || step === 'shelf') {
    await say({ type: 'photo', text: 'stock', file: file('eval/samples/shelf.jpg') });
  }
  if (step === 'voice') {
    await say({ type: 'button', text: `lang:${process.argv[4] ?? 'en'}` });
    await say({ type: 'voice', file: file(process.argv[3]) });
    await say({ type: 'text', text: 'sold 4 tins tomato 1,200 each' });
  }
}
console.log('\ndata dir:', dir);
