// Deterministic checks on what the models extracted. The models propose entries;
// nothing here calls a model, so every verdict is reproducible and testable.

import { formatNaira, type Kobo } from './money.ts';

export type EntryKind = 'sale' | 'expense' | 'payment' | 'stock_in';
export type PaidStatus = 'paid' | 'owed' | 'partial';
export type Method = 'cash' | 'transfer' | 'pos' | 'unknown';

/** A ledger line as proposed by extraction, before the trader confirms it. */
export interface ProposedEntry {
  kind: EntryKind;
  date: string | null; // YYYY-MM-DD
  item: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: Kobo | null;
  amount: Kobo; // total value of the line
  paid: PaidStatus;
  amountPaid: Kobo | null; // only for partial
  method: Method;
  customer: string | null; // who owes, who paid, or the supplier
  dueDate: string | null;
  rawText: string; // exactly as written or spoken
  region: [number, number, number, number] | null; // box on the page, 0–1000 coordinates
  confidence: number; // 0–1, the model's own estimate
}

export interface Flag {
  code: 'math' | 'missing_amount' | 'who_owes' | 'partial' | 'overpaid' | 'unknown_debtor' | 'future_date' | 'old_date' | 'duplicate' | 'low_confidence' | 'total_mismatch' | 'total_repair';
  message: string;
  suggestion?: Partial<ProposedEntry>;
}

const CONFIRM_BELOW = 0.85;

// ---------------------------------------------------------------- single-entry checks

export function checkEntry(e: ProposedEntry, today: string): Flag[] {
  const flags: Flag[] = [];
  if (!(e.amount > 0)) flags.push({ code: 'missing_amount', message: 'No amount found on this line.' });

  if (e.quantity && e.unitPrice && e.amount > 0) {
    const expected = Math.round(e.quantity * e.unitPrice);
    const tolerance = Math.max(100, Math.round(expected * 0.005));
    if (Math.abs(expected - e.amount) > tolerance) {
      flags.push({
        code: 'math',
        message: `${e.quantity} × ${formatNaira(e.unitPrice)} = ${formatNaira(expected)}, but the line says ${formatNaira(e.amount)}.`,
        suggestion: { amount: expected },
      });
    }
  }

  if (e.kind === 'sale' && e.paid !== 'paid' && !e.customer) {
    flags.push({ code: 'who_owes', message: 'This sale is on credit, but no customer name was found.' });
  }
  if (e.paid === 'partial' && !(e.amountPaid !== null && e.amountPaid > 0 && e.amountPaid < e.amount)) {
    flags.push({ code: 'partial', message: 'Part-payment amount is missing or larger than the sale.' });
  }

  if (e.date) {
    const days = dayDiff(today, e.date);
    if (days < -1) flags.push({ code: 'future_date', message: `The date ${e.date} is in the future.` });
    else if (days > 400) flags.push({ code: 'old_date', message: `The date ${e.date} is over a year old.` });
  }

  if (e.confidence < CONFIRM_BELOW) {
    flags.push({ code: 'low_confidence', message: 'Hard to read; please check this line.' });
  }
  return flags;
}

/** A debt payment must match someone who owes, and can't exceed what they owe. */
export function checkPayment(e: ProposedEntry, outstanding: Kobo | null): Flag[] {
  if (e.kind !== 'payment') return [];
  if (outstanding === null || outstanding <= 0) {
    return [{ code: 'unknown_debtor', message: `${e.customer ?? 'This customer'} has no debt on record.` }];
  }
  if (e.amount > outstanding) {
    return [{ code: 'overpaid', message: `${e.customer} owes ${formatNaira(outstanding)}, but the payment is ${formatNaira(e.amount)}.` }];
  }
  return [];
}

export function needsConfirmation(e: ProposedEntry, flags: Flag[]): boolean {
  return flags.length > 0 || e.confidence < CONFIRM_BELOW;
}

// ---------------------------------------------------------------- page total reconciliation

// Digits that are easy to confuse in handwriting (and in photos of it).
const CONFUSABLE: Record<string, string[]> = {
  '0': ['6', '8', '9'], '1': ['7', '4'], '2': ['7', '3'], '3': ['8', '5', '2'], '4': ['9', '1'],
  '5': ['6', '3', '8'], '6': ['5', '0', '8'], '7': ['1', '2'], '8': ['3', '6', '0'], '9': ['4', '0', '7'],
};

export interface Repair {
  target: number | 'total'; // index into the entries, or the written total itself
  from: Kobo;
  to: Kobo;
  reason: string;
}

export interface TotalCheck {
  status: 'no_total' | 'match' | 'repaired' | 'ambiguous' | 'mismatch';
  basis: 'sales' | 'cash_received' | null;
  written: Kobo | null;
  computed: Kobo;
  repairs: Repair[];
}

/** Alternative readings of an amount: one confusable digit, or one zero too many/few. */
export function misreadings(amount: Kobo): { value: Kobo; reason: string }[] {
  if (amount <= 0 || amount % 100 !== 0) return [];
  const digits = String(amount / 100);
  const out = new Map<Kobo, string>();
  for (let i = 0; i < digits.length; i++) {
    for (const alt of CONFUSABLE[digits[i]] ?? []) {
      if (i === 0 && alt === '0') continue;
      const v = Number(digits.slice(0, i) + alt + digits.slice(i + 1)) * 100;
      if (!out.has(v)) out.set(v, `read ${digits[i]} as ${alt}`);
    }
  }
  if (!out.has(amount * 10)) out.set(amount * 10, 'one zero was missed');
  if (amount % 1000 === 0 && !out.has(amount / 10)) out.set(amount / 10, 'one zero too many');
  out.delete(amount);
  return [...out].map(([value, reason]) => ({ value, reason }));
}

/**
 * Compare the extracted lines with the total the trader wrote on the page.
 * Traders total either all sales or only the cash they received, so both bases are tried.
 * When neither matches, look for the single misread digit (in one line or in the total)
 * that makes the page add up. One candidate = a proposed repair; several = ask.
 */
export function reconcileTotal(entries: ProposedEntry[], written: Kobo | null): TotalCheck {
  const sales = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'sale');
  const salesSum = sales.reduce((s, { e }) => s + e.amount, 0);
  const cashSum = sales.reduce((s, { e }) => s + cashPortion(e), 0);
  if (written === null || written <= 0) {
    return { status: 'no_total', basis: null, written, computed: salesSum, repairs: [] };
  }
  if (salesSum === written) return { status: 'match', basis: 'sales', written, computed: salesSum, repairs: [] };
  if (cashSum === written) return { status: 'match', basis: 'cash_received', written, computed: cashSum, repairs: [] };

  const candidates: Repair[] = [];
  for (const { e, i } of sales) {
    for (const m of misreadings(e.amount)) {
      if (salesSum - e.amount + m.value === written) {
        candidates.push({ target: i, from: e.amount, to: m.value, reason: m.reason });
      }
    }
  }
  for (const m of misreadings(written)) {
    if (m.value === salesSum) candidates.push({ target: 'total', from: written, to: m.value, reason: m.reason });
  }

  // Several readings fit the total: prefer the one that also agrees with the line's own
  // quantity × unit price, since that is a second, independent witness.
  let chosen = candidates;
  if (candidates.length > 1) {
    const agree = candidates.filter((c) => {
      if (c.target === 'total') return false;
      const e = entries[c.target];
      return !!(e.quantity && e.unitPrice) && Math.round(e.quantity * e.unitPrice) === c.to;
    });
    if (agree.length === 1) chosen = agree;
  }
  const status = chosen.length === 1 ? 'repaired' : chosen.length > 1 ? 'ambiguous' : 'mismatch';
  return { status, basis: 'sales', written, computed: salesSum, repairs: chosen };
}

function cashPortion(e: ProposedEntry): Kobo {
  if (e.paid === 'paid') return e.amount;
  if (e.paid === 'partial') return e.amountPaid ?? 0;
  return 0;
}

// ---------------------------------------------------------------- duplicates and names

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Same day, kind, amount and party as an entry already in the ledger. */
export function isDuplicate(e: ProposedEntry, existing: ProposedEntry[]): boolean {
  const key = (x: ProposedEntry) =>
    [x.date, x.kind, x.amount, normalizeName(x.customer ?? ''), normalizeName(x.item ?? '')].join('|');
  const k = key(e);
  return existing.some((x) => key(x) === k);
}

/**
 * Match a spoken or written customer name to someone already in the ledger.
 * Titles are kept on purpose: "Mama Tunde" and "Baba Tunde" are different people.
 */
export function matchCustomer(name: string, known: string[]): { name: string; score: number } | null {
  const n = normalizeName(name);
  let best: { name: string; score: number } | null = null;
  for (const k of known) {
    const score = similarity(n, normalizeName(k));
    if (!best || score > best.score) best = { name: k, score };
  }
  return best && best.score >= 0.8 ? best : null;
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}
