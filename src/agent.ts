// The bookkeeping agent: Muse Spark answers the trader's questions by calling tools over
// their ledger. It can read the books but never write them; recording goes through
// extraction → checks → the trader's confirmation.

import { MODELS, type ChatMessage, type Meta, type ToolDef } from './meta.ts';
import { formatNaira } from './money.ts';
import type { Ledger } from './ledger.ts';
import { matchCustomer, normalizeName } from './verify.ts';

const fn = (name: string, description: string, properties: object = {}, required: string[] = []): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const DATE = { type: 'string', description: 'YYYY-MM-DD' };

export const TOOLS: ToolDef[] = [
  fn('summary', 'Sales, cash received, credit given, expenses, stock bought, net and top items for a date range (inclusive).', { from: DATE, to: DATE }, ['from', 'to']),
  fn('debtors', 'Everyone who owes the trader money, largest first, with due dates.'),
  fn('customer', "One customer's balance and their recent transactions.", { name: { type: 'string' } }, ['name']),
  fn('entries', 'Confirmed ledger entries in a date range, optionally one kind.', { from: DATE, to: DATE, kind: { type: 'string', enum: ['sale', 'expense', 'payment', 'stock_in', 'any'] } }, ['from', 'to', 'kind']),
  fn('stock', 'The latest shelf count of each item and the latest selling prices.'),
  fn('books_check', 'Whether the tamper-evident record chain is intact, and how many records it holds.'),
];

export function runTool(ledger: Ledger, traderId: number, name: string, args: any): unknown {
  const money = (k: number) => formatNaira(k);
  switch (name) {
    case 'summary': {
      const s = ledger.summary(traderId, args.from, args.to);
      return {
        ...s, sales: money(s.sales), collected: money(s.collected), expenses: money(s.expenses), stockBought: money(s.stockBought),
        net: money(s.net), creditGiven: money(s.creditGiven), topItems: s.topItems.map((i) => ({ ...i, value: money(i.value) })),
      };
    }
    case 'debtors':
      return ledger.debtors(traderId).map((d) => ({ name: d.name, owes: money(d.owed), due: d.dueDate, since: d.since }));
    case 'customer': {
      const known = ledger.knownCustomers(traderId);
      const match = matchCustomer(String(args.name ?? ''), known);
      if (!match) return { found: false, knownCustomers: known.slice(0, 30) };
      const key = normalizeName(match.name);
      const history = ledger.confirmed(traderId).filter((e) => e.customer && normalizeName(e.customer) === key).slice(-15);
      return {
        found: true, name: match.name, owes: money(ledger.outstanding(traderId, match.name)),
        history: history.map((e) => ({ date: e.date, kind: e.kind, item: e.item, amount: money(e.amount), paid: e.paid, amountPaid: e.amountPaid ? money(e.amountPaid) : null })),
      };
    }
    case 'entries': {
      const rows = ledger.confirmed(traderId, args.from, args.to).filter((e) => args.kind === 'any' || e.kind === args.kind);
      return {
        count: rows.length,
        entries: rows.slice(-40).map((e) => ({ date: e.date, kind: e.kind, item: e.item, quantity: e.quantity, unit: e.unit, amount: money(e.amount), paid: e.paid, customer: e.customer })),
      };
    }
    case 'stock':
      return {
        counts: ledger.stock(traderId).map((s) => ({ item: s.item, count: s.count, counted: new Date(s.at).toISOString().slice(0, 10) })),
        prices: [...ledger.prices(traderId).values()].map((p) => ({ item: p.item, unit: p.unit, price: money(p.unitPrice) })),
      };
    case 'books_check':
      return ledger.verifyChain(traderId);
    default:
      return { error: `unknown tool ${name}` };
  }
}

export async function answer(meta: Meta, ledger: Ledger, traderId: number, question: string, opts: { today: string; language: string; business?: string | null; model?: string }): Promise<{ text: string; tools: string[] }> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are KudiLens, the bookkeeper for a Nigerian market trader${opts.business ? ` (${opts.business})` : ''}. Today is ${opts.today} (Africa/Lagos).
Answer in ${opts.language}, in at most 6 short lines for a phone chat. Use **bold** for key numbers. No tables.
Every number must come from a tool result; never guess. If the books have nothing for the question, say so and suggest sending a photo of the page or a voice note.
You can read the books but not change them. To record something, the trader sends a photo, a voice note or a message like "sold 2 bags rice 5,000"; to fix a saved record they record a correcting entry.
Do not give legal, tax or investment advice; you may point out simple patterns (best sellers, who owes the longest).`,
    },
    { role: 'user', content: question },
  ];
  const used: string[] = [];
  for (let round = 0; round < 5; round++) {
    const { message } = await meta.chat({ model: opts.model ?? MODELS.reason, messages, tools: TOOLS, effort: 'low' });
    if (!message.tool_calls?.length) {
      return { text: typeof message.content === 'string' && message.content.trim() ? message.content.trim() : '…', tools: used };
    }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      used.push(call.function.name);
      let result: unknown;
      try {
        result = runTool(ledger, traderId, call.function.name, JSON.parse(call.function.arguments || '{}'));
      } catch (err) {
        result = { error: String(err) };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { text: '…', tools: used };
}
