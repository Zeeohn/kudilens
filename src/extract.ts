// Extraction: Muse Spark reads a ledger photo or a voice note and proposes entries.
// The model returns naira as written; code converts to kobo and runs every check.

import { audioPart, imagePart, MODELS, textPart, type Meta } from './meta.ts';
import { fromNaira, type Kobo } from './money.ts';
import type { EntryKind, Method, PaidStatus, ProposedEntry } from './verify.ts';

const nullable = (type: string, extra: object = {}) => ({ type: [type, 'null'], ...extra });

const LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'date', 'item', 'quantity', 'unit', 'unitPrice', 'amount', 'paid', 'amountPaid', 'method', 'customer', 'dueDate', 'rawText', 'box', 'confidence'],
  properties: {
    kind: { type: 'string', enum: ['sale', 'expense', 'payment', 'stock_in'] },
    date: nullable('string', { description: 'YYYY-MM-DD, or null when not written or said' }),
    item: nullable('string'),
    quantity: nullable('number'),
    unit: nullable('string', { description: 'bag, carton, paint, crate, bottle, piece, mudu, derica, kg...' }),
    unitPrice: nullable('number', { description: 'naira per unit' }),
    amount: nullable('number', { description: 'total naira value of the line' }),
    paid: { type: 'string', enum: ['paid', 'owed', 'partial'] },
    amountPaid: nullable('number', { description: 'naira paid now, only when partial' }),
    method: { type: 'string', enum: ['cash', 'transfer', 'pos', 'unknown'] },
    customer: nullable('string', { description: 'the customer who owes or paid, or the supplier' }),
    dueDate: nullable('string', { description: 'YYYY-MM-DD when the debt should be paid' }),
    rawText: { type: 'string', description: 'the line exactly as written or spoken' },
    box: nullable('array', { items: { type: 'number' }, description: '[x1, y1, x2, y2] of the line on the image, 0–1000 scale' }),
    confidence: { type: 'number', description: '0–1: how sure you are of the amount and meaning' },
  },
};

export const PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['photoKind', 'isLedger', 'pageDate', 'lines', 'writtenTotal', 'writtenTotalText', 'note'],
  properties: {
    photoKind: {
      type: 'string', enum: ['book_page', 'goods', 'other'],
      description: 'book_page: handwritten or printed business records. goods: goods for sale (on shelves, hanging from a wall or rope in strips of sachets, on a table or tray, in crates or bags, stacked on the floor), labelled or not, priced or not. other: anything else',
    },
    isLedger: { type: 'boolean', description: 'false if the image is not a page of business records' },
    pageDate: nullable('string', { description: 'YYYY-MM-DD from the page heading' }),
    lines: { type: 'array', items: LINE },
    writtenTotal: nullable('number', { description: 'the total the trader wrote on the page, in naira' }),
    writtenTotalText: nullable('string'),
    note: { type: 'string', description: 'anything unclear, in one short sentence; empty if none' },
  },
};

export const VOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transcript', 'language', 'english', 'intent', 'lines', 'question'],
  properties: {
    transcript: { type: 'string', description: 'what was said, in the original language' },
    language: { type: 'string', enum: ['english', 'pidgin', 'yoruba', 'hausa', 'igbo', 'other'] },
    english: { type: 'string', description: 'English translation' },
    intent: { type: 'string', enum: ['record', 'question', 'other'] },
    lines: { type: 'array', items: LINE },
    question: nullable('string', { description: 'if the trader asked a question, the question in English' }),
  },
};

const RULES = `You keep the books for a Nigerian market trader. Read what they recorded and return each transaction as one line.

Conventions traders use:
- Amounts in naira: "5,000", "5000/=", "N5000", "5k" = 5000. "paint", "mudu" and "derica" are measures. "@" or "x" means per unit.
- "owe", "credit", "on credit", "go pay", "bal" (balance) = sold on credit. "paid 4,000 bal 5,000" on a 9,000 sale = partial, amountPaid 4000.
- A customer paying back all or PART of what they owe ("X paid 3,000", "Tunde don pay 50k", "she pay half", "she balance me", "e remain 20k") = kind "payment", amount = what was paid NOW. If they only say what is left ("remain 20k"), amount = what the customer owed (see below) minus what is left; "half" = half of what they owe. customer = the debtor's name as written in the books.
- Goods the trader bought to resell ("supply", "bought", "restock") = "stock_in"; "I owe" on a supply means paid "owed" and customer = the supplier.
- A page listing goods with amounts is the day's SALES ("sale") unless the page itself says the goods were bought (supply, bought, restock, purchase, "from" a supplier). A shop name at the top or a Total line at the bottom does not make it a purchase list.
- Running costs (transport, light/NEPA, rent, levy, food, airtime) = "expense".
- "transfer" / "trf" = transfer, "POS" = pos; otherwise "cash" for paid lines, "unknown" if nothing suggests it.
- A total, sub-total or "balance b/f" line is NOT a transaction: put the total in writtenTotal, never in lines.
- Copy rawText exactly. Never invent a line or a number you cannot see or hear; if a number is unreadable use null and a low confidence.
- confidence: 0.95+ only when every digit is clear.`;

export type PhotoKind = 'book_page' | 'goods' | 'other';

export interface PageResult {
  photoKind: PhotoKind;
  isLedger: boolean;
  pageDate: string | null;
  lines: ProposedEntry[];
  writtenTotal: Kobo | null;
  writtenTotalText: string | null;
  note: string;
}

export interface VoiceResult {
  transcript: string;
  language: string;
  english: string;
  intent: 'record' | 'question' | 'other';
  lines: ProposedEntry[];
  question: string | null;
}

interface RawLine {
  kind: EntryKind; date: string | null; item: string | null; quantity: number | null; unit: string | null;
  unitPrice: number | null; amount: number | null; paid: PaidStatus; amountPaid: number | null; method: Method;
  customer: string | null; dueDate: string | null; rawText: string; box: number[] | null; confidence: number;
}

export interface ReadOptions { today: string; customers?: string[]; debtors?: { name: string; owed: Kobo }[] }

function context(o: ReadOptions): string {
  const customers = o.customers ?? [];
  const known = customers.length ? `\nCustomers and suppliers already in this trader's books (reuse these spellings when it is clearly the same person, e.g. "Tunde" for "Mama Tunde" if there is only one Tunde): ${customers.slice(0, 80).join(', ')}.` : '';
  const owing = o.debtors?.length ? `\nWho owes the trader right now: ${o.debtors.slice(0, 40).map((d) => `${d.name} ₦${(d.owed / 100).toLocaleString('en-NG')}`).join('; ')}.` : '';
  return `Today is ${o.today} (Africa/Lagos). Dates written as DD/MM/YY are day first.${known}${owing}`;
}

export async function readPage(meta: Meta, image: { bytes: Uint8Array; mime: string }, opts: ReadOptions): Promise<PageResult> {
  const raw = await meta.structured<{ photoKind: PhotoKind; isLedger: boolean; pageDate: string | null; lines: RawLine[]; writtenTotal: number | null; writtenTotalText: string | null; note: string }>({
    model: MODELS.reason,
    name: 'ledger_page',
    schema: PAGE_SCHEMA,
    effort: 'medium',
    system: `${RULES}\n\nYou are looking at a photo of a page from the trader's book. Lines without their own date take the page date. Give each line's box on a 0–1000 scale of the full image.\n${context(opts)}`,
    parts: [imagePart(image.bytes, image.mime), textPart('Read this page.')],
  });
  return {
    photoKind: raw.photoKind ?? (raw.isLedger ? 'book_page' : 'other'),
    isLedger: raw.isLedger,
    pageDate: validDate(raw.pageDate),
    lines: raw.lines.map((l) => toEntry(l, validDate(raw.pageDate) ?? opts.today)),
    writtenTotal: raw.writtenTotal !== null && raw.writtenTotal > 0 ? fromNaira(raw.writtenTotal) : null,
    writtenTotalText: raw.writtenTotalText,
    note: raw.note,
  };
}

export const LISTEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transcript', 'language', 'english'],
  properties: {
    transcript: { type: 'string', description: 'word for word, in the language spoken' },
    language: { type: 'string', enum: ['english', 'pidgin', 'yoruba', 'hausa', 'igbo', 'other'] },
    english: { type: 'string', description: 'English translation' },
  },
};

export interface Heard { transcript: string; language: string; english: string; model: string }

/**
 * Muse Spark listens to the voice note directly, so Pidgin, Yoruba, Hausa and Igbo work
 * (Muse Voice Transcribe has no Nigerian languages). Two steps: listen (transcript +
 * translation, a small schema the audio model keeps to), then read the text into entries.
 * Audio models sometimes return nothing useful (or echo the instruction), so a transcript
 * far too short for the length of the recording is retried on the next model.
 */
export async function listen(meta: Meta, wav: Uint8Array, opts: { seconds: number; models?: string[] }): Promise<Heard> {
  const models = opts.models ?? [MODELS.audio, 'muse-spark-1.2'];
  let best: Heard | null = null;
  for (const model of models) {
    const h = await meta.structured<Omit<Heard, 'model'>>({
      model,
      name: 'transcript',
      schema: LISTEN_SCHEMA,
      effort: 'minimal',
      system: 'You are a transcriber. The user message is a voice note from a Nigerian market trader. Write down word for word what the speaker says, in the language spoken (English, Nigerian Pidgin, Yoruba, Hausa or Igbo, often mixed), then translate it to English. Write numbers as digits. Never add, summarise or answer; if nothing is audible, return an empty transcript.',
      parts: [audioPart(wav)],
    }).catch(() => null);
    if (!h) continue;
    const heard = { ...h, model };
    if (plausibleTranscript(heard.transcript, opts.seconds)) return heard;
    if (!best || heard.transcript.length > best.transcript.length) best = heard;
  }
  return best ?? { transcript: '', language: 'other', english: '', model: models[0] };
}

/** People speak about 2–3 words a second; under a third of a word per second means we missed it. */
export function plausibleTranscript(text: string, seconds: number): boolean {
  const t = text.trim();
  if (!t || /^(transcribe|transcript|listen)[.!]?$/i.test(t)) return false;
  const words = t.split(/\s+/).length;
  return seconds < 3 || words >= Math.min(6, seconds / 3);
}

export async function readVoice(meta: Meta, wav: Uint8Array, opts: ReadOptions & { seconds: number; models?: string[] }): Promise<VoiceResult & { model: string }> {
  const heard = await listen(meta, wav, opts);
  if (!heard.transcript.trim()) return { transcript: '', language: heard.language, english: '', intent: 'other', lines: [], question: null, model: heard.model };
  const text = heard.language === 'english' ? heard.transcript : `${heard.transcript}\n(English: ${heard.english})`;
  const r = await readText(meta, text, opts);
  return { ...r, transcript: heard.transcript, language: heard.language, english: heard.english, model: heard.model };
}

/** Same reading for typed messages ("sold 3 bags rice to Bisi 7500, she go pay Friday"). */
export async function readText(meta: Meta, text: string, opts: ReadOptions): Promise<VoiceResult> {
  const raw = await meta.structured<{ transcript: string; language: string; english: string; intent: VoiceResult['intent']; lines: RawLine[]; question: string | null }>({
    model: MODELS.reason,
    name: 'text_note',
    schema: VOICE_SCHEMA,
    effort: 'minimal',
    system: `${RULES}\n\nThe trader typed or said a message. If it records transactions, intent is "record". If it asks about their business (sales, debts, stock), intent is "question". Use box null; transcript is the message itself.\n${context(opts)}`,
    parts: [textPart(text)],
  });
  return { ...raw, lines: raw.lines.map((l) => toEntry(l, opts.today)) };
}

export function toEntry(l: RawLine, fallbackDate: string): ProposedEntry {
  const box = Array.isArray(l.box) && l.box.length === 4 && l.box.every((n) => Number.isFinite(n))
    ? l.box.map((n) => Math.max(0, Math.min(1000, Math.round(n)))) as [number, number, number, number]
    : null;
  const amount = l.amount !== null && l.amount > 0 ? fromNaira(l.amount)
    : l.quantity && l.unitPrice ? fromNaira(l.quantity * l.unitPrice) : 0;
  return {
    kind: l.kind,
    date: validDate(l.date) ?? fallbackDate,
    item: clean(l.item),
    quantity: l.quantity !== null && l.quantity > 0 ? l.quantity : null,
    unit: clean(l.unit),
    unitPrice: l.unitPrice !== null && l.unitPrice > 0 ? fromNaira(l.unitPrice) : null,
    amount,
    paid: l.kind === 'payment' || l.kind === 'expense' ? 'paid' : l.paid,
    amountPaid: l.paid === 'partial' && l.amountPaid !== null ? fromNaira(l.amountPaid) : null,
    method: l.method,
    customer: clean(l.customer),
    dueDate: validDate(l.dueDate),
    rawText: l.rawText.slice(0, 300),
    region: box,
    confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0)),
  };
}

function validDate(s: string | null): string | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

function clean(s: string | null): string | null {
  const t = s?.trim();
  return t ? t.slice(0, 80) : null;
}
