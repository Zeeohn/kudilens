// Read one page photo live and print the proposed entries and the total check.
import { readFileSync } from 'node:fs';
import { Meta } from '../src/meta.ts';
import { readPage } from '../src/extract.ts';
import { checkEntry, reconcileTotal } from '../src/verify.ts';
import { formatNaira } from '../src/money.ts';

const m = new Meta({ apiKey: process.env.MODEL_API_KEY ?? '' });
const path = process.argv[2];
const t = Date.now();
const r = await readPage(m, { bytes: readFileSync(path), mime: path.endsWith('.png') ? 'image/png' : 'image/jpeg' }, { today: '2026-10-28' });
console.log(`${path}: ${Date.now() - t} ms, ledger=${r.isLedger}, date=${r.pageDate}, total=${r.writtenTotal && formatNaira(r.writtenTotal)} note=${r.note}`);
for (const e of r.lines) console.log(' ', e.kind, e.paid, formatNaira(e.amount), e.amountPaid ? `paid ${formatNaira(e.amountPaid)}` : '', e.item, e.quantity, e.unit, e.customer ?? '', e.method, e.confidence, JSON.stringify(e.region), checkEntry(e, '2026-10-28').map((f) => f.code).join(','));
console.log(' total check:', JSON.stringify(reconcileTotal(r.lines, r.writtenTotal)));
