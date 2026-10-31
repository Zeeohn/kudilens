// HTTP: the Kudi Passport (lender view), its live verification, the WhatsApp webhook,
// a landing page with sample pages for judges, and a health check.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { addDays } from './app.ts';
import type { ChainCheck, Ledger, Trader } from './ledger.ts';
import { formatNaira } from './money.ts';
import type { WhatsApp } from './channels/whatsapp.ts';

export interface WebOptions {
  ledger: Ledger;
  whatsapp?: WhatsApp | null;
  today: () => string;
  samplesDir: string;
  botUsername?: string;
  waNumber?: string;
  log?: (e: string, d: Record<string, unknown>) => void;
}

export function passportData(ledger: Ledger, trader: Trader, today: string) {
  const all = ledger.confirmed(trader.id);
  const s30 = ledger.summary(trader.id, addDays(today, -29), today);
  const s90 = ledger.summary(trader.id, addDays(today, -89), today);
  const in90 = all.filter((e) => (e.date ?? '') >= addDays(today, -89));
  const days90 = new Set(in90.map((e) => e.date)).size;
  const withEvidence = all.filter((e) => e.evidenceId && ledger.evidence(e.evidenceId)?.kind !== 'text').length;
  const repaid = in90.filter((e) => e.kind === 'payment').reduce((s, e) => s + e.amount, 0);
  const weeks: { start: string; sales: number }[] = [];
  for (let w = 11; w >= 0; w--) {
    const start = addDays(today, -7 * w - 6);
    const end = addDays(today, -7 * w);
    weeks.push({ start, sales: ledger.summary(trader.id, start, end).sales });
  }
  const chain = ledger.verifyChain(trader.id);
  const outstanding = ledger.debtors(trader.id).reduce((s, d) => s + d.owed, 0);
  return {
    business: trader.business ?? trader.name ?? 'Trader',
    since: all.map((e) => e.date).filter(Boolean).sort()[0] ?? null,
    records: all.length,
    days90,
    sales30: s30.sales, sales90: s90.sales, collected90: s90.collected, expenses90: s90.expenses + s90.stockBought,
    creditGiven90: s90.creditGiven, repaid90: repaid, outstanding,
    evidencePct: all.length ? Math.round((withEvidence / all.length) * 100) : 0,
    weeks, chain,
    topItems: s90.topItems.slice(0, 3).map((i) => i.item),
  };
}

/** What a lender reads after Verify. Plain text; the page escapes it. */
export function chainMessage(c: ChainCheck): string {
  if (c.ok) return `Chain intact: all ${c.length} records match their seals.`;
  const r = c.record!;
  const now = [r.kind, r.item, formatNaira(r.amount), r.date].filter(Boolean).join(' · ');
  const before = c.intact > 1 ? ` Records #1–${c.intact} are intact.` : c.intact === 1 ? ' Record #1 is intact.' : '';
  return c.reason === 'changed'
    ? `Record #${r.seq} was changed after it was sealed. It now reads: ${now}, which doesn't match its seal.${before}`
    : `The chain breaks at record #${r.seq}: a record before it was removed, added or reordered.${before}`;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function bars(weeks: { start: string; sales: number }[]): string {
  const max = Math.max(1, ...weeks.map((w) => w.sales));
  const bw = 100 / weeks.length;
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="bars" role="img" aria-label="Weekly sales, last 12 weeks">${weeks.map((w, i) => {
    const h = (w.sales / max) * 36;
    return `<rect x="${(i * bw + bw * 0.15).toFixed(2)}" y="${(38 - h).toFixed(2)}" width="${(bw * 0.7).toFixed(2)}" height="${Math.max(h, 0.4).toFixed(2)}" rx="0.6"><title>Week of ${esc(w.start)}: ${esc(formatNaira(w.sales))}</title></rect>`;
  }).join('')}</svg>`;
}

const STYLE = `:root{--bg:#f6f7f4;--card:#fff;--ink:#14201a;--muted:#5b6b62;--accent:#0f7a4a;--warn:#b45309;--line:#e3e7e1}
@media (prefers-color-scheme:dark){:root{--bg:#0e1411;--card:#16201b;--ink:#e8efe9;--muted:#9fb0a6;--accent:#34c47c;--warn:#f59e0b;--line:#24302a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.05rem;margin:0 0 .6em}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.k{color:var(--muted);font-size:.85rem}.v{font-size:1.3rem;font-weight:650}
.bars{width:100%;height:120px}.bars rect{fill:var(--accent)}.tag{display:inline-block;background:var(--accent);color:#fff;border-radius:99px;padding:2px 10px;font-size:.8rem}
button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:1rem;cursor:pointer}
code{font-size:.8rem;word-break:break-all;color:var(--muted)}.ok{color:var(--accent);font-weight:650}.bad{color:var(--warn);font-weight:650}
.muted{color:var(--muted);font-size:.85rem}#qr svg{width:132px;height:132px}.row{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
a{color:var(--accent)}img.sample{width:100%;max-width:220px;border-radius:10px;border:1px solid var(--line)}`;

function passportHtml(token: string, d: ReturnType<typeof passportData>): string {
  const collectRate = d.creditGiven90 ? Math.min(100, Math.round((d.repaid90 / d.creditGiven90) * 100)) : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kudi Passport · ${esc(d.business)}</title><meta name="robots" content="noindex"><style>${STYLE}</style></head><body><main>
<span class="tag">Kudi Passport</span><h1>${esc(d.business)}</h1>
<p class="muted">Records kept with KudiLens${d.since ? ` since ${esc(d.since)}` : ''}. Customer names are never shown here.</p>
<div class="card grid">
<div><div class="k">Sales, last 30 days</div><div class="v">${esc(formatNaira(d.sales30))}</div></div>
<div><div class="k">Sales, last 90 days</div><div class="v">${esc(formatNaira(d.sales90))}</div></div>
<div><div class="k">Days with records (90)</div><div class="v">${d.days90}</div></div>
<div><div class="k">Backed by photo or voice</div><div class="v">${d.evidencePct}%</div></div>
<div><div class="k">Cash received (90)</div><div class="v">${esc(formatNaira(d.collected90))}</div></div>
<div><div class="k">Spending + stock (90)</div><div class="v">${esc(formatNaira(d.expenses90))}</div></div>
<div><div class="k">Credit given (90)</div><div class="v">${esc(formatNaira(d.creditGiven90))}</div></div>
<div><div class="k">Credit collected (90)</div><div class="v">${collectRate === null ? '–' : `${collectRate}%`}</div></div>
</div>
<div class="card"><h2>Weekly sales, last 12 weeks</h2>${bars(d.weeks)}${d.topItems.length ? `<p class="muted">Best sellers: ${d.topItems.map(esc).join(', ')}</p>` : ''}</div>
<div class="card"><h2>Were these records changed after they were saved?</h2>
<p>Every confirmed record is sealed with a SHA-256 hash that includes the previous record and the fingerprint of the photo or voice note it came from. Changing any old record breaks every seal after it.</p>
<div class="row"><button id="verify">Verify now</button><span id="result" aria-live="polite"><span class="${d.chain.ok ? 'ok">✓ ' : 'bad">✗ '}${esc(chainMessage(d.chain))}</span></span></div>
<p><code id="head">Latest seal: ${esc(d.chain.head)}</code></p></div>
<div class="card row"><div id="qr"></div><p class="muted">Scan to open this passport on another phone.<br>The trader can cancel this link at any time.</p></div>
<p class="muted">What this is: the trader's own records, read from their book and confirmed by them, with arithmetic checked by KudiLens and protected against later edits. It is not an audit or a credit score. Built with Meta Muse Spark and SAM 3.1.</p>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<script>
try{var q=qrcode(0,'M');q.addData(location.href);q.make();document.getElementById('qr').innerHTML=q.createSvgTag({scalable:true,margin:2});}catch(e){}
document.getElementById('verify').onclick=async function(){var r=document.getElementById('result');r.textContent='Checking every seal…';
try{var j=await (await fetch('/api/passport/${esc(token)}/verify',{method:'POST'})).json();
var m=document.createElement('span');m.className=j.ok?'ok':'bad';m.textContent=(j.ok?'✓ Verified just now. ':'✗ Verified just now. ')+j.message;r.replaceChildren(m);
document.getElementById('head').textContent='Latest seal: '+j.head;}catch(e){r.textContent='Could not reach the server.';}};
</script></body></html>`;
}

function landingHtml(o: WebOptions): string {
  const samples = existsSync(o.samplesDir) ? ['page-sales.jpg', 'page-debts.jpg', 'shelf.jpg'].filter((f) => existsSync(join(o.samplesDir, f))) : [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KudiLens</title><style>${STYLE}</style></head><body><main>
<span class="tag">KudiLens</span><h1>Verified books from a photo or a voice note</h1>
<p>Nigerian traders keep their books in exercise books. KudiLens reads a page photo or a voice note in English, Pidgin, Yorùbá, Hausa or Igbo, checks every number, and keeps a tamper-evident ledger the trader can share with a lender as a <b>Kudi Passport</b>.</p>
<div class="card"><h2>Try it in 10 seconds</h2>
<p>${o.botUsername ? `Open <a href="https://t.me/${esc(o.botUsername)}">@${esc(o.botUsername)}</a> on Telegram` : 'Open the Telegram bot'}${o.waNumber ? ` or WhatsApp <b>${esc(o.waNumber)}</b>` : ''}, then send one of these sample pages (or your own):</p>
<div class="row">${samples.map((f) => `<a href="/samples/${f}" download><img class="sample" src="/samples/${f}" alt="Sample ${esc(f)}"></a>`).join('')}</div>
<p class="muted">Samples are synthetic pages made with Muse Image. Then try: a voice note, "who owes me?", /today, /debtors, /stock with a shelf photo, /passport.</p></div>
<div class="card"><h2>How it works</h2><p>The models propose, code verifies. Muse Spark reads pages and voice notes into structured entries; SAM 3.1 counts stock on shelves; Muse Image makes WhatsApp status flyers. Deterministic code checks the arithmetic, repairs a misread digit from the handwritten page total, and posts confirmed entries to a double-entry ledger sealed with a hash chain.</p></div>
</main></body></html>`;
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    parts.push(c);
  }
  return Buffer.concat(parts);
}

export function startWeb(o: WebOptions, port: number): Server {
  const verifyHits = new Map<string, number[]>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
      res.end(body);
    };
    try {
      if (url.pathname === '/health') return send(200, 'ok', 'text/plain');
      if (url.pathname === '/') return send(200, landingHtml(o));

      const sample = url.pathname.match(/^\/samples\/(page-sales|page-debts|shelf)\.jpg$/);
      if (sample) {
        const p = join(o.samplesDir, `${sample[1]}.jpg`);
        if (!existsSync(p)) return send(404, 'not found', 'text/plain');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
        return res.end(readFileSync(p));
      }

      const page = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{8,40})$/);
      if (page) {
        const trader = o.ledger.passportTrader(page[1]);
        if (!trader) return send(404, '<h1>This passport link is not valid or was cancelled.</h1>');
        return send(200, passportHtml(page[1], passportData(o.ledger, trader, o.today())), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
      }

      const verify = url.pathname.match(/^\/api\/passport\/([A-Za-z0-9_-]{8,40})\/verify$/);
      if (verify && req.method === 'POST') {
        const now = Date.now();
        const hits = (verifyHits.get(verify[1]) ?? []).filter((t) => now - t < 60_000);
        if (hits.length >= 20) return send(429, '{"error":"slow down"}', 'application/json');
        verifyHits.set(verify[1], [...hits, now]);
        const trader = o.ledger.passportTrader(verify[1]);
        if (!trader) return send(404, '{"error":"not found"}', 'application/json');
        const check = o.ledger.verifyChain(trader.id);
        return send(200, JSON.stringify({ ...check, message: chainMessage(check) }), 'application/json', { 'Cache-Control': 'no-store' });
      }

      if (url.pathname === '/webhook/whatsapp' && o.whatsapp) {
        if (req.method === 'GET') {
          const challenge = o.whatsapp.verify(url.searchParams);
          return challenge ? send(200, challenge, 'text/plain') : send(403, 'forbidden', 'text/plain');
        }
        if (req.method === 'POST') {
          const raw = await readBody(req);
          if (!o.whatsapp.validSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
            o.log?.('wa_bad_signature', {});
            return send(401, 'bad signature', 'text/plain');
          }
          send(200, 'ok', 'text/plain');
          return o.whatsapp.receive(JSON.parse(raw.toString('utf8')));
        }
      }
      return send(404, 'not found', 'text/plain');
    } catch (err) {
      o.log?.('web_error', { path: url.pathname, error: String(err).slice(0, 300) });
      if (!res.headersSent) send(500, 'error', 'text/plain');
    }
  });
  server.listen(port);
  return server;
}
