// Entry point: reads .env (via node --env-file), starts Telegram, WhatsApp and the web server.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { App, lagosDate } from './app.ts';
import { Telegram } from './channels/telegram.ts';
import { WhatsApp } from './channels/whatsapp.ts';
import { Ledger } from './ledger.ts';
import { Meta } from './meta.ts';
import { startWeb } from './web.ts';

const env = process.env;
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

if (!env.MODEL_API_KEY) throw new Error('MODEL_API_KEY is missing from .env');
const dataDir = env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const usage = { calls: 0, tokens: 0 };
const meta = new Meta({
  apiKey: env.MODEL_API_KEY,
  onUsage: (u) => { if (u.kind === 'chat.tokens') usage.tokens += u.usage?.total_tokens ?? 0; else usage.calls++; },
});
const open = env.OPEN_BASE_URL && env.OPEN_API_KEY && env.OPEN_MODEL
  ? { client: new Meta({ apiKey: env.OPEN_API_KEY, baseUrl: env.OPEN_BASE_URL }), model: env.OPEN_MODEL }
  : null;

const ledger = new Ledger(join(dataDir, 'kudilens.sqlite'));
const app = new App({ meta, ledger, dataDir, publicUrl: (env.PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, ''), open, log });

const whatsapp = env.WA_TOKEN && env.WA_PHONE_ID && env.WA_VERIFY_TOKEN && env.WA_APP_SECRET
  ? new WhatsApp({ token: env.WA_TOKEN, phoneNumberId: env.WA_PHONE_ID, verifyToken: env.WA_VERIFY_TOKEN, appSecret: env.WA_APP_SECRET, graphVersion: env.WA_GRAPH_VERSION }, app, log)
  : null;

const port = Number(env.PORT ?? 8080);
startWeb({
  ledger, whatsapp, today: () => app.today(), samplesDir: join(import.meta.dirname, '..', 'eval', 'samples'),
  botUsername: env.TG_USERNAME, waNumber: env.WA_DISPLAY_NUMBER, log,
}, port);
log('web', { port, whatsapp: !!whatsapp, open: open?.model ?? null });

const telegram = env.TG_TOKEN ? new Telegram(env.TG_TOKEN, app, log) : null;
void telegram?.start();
log('telegram', { enabled: !!telegram });

// Evening summary at 20:00 Lagos for traders who recorded something today. WhatsApp only
// allows free-form messages within 24 h of the trader's last message, so check that too.
let lastRun = '';
setInterval(() => {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(now));
  const today = lagosDate(now);
  if (hour !== 20 || lastRun === today) return;
  lastRun = today;
  for (const trader of ledger.traders()) {
    const text = app.summaryText(trader, today, today, 'todayTitle');
    if (!text) continue;
    const st = ledger.getState<{ lastActive: number }>(trader.id);
    if (trader.channel === 'whatsapp' && whatsapp && Date.now() - (st.lastActive ?? 0) < 23 * 3_600_000) {
      void whatsapp.send(trader.channelUser, { text: `🌙 ${text}` }).catch((e) => log('summary_error', { error: String(e) }));
    } else if (trader.channel === 'telegram' && telegram) {
      void telegram.send(trader.channelUser, { text: `🌙 ${text}` }).catch((e) => log('summary_error', { error: String(e) }));
    }
  }
}, 60_000);

setInterval(() => log('usage', usage), 3_600_000);
process.on('SIGTERM', () => { telegram?.stop(); process.exit(0); });
