import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { App, type Incoming, type Reply } from '../src/app.ts';
import { Ledger } from '../src/ledger.ts';
import type { Meta } from '../src/meta.ts';
import { startWeb } from '../src/web.ts';
import { html } from '../src/channels/telegram.ts';
import { wa } from '../src/channels/whatsapp.ts';

const line = (o: object) => ({
  kind: 'sale', date: null, item: 'rice', quantity: null, unit: null, unitPrice: null, amount: 5000, paid: 'paid',
  amountPaid: null, method: 'cash', customer: null, dueDate: null, rawText: 'x', box: null, confidence: 0.97, ...o,
});

const edit = (o: object) => ({ line: 1, remove: false, kind: null, item: null, quantity: null, unit: null, unitPrice: null, amount: null, paid: null, amountPaid: null, customer: null, dueDate: null, method: null, ...o });

/** A stand-in for the Meta API: canned answers keyed by schema name. */
function fakeMeta(): Meta {
  return {
    async structured({ name }: { name: string }) {
      if (name === 'ledger_page') {
        // The trader wrote 7,000 + 6,500 + 1,200 = 14,700; the "model" misread 6,500 as 5,500.
        return {
          isLedger: true, pageDate: '2026-10-28', writtenTotal: 14700, writtenTotalText: '14,700', note: '',
          lines: [line({ amount: 7000, item: 'Indomie' }), line({ amount: 5500, item: 'Beans', paid: 'owed', customer: 'Mama Tunde' }), line({ amount: 1200, item: 'Oil' })],
        };
      }
      if (name === 'text_note') {
        return { transcript: 't', language: 'english', english: 't', intent: 'record', question: null, lines: [line({ kind: 'payment', amount: 2000, customer: 'mama tunde', item: null })] };
      }
      if (name === 'corrections') return { action: 'edit', newText: null, edits: [edit({ line: 1, amount: 2500 })] };
      throw new Error(`unexpected ${name}`);
    },
    async chat() { return { message: { role: 'assistant', content: 'Collect from Mama Tunde.' }, finish: 'stop' }; },
  } as unknown as Meta;
}

function harness(meta: Meta = fakeMeta()) {
  const dir = mkdtempSync(join(tmpdir(), 'kl-test-'));
  const ledger = new Ledger();
  const app = new App({ meta, ledger, dataDir: dir, publicUrl: 'https://kudi.test', now: () => new Date('2026-10-28T12:00:00Z') });
  const out: Reply[] = [];
  const say = async (m: Partial<Incoming>) => { out.length = 0; await app.handle({ channel: 'test', user: '7', type: 'text', ...m } as Incoming, async (r) => { out.push(r); }); return out; };
  const button = (prefix: string) => out.flatMap((r) => r.buttons?.flat() ?? []).find((b) => b.id.startsWith(prefix))!.id;
  const text = () => out.map((r) => r.text ?? r.caption ?? '').join('\n');
  return { app, ledger, say, button, text };
}

test('photo → digit repair from the written total → confirm → sealed ledger', async () => {
  const h = harness();
  await h.say({ text: 'hi' });
  await h.say({ type: 'photo', file: async () => new Uint8Array([0xff, 0xd8, 1, 2, 3]) });
  assert.match(h.text(), /Line 2: I read ₦5,500, but your total says ₦14,700\. Was it \*\*₦6,500\*\*\?/);
  await h.say({ type: 'button', text: h.button('rep:') });
  assert.doesNotMatch(h.text(), /⚠️/);
  await h.say({ type: 'button', text: h.button('ok:') });
  assert.match(h.text(), /Saved 3 entries/);
  const trader = h.ledger.trader('test', '7');
  assert.equal(h.ledger.outstanding(trader.id, 'Mama Tunde'), 650000);
  assert.equal(h.ledger.verifyChain(trader.id).ok, true);
});

test('the same photo twice is skipped', async () => {
  const h = harness();
  await h.say({ text: 'hi' });
  const file = async () => new Uint8Array([0xff, 0xd8, 9, 9]);
  await h.say({ type: 'photo', file });
  await h.say({ type: 'photo', file });
  assert.match(h.text(), /already sent this exact photo/);
});

test('typed payment, correction by message, debtors, reminder and passport', async () => {
  const h = harness();
  await h.say({ text: 'hi' });
  await h.say({ type: 'photo', file: async () => new Uint8Array([0xff, 0xd8, 4]) });
  await h.say({ type: 'button', text: h.button('rep:') });
  await h.say({ type: 'button', text: h.button('ok:') });

  await h.say({ text: 'mama tunde paid 2000' });
  assert.match(h.text(), /Mama Tunde paid \*\*₦2,000\*\*/); // matched to the known spelling
  await h.say({ type: 'button', text: h.button('fix:') });
  await h.say({ text: 'it was 2,500' });
  assert.match(h.text(), /₦2,500/);
  await h.say({ type: 'button', text: h.button('ok:') });

  await h.say({ text: '/debtors' });
  assert.match(h.text(), /Mama Tunde: \*\*₦4,000\*\*/);
  await h.say({ type: 'button', text: h.button('rem:') });
  assert.match(h.text(), /₦4,000/); // the model's draft lacked the amount, so the template is used
  await h.say({ text: '/passport' });
  const url = h.text().match(/https:\/\/kudi\.test\/p\/([\w-]+)/);
  assert.ok(url);
});

test('passport page and live verification over HTTP', async () => {
  const h = harness();
  await h.say({ text: 'hi' });
  await h.say({ type: 'photo', file: async () => new Uint8Array([0xff, 0xd8, 5]) });
  await h.say({ type: 'button', text: h.button('rep:') });
  await h.say({ type: 'button', text: h.button('ok:') });
  await h.say({ text: '/shop Ada Provisions' });
  await h.say({ text: '/passport' });
  const token = h.text().match(/\/p\/([\w-]+)/)![1];
  const server = startWeb({ ledger: h.ledger, today: () => '2026-10-28', samplesDir: '/nonexistent' }, 0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await (await fetch(`${base}/p/${token}`)).text();
    assert.match(page, /Ada Provisions/);
    assert.match(page, /₦14,700/);
    assert.doesNotMatch(page, /Mama Tunde/); // customer names never leave the trader's chat
    const v = await (await fetch(`${base}/api/passport/${token}/verify`, { method: 'POST' })).json();
    assert.equal(v.ok, true);
    assert.equal(v.length, 3);
    assert.equal((await fetch(`${base}/p/notavalidtoken`)).status, 404);
  } finally {
    server.close();
  }
});

test('erasing a trader removes their books', async () => {
  const h = harness();
  await h.say({ text: 'hi' });
  await h.say({ type: 'photo', file: async () => new Uint8Array([0xff, 0xd8, 6]) });
  await h.say({ type: 'button', text: h.button('rep:') });
  await h.say({ type: 'button', text: h.button('ok:') });
  await h.say({ text: '/deleteme' });
  await h.say({ type: 'button', text: 'forget:yes' });
  assert.equal(h.ledger.db.prepare('SELECT COUNT(*) AS n FROM entries').get()!.n, 0);
});

test('channel markup is escaped and converted', () => {
  assert.equal(html('**₦5,000** <b>'), '<b>₦5,000</b> &lt;b&gt;');
  assert.equal(wa('**₦5,000**'), '*₦5,000*');
});

test('short names match the one debtor they fit; titles still keep people apart', async () => {
  const { matchShortName } = await import('../src/app.ts');
  assert.equal(matchShortName('Tunde', ['Mama Tunde', 'Bisi'])?.name, 'Mama Tunde');
  assert.equal(matchShortName('Tunde', ['Mama Tunde', 'Baba Tunde']), null);
  assert.equal(matchShortName('Chinedu', ['Mama Tunde']), null);
});

test('transcripts far too short for the recording are rejected', async () => {
  const { plausibleTranscript } = await import('../src/extract.ts');
  assert.equal(plausibleTranscript('Transcribe.', 8), false);
  assert.equal(plausibleTranscript('', 5), false);
  assert.equal(plausibleTranscript('Tunde don pay 50k out of the 100k she dey owe', 8), true);
  assert.equal(plausibleTranscript('Okay', 2), true);
});

/** Two seconds of silence as a WAV file: enough for ffmpeg; the fake transcriber supplies the words. */
function silence(): Uint8Array {
  const n = 16000 * 2 * 2, b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return new Uint8Array(b);
}

/** Voice notes: each transcribe() call returns the next sentence; text is read by what it mentions. */
function voiceMeta(said: string[]): Meta {
  const textOf = (parts: any[]) => parts.map((p) => p.text ?? '').join(' ');
  return {
    async transcribe() { return { transcript: said.shift()!, durationMs: 2000 }; },
    async structured({ name, parts }: { name: string; parts: any[] }) {
      const text = textOf(parts);
      const says = text.split('Trader says:').pop()!;
      if (name === 'text_note' && /Chika/.test(text)) {
        return { transcript: text, language: 'english', english: text, intent: 'record', question: null, lines: [line({ item: 'rice', amount: 15000, paid: 'owed', customer: 'Chika' })] };
      }
      if (name === 'text_note') {
        return { transcript: text, language: 'english', english: text, intent: 'record', question: null, lines: [
          line({ item: 'rice', amount: 10000, paid: 'owed', customer: 'Bisi' }),
          line({ item: 'beans', amount: null, paid: 'owed', customer: 'Emeka' }),
        ] };
      }
      if (name === 'corrections' && /Emeka own/.test(says)) return { action: 'edit', newText: null, edits: [edit({ line: 2, amount: 20000, dueDate: '2026-10-30' })] };
      if (name === 'corrections' && /Chika/.test(says)) return { action: 'add', newText: 'Chika took rice 15,000, she go pay later', edits: [] };
      throw new Error(`unexpected ${name}: ${says}`);
    },
  } as unknown as Meta;
}

test('a voice note after ✏️ Fix completes the waiting lines instead of replacing them', async () => {
  const h = harness(voiceMeta(['I sold rice to Bisi 10,000 and beans to Emeka, both on credit', 'Emeka own na 20,000, he go pay Friday']));
  await h.say({ text: 'hi' });
  await h.say({ type: 'voice', file: async () => silence() });
  assert.match(h.text(), /2\. ⚠️ .*Emeka/);
  assert.match(h.text(), /No amount found/);
  await h.say({ type: 'button', text: h.button('fix:') });
  await h.say({ type: 'voice', file: async () => silence() });
  assert.match(h.text(), /1\. .*Bisi/); // the first customer is still there
  assert.match(h.text(), /2\. .*Emeka.*₦20,000.*due Fri 30 Oct/);
  assert.doesNotMatch(h.text(), /⚠️/);
  await h.say({ type: 'button', text: h.button('ok:') });
  assert.match(h.text(), /Saved 2 entries/);
  const trader = h.ledger.trader('test', '7');
  assert.equal(h.ledger.outstanding(trader.id, 'Bisi'), 1_000_000);
  assert.equal(h.ledger.outstanding(trader.id, 'Emeka'), 2_000_000);
});

test('a new note while lines are waiting is added to them, not swapped for them', async () => {
  const h = harness(voiceMeta(['I sold rice to Bisi 10,000 and beans to Emeka, both on credit', 'Also Chika took rice 15,000, she go pay later']));
  await h.say({ text: 'hi' });
  await h.say({ type: 'voice', file: async () => silence() });
  await h.say({ type: 'voice', file: async () => silence() }); // no Fix tap
  assert.match(h.text(), /1\. .*Bisi/);
  assert.match(h.text(), /2\. .*Emeka/);
  assert.match(h.text(), /3\. .*Chika.*₦15,000/);
});
