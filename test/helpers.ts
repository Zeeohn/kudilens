import type { ProposedEntry } from '../src/verify.ts';

export const TODAY = '2026-10-28';

export function entry(over: Partial<ProposedEntry> = {}): ProposedEntry {
  return {
    kind: 'sale', date: TODAY, item: 'rice', quantity: null, unit: null, unitPrice: null, amount: 500000,
    paid: 'paid', amountPaid: null, method: 'cash', customer: null, dueDate: null, rawText: 'rice 5000',
    region: null, confidence: 0.95, ...over,
  };
}
