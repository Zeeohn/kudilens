// Accuracy harness. Ground truth lives next to each page/voice file as JSON:
//   pages:  { "image": "x.jpg", "total": 21300 | null, "lines": [{ kind, amount, paid, customer }] }
//   voice:  { "audio": "x.ogg", "language": "yoruba", "lines": [...] }
// Public synthetic samples: eval/samples/. Real, consented trader data: eval/private/ (git-ignored).
// Usage: node --env-file=.env eval/run.ts [pages|voice|repair|all]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPage, readVoice, readText } from '../src/extract.ts';
import { toWav, wavSeconds } from '../src/media.ts';
import { Meta } from '../src/meta.ts';
import { fromNaira } from '../src/money.ts';
import { misreadings, normalizeName, reconcileTotal, type ProposedEntry } from '../src/verify.ts';

interface Truth { kind: string; amount: number; paid: string; customer: string | null }
const what = process.argv[2] ?? 'all';
const dirs = ['eval/samples', 'eval/private'].filter(existsSync);
const files = (ext: RegExp) => dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)))
  .map((p) => ({ p, j: JSON.parse(readFileSync(p, 'utf8')) })).filter(({ j }) => ext.test(j.image ?? j.audio ?? ''));
const meta = new Meta({ apiKey: process.env.MODEL_API_KEY ?? '' });
const report: string[] = [`# KudiLens eval (${new Date().toISOString().slice(0, 10)})`, ''];

/** Greedy match of predicted lines to truth by kind + amount; then score fields. */
function score(pred: ProposedEntry[], truth: Truth[]) {
  const used = new Set<number>();
  let matched = 0, paidOk = 0, customerOk = 0;
  for (const t of truth) {
    const i = pred.findIndex((p, k) => !used.has(k) && p.kind === t.kind && p.amount === fromNaira(t.amount));
    if (i < 0) continue;
    used.add(i); matched++;
    if (pred[i].paid === t.paid) paidOk++;
    if (normalizeName(pred[i].customer ?? '') === normalizeName(t.customer ?? '')) customerOk++;
  }
  return { truth: truth.length, pred: pred.length, matched, paidOk, customerOk };
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '–');

if (what === 'pages' || what === 'all') {
  const rows: string[] = [];
  const tot = { truth: 0, pred: 0, matched: 0, paidOk: 0, customerOk: 0, totals: 0, totalsOk: 0, reconciled: 0, ms: 0, n: 0 };
  for (const { p, j } of files(/\.(jpe?g|png)$/i)) {
    const img = readFileSync(join(p, '..', j.image));
    const t = Date.now();
    const r = await readPage(meta, { bytes: img, mime: j.image.endsWith('.png') ? 'image/png' : 'image/jpeg' }, { today: new Date().toISOString().slice(0, 10) });
    const ms = Date.now() - t;
    const s = score(r.lines, j.lines);
    const rec = reconcileTotal(r.lines, r.writtenTotal);
    for (const k of ['truth', 'pred', 'matched', 'paidOk', 'customerOk'] as const) tot[k] += s[k];
    // totalIsWrong: the trader's own sum is wrong, so the right answer is a warning, not a match.
    if (j.total) { tot.totals++; if (r.writtenTotal === fromNaira(j.total)) tot.totalsOk++; if (j.totalIsWrong ? rec.status === 'mismatch' : rec.status === 'match' || rec.status === 'repaired') tot.reconciled++; }
    tot.ms += ms; tot.n++;
    rows.push(`| ${j.image} | ${s.matched}/${s.truth} | ${s.pred} | ${rec.status} | ${ms} ms |`);
    console.log(j.image, s, rec.status, ms);
  }
  report.push('## Ledger pages (Muse Spark 1.3 vision)', '', `Pages: ${tot.n}. Lines found with the exact kind and amount: **${pct(tot.matched, tot.truth)}** (${tot.matched}/${tot.truth}); extra lines: ${tot.pred - tot.matched}. Paid status correct: ${pct(tot.paidOk, tot.matched)}. Customer correct: ${pct(tot.customerOk, tot.matched)}. Written total read correctly: ${pct(tot.totalsOk, tot.totals)}. Total check right (match or one repair; a warning where the trader's own total is wrong): ${pct(tot.reconciled, tot.totals)}. Average time: ${tot.n ? Math.round(tot.ms / tot.n) : 0} ms.`, '',
    '| Page | Lines matched | Lines predicted | Total check | Time |', '|---|---|---|---|---|', ...rows, '');
}

if (what === 'voice' || what === 'all') {
  const routes: Record<string, (wav: Uint8Array, lang: string) => Promise<ProposedEntry[]>> = {
    'spark-1.3 listen → text': async (wav) => (await readVoice(meta, wav, { today: '2026-10-28', seconds: wavSeconds(wav), models: ['muse-spark-1.3'] })).lines,
    'spark-1.2 listen → text': async (wav) => (await readVoice(meta, wav, { today: '2026-10-28', seconds: wavSeconds(wav), models: ['muse-spark-1.2'] })).lines,
    'voice-transcribe → text': async (wav) => (await readText(meta, (await meta.transcribe(wav)).transcript || '(empty)', { today: '2026-10-28' })).lines,
  };
  const byLang = new Map<string, Record<string, { m: number; t: number }>>();
  for (const { p, j } of files(/\.(ogg|oga|opus|m4a|mp3|wav)$/i)) {
    const wav = await toWav(readFileSync(join(p, '..', j.audio)));
    for (const [name, fn] of Object.entries(routes)) {
      const lines = await fn(wav, j.language).catch(() => []);
      const s = score(lines, j.lines);
      const row = byLang.get(j.language) ?? {};
      row[name] = { m: (row[name]?.m ?? 0) + s.matched, t: (row[name]?.t ?? 0) + s.truth };
      byLang.set(j.language, row);
      console.log(j.audio, name, s);
    }
  }
  if (byLang.size) report.push('## Voice notes: lines found with the exact kind and amount, by route', '', `| Language | ${Object.keys(routes).join(' | ')} |`, `|---|${Object.keys(routes).map(() => '---').join('|')}|`,
    ...[...byLang].map(([lang, r]) => `| ${lang} | ${Object.keys(routes).map((k) => r[k] ? `${pct(r[k].m, r[k].t)} (${r[k].m}/${r[k].t})` : '–').join(' | ')} |`), '');
}

if (what === 'repair' || what === 'all') {
  // Simulate every single-digit misreading on every page with a total, and check the repair.
  let cases = 0, fixed = 0, asked = 0, wrong = 0;
  for (const { j } of files(/./)) {
    if (!j.total || !j.lines || j.totalIsWrong) continue;
    const truth: ProposedEntry[] = j.lines.map((l: Truth) => ({ kind: l.kind, date: null, item: null, unit: null, quantity: (l as any).quantity ?? null, unitPrice: (l as any).unitPrice ? fromNaira((l as any).unitPrice) : null, amount: fromNaira(l.amount), paid: l.paid, amountPaid: null, method: 'cash', customer: l.customer, dueDate: null, rawText: '', region: null, confidence: 1 }));
    truth.forEach((line, i) => {
      if (line.kind !== 'sale') return;
      for (const m of misreadings(line.amount)) {
        const misread = truth.map((e, k) => (k === i ? { ...e, amount: m.value } : e));
        const r = reconcileTotal(misread, fromNaira(j.total));
        cases++;
        if (r.status === 'repaired' && r.repairs[0].target === i && r.repairs[0].to === line.amount) fixed++;
        else if (r.status === 'ambiguous' || r.status === 'mismatch') asked++;
        else wrong++;
      }
    });
  }
  report.push('## Digit repair (simulated misreads)', '', `Every confusable-digit or dropped/extra-zero misreading of every sale line, on pages with a written total: ${cases} cases. Repaired to the right value: **${pct(fixed, cases)}**. Flagged for the trader instead: ${pct(asked, cases)}. Wrong repair: ${pct(wrong, cases)}.`, '');
}

writeFileSync('eval/results.md', report.join('\n'));
console.log('\n' + report.join('\n'));
