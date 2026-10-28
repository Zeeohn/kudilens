// Quick live check of the Meta Model API with the key in .env (prints no secrets).
import { Meta, MODELS } from '../src/meta.ts';
const key = process.env.MODEL_API_KEY ?? '';
const m = new Meta({ apiKey: key, retries: 1 });
const res = await fetch('https://api.meta.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
console.log('models HTTP', res.status, (await res.text()).slice(0, 800));
const t = Date.now();
const r = await m.chat({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }], effort: 'minimal', maxTokens: 2000 });
console.log('chat', MODELS.reason, Date.now() - t, 'ms', JSON.stringify(r.message.content), r.usage);
