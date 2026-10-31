// Tamper demo for the video: change one sealed amount straight in the database, the way a
// dishonest edit would, and show that Verify catches it. Then put it back.
//
//   node scripts/tamper-demo.ts --selftest                       # temp ledger, nothing real touched
//   node scripts/tamper-demo.ts <db> [--trader ID] [--seq N] [--amount NAIRA]
//   node scripts/tamper-demo.ts <db> --restore
//
// Without --trader it picks the trader with the newest live passport; without --seq, the middle
// record; without --amount, the same amount with a zero added. The original row is saved to
// <db>.tamper-undo.json and --restore writes it back, so the chain verifies again.
// Use it on a demo trader only. It prints no customer names.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { formatNaira } from '../src/money.ts';
import { chainMessage } from '../src/web.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const show = (l: Ledger, traderId: number) => {
  const c = l.verifyChain(traderId);
  console.log(`  ${c.ok ? '✓' : '✗'} ${chainMessage(c)}`);
  return c;
};

if (args.includes('--selftest')) {
  const dir = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'kl-tamper-'));
  const db = join(dir, 'kudilens.sqlite');
  const l = new Ledger(db);
  const t = l.trader('test', 'demo');
  const { evidence } = l.addEvidence(t.id, 'photo', new TextEncoder().encode('page'), { mime: 'image/jpeg' });
  const sale = (item: string, amount: number) => ({ entry: { kind: 'sale' as const, date: '2026-10-29', item, quantity: null, unit: null, unitPrice: null, amount, paid: 'paid' as const, amountPaid: null, method: 'cash' as const, customer: null, dueDate: null, rawText: item, region: null, confidence: 1 }, flags: [] });
  l.confirm(l.propose(t.id, evidence.id, [sale('Rice', 1470000), sale('Beans', 650000), sale('Garri', 300000)]).map((e) => e.id));
  l.newPassport(t.id);
  l.db.close();
  await run(db, null);
  await restore(db);
  rmSync(dir, { recursive: true, force: true });
} else if (!args[0] || args[0].startsWith('--')) {
  console.log('usage: node scripts/tamper-demo.ts <db> [--trader ID] [--seq N] [--amount NAIRA] | <db> --restore | --selftest');
  process.exit(1);
} else if (args.includes('--restore')) {
  await restore(args[0]);
} else {
  await run(args[0], opt('trader') ? Number(opt('trader')) : null);
}

async function run(db: string, traderArg: number | null) {
  const undo = `${db}.tamper-undo.json`;
  if (existsSync(undo)) { console.log(`An undo file already exists (${undo}). Run --restore first.`); process.exit(1); }
  const l = new Ledger(db);
  const traderId = traderArg ?? (l.db.prepare('SELECT trader_id FROM passports WHERE revoked = 0 ORDER BY created_at DESC LIMIT 1').get() as any)?.trader_id;
  if (!traderId) { console.log('No trader with a live passport. Pass --trader ID.'); process.exit(1); }
  const records = l.confirmed(traderId);
  if (!records.length) { console.log(`Trader ${traderId} has no confirmed records.`); process.exit(1); }
  const seq = opt('seq') ? Number(opt('seq')) : records[Math.floor((records.length - 1) / 2)].seq!;
  const target = records.find((e) => e.seq === seq);
  if (!target) { console.log(`No record #${seq} (trader has ${records.length}).`); process.exit(1); }
  const newAmount = opt('amount') ? Math.round(Number(opt('amount')) * 100) : target.amount * 10;

  console.log(`Trader ${traderId}, ${records.length} sealed records. Before:`);
  const before = show(l, traderId);
  if (!before.ok) { console.log('The chain is already broken; not touching it.'); process.exit(1); }

  const row = l.db.prepare('SELECT id, data FROM entries WHERE id = ?').get(target.id) as { id: string; data: string };
  writeFileSync(undo, JSON.stringify(row), { mode: 0o600 });
  l.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.data), amount: newAmount }), row.id);

  console.log(`\nEdited record #${seq} (${target.kind}, ${target.item ?? '–'}): ${formatNaira(target.amount)} → ${formatNaira(newAmount)}, directly in SQLite. After:`);
  show(l, traderId);
  const token = (l.db.prepare('SELECT token FROM passports WHERE trader_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1').get(traderId) as any)?.token;
  if (token && process.env.PUBLIC_URL) console.log(`\nPassport: ${process.env.PUBLIC_URL}/p/${token} → press Verify.`);
  console.log(`Undo: node scripts/tamper-demo.ts ${db} --restore`);
  l.db.close();
}

async function restore(db: string) {
  const undo = `${db}.tamper-undo.json`;
  if (!existsSync(undo)) { console.log('Nothing to restore.'); return; }
  const row = JSON.parse(readFileSync(undo, 'utf8')) as { id: string; data: string };
  const l = new Ledger(db);
  l.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(row.data, row.id);
  const traderId = (l.db.prepare('SELECT trader_id FROM entries WHERE id = ?').get(row.id) as any).trader_id;
  rmSync(undo);
  console.log('\nRestored the original record. Now:');
  show(l, traderId);
  l.db.close();
}
