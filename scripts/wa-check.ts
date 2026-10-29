// Checks the WhatsApp settings in .env against Meta and the running server (prints no secrets):
//   node --env-file=.env scripts/wa-check.ts [https://public-url]
// 1. the token can read the phone number, 2. the app secret matches the token's app,
// 3. the app is subscribed to the WhatsApp Business Account (subscribes it if not; without this
//    the webhook verifies but real messages never arrive), 4. our webhook answers Meta's handshake.
import { createHmac } from 'node:crypto';

const env = process.env;
const graph = `https://graph.facebook.com/${env.WA_GRAPH_VERSION || 'v23.0'}`;
const publicUrl = (process.argv[2] ?? env.PUBLIC_URL ?? '').replace(/\/$/, '');
let failed = false;
const ok = (s: string) => console.log(`✅ ${s}`);
const bad = (s: string) => { failed = true; console.log(`❌ ${s}`); };

for (const k of ['WA_TOKEN', 'WA_PHONE_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'WA_WABA_ID']) {
  if (!env[k]) bad(`${k} is empty in .env`);
}
if (failed) process.exit(1);

const proof = createHmac('sha256', env.WA_APP_SECRET!).update(env.WA_TOKEN!).digest('hex');
async function call(path: string, init: RequestInit = {}, withProof = false): Promise<any> {
  const url = new URL(`${graph}/${path}`);
  if (withProof) url.searchParams.set('appsecret_proof', proof);
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' } });
  return res.json();
}

const phone = await call(`${env.WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating`);
if (phone.error) bad(`token/phone ID: ${phone.error.message}`);
else ok(`token reads ${phone.verified_name} (${phone.display_phone_number})`);

const withProof = await call(`${env.WA_PHONE_ID}?fields=id`, {}, true);
if (withProof.error) bad(`app secret: ${withProof.error.message} (copy it from App settings → Basic of the same app)`);
else ok('app secret belongs to the same app as the token');

const app = await call('app?fields=id,name');
let subs = await call(`${env.WA_WABA_ID}/subscribed_apps`);
if (subs.error) bad(`WhatsApp Business Account ID: ${subs.error.message}`);
else {
  const mine = (s: any) => (s.data ?? []).some((d: any) => (d.whatsapp_business_api_data?.id ?? d.id) === app.id);
  if (!mine(subs)) {
    const r = await call(`${env.WA_WABA_ID}/subscribed_apps`, { method: 'POST' });
    if (r.error) bad(`subscribing the app to the account: ${r.error.message}`);
    subs = await call(`${env.WA_WABA_ID}/subscribed_apps`);
  }
  if (mine(subs)) ok(`app "${app.name ?? app.id}" is subscribed to the WhatsApp Business Account`);
  else if (!app.id) ok(`subscribed apps: ${(subs.data ?? []).map((d: any) => d.whatsapp_business_api_data?.name).join(', ') || 'none'}`);
  else bad('the app is still not subscribed to the WhatsApp Business Account');
}

if (!/^https:\/\//.test(publicUrl)) bad(`no HTTPS public URL to test the webhook (got "${publicUrl || 'nothing'}")`);
else {
  const challenge = String(Date.now());
  const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': env.WA_VERIFY_TOKEN!, 'hub.challenge': challenge });
  try {
    const res = await fetch(`${publicUrl}/webhook/whatsapp?${q}`);
    const body = await res.text();
    if (res.ok && body === challenge) ok(`webhook answers at ${publicUrl}/webhook/whatsapp`);
    else bad(`webhook at ${publicUrl}/webhook/whatsapp returned ${res.status} (is the bot restarted with the WA_* values?)`);
  } catch (e) {
    bad(`cannot reach ${publicUrl}: ${(e as Error).message}`);
  }
}

console.log(failed ? '\nFix the ❌ lines and run this again.' : '\nAll good: message the business number from a phone on the recipient list and say "hi".');
process.exit(failed ? 1 : 0);
