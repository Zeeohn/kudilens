// Draft Yoruba, Hausa and Igbo interface text with Muse Spark (from the English and
// Pidgin tables). Output: src/i18n-drafts.json. A native speaker must review it.
import { writeFileSync } from 'node:fs';
import { EN } from '../src/i18n.ts';
import { Meta } from '../src/meta.ts';

const m = new Meta({ apiKey: process.env.MODEL_API_KEY ?? '' });
const keys = Object.keys(EN);
const schema = { type: 'object', additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])) };
const out: Record<string, Record<string, string>> = {};
await Promise.all([['yo', 'Yoruba (with correct tone marks)'], ['ha', 'Hausa'], ['ig', 'Igbo']].map(async ([code, name]) => {
  out[code] = await m.structured<Record<string, string>>({
    name: `ui_${code}`, effort: 'medium', schema,
    system: `Translate the interface text of a bookkeeping chat bot for Nigerian market traders into everyday ${name}, the way traders in a Lagos/Kano/Onitsha market actually speak. Keep it short and warm. Keep emojis, **bold** markers, slash commands (/today, /deleteme ...), {placeholders} and naira amounts exactly unchanged. Common loanwords (POS, transfer, WhatsApp, passport) may stay in English.`,
    parts: [{ type: 'text', text: JSON.stringify(EN) }],
  });
  console.log(code, 'done');
}));
writeFileSync('src/i18n-drafts.json', JSON.stringify(out, null, 1) + '\n');
