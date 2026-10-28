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
  required: ['isLedger', 'pageDate', 'lines', 'writtenTotal', 'writtenTotalText', 'note'],
  properties: {
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
- "X paid 3,000" with no goods = kind "payment" (a customer paying a debt).
- Goods the trader bought to resell ("supply", "bought", "restock") = "stock_in"; "I owe" on a supply means paid "owed" and customer = the supplier.
- Running costs (transport, light/NEPA, rent, levy, food, airtime) = "expense".
- "transfer" / "trf" = transfer, "POS" = pos; otherwise "cash" for paid lines, "unknown" if nothing suggests it.
- A total, sub-total or "balance b/f" line is NOT a transaction: put the total in writtenTotal, never in lines.
- Copy rawText exactly. Never invent a line or a number you cannot see or hear; if a number is unreadable use null and a low confidence.
- confidence: 0.95+ only when every digit is clear.`;

export interface PageResult {
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

function context(today: string, customers: string[]): string {
  const known = customers.length ? `\nCustomers and suppliers already in this trader's books (reuse these spellings when it is clearly the same person): ${customers.slice(0, 80).join(', ')}.` : '';
  return `Today is ${today} (Africa/Lagos). Dates written as DD/MM/YY are day first.${known}`;
}

export async function readPage(meta: Meta, image: { bytes: Uint8Array; mime: string }, opts: { today: string; customers?: string[] }): Promise<PageResult> {
  const raw = await meta.structured<{ isLedger: boolean; pageDate: string | null; lines: RawLine[]; writtenTotal: number | null; writtenTotalText: string | null; note: string }>({
    model: MODELS.reason,
    name: 'ledger_page',
    schema: PAGE_SCHEMA,
    effort: 'medium',
    system: `${RULES}\n\nYou are looking at a photo of a page from the trader's book. Lines without their own date take the page date. Give each line's box on a 0–1000 scale of the full image.\n${context(opts.today, opts.customers ?? [])}`,
    parts: [imagePart(image.bytes, image.mime), textPart('Read this page.')],
  });
  return {
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

/**
 * Muse Spark listens to the voice note directly, so Pidgin, Yoruba, Hausa and Igbo work
 * (Muse Voice Transcribe has no Nigerian languages). Two steps: listen (transcript +
 * translation, a small schema the audio model keeps to), then read the text into entries.
 */
export async function listen(meta: Meta, wav: Uint8Array, model: string = MODELS.audio): Promise<{ transcript: string; language: string; english: string }> {
  return meta.structured({
    model,
    name: 'transcript',
    schema: LISTEN_SCHEMA,
    effort: 'minimal',
    system: 'Transcribe this voice note from a Nigerian market trader word for word, in the language spoken (English, Nigerian Pidgin, Yoruba, Hausa or Igbo, often mixed), then translate it to English. Write numbers as digits. Output only what was said; never add words.',
    parts: [audioPart(wav), textPart('Transcribe.')],
  });
}

export async function readVoice(meta: Meta, wav: Uint8Array, opts: { today: string; customers?: string[]; model?: string }): Promise<VoiceResult> {
  const heard = await listen(meta, wav, opts.model);
  const text = heard.language === 'english' ? heard.transcript : `${heard.transcript}\n(English: ${heard.english})`;
  const r = await readText(meta, text, opts);
  return { ...r, transcript: heard.transcript, language: heard.language, english: heard.english };
}

/** Same reading for typed messages ("sold 3 bags rice to Bisi 7500, she go pay Friday"). */
export async function readText(meta: Meta, text: string, opts: { today: string; customers?: string[] }): Promise<VoiceResult> {
  const raw = await meta.structured<{ transcript: string; language: string; english: string; intent: VoiceResult['intent']; lines: RawLine[]; question: string | null }>({
    model: MODELS.reason,
    name: 'text_note',
    schema: VOICE_SCHEMA,
    effort: 'minimal',
    system: `${RULES}\n\nThe trader typed or said a message. If it records transactions, intent is "record". If it asks about their business (sales, debts, stock), intent is "question". Use box null; transcript is the message itself.\n${context(opts.today, opts.customers ?? [])}`,
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
