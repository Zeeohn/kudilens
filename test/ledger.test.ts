import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, postingsFor } from '../src/ledger.ts';
import type { ProposedEntry } from '../src/verify.ts';
import { entry } from './helpers.ts';

function setup() {
  const l = new Ledger();
  const t = l.trader('telegram', '42');
  const { evidence } = l.addEvidence(t.id, 'photo', new TextEncoder().encode('page-1'), { mime: 'image/jpeg' });
  return { l, t, evidence };
}

function post(l: Ledger, traderId: number, evidenceId: string | null, entries: ProposedEntry[]) {
  const proposed = l.propose(traderId, evidenceId, entries.map((e) => ({ entry: e, flags: [] })));
  return l.confirm(proposed.map((e) => e.id));
}

test('every kind of entry posts balanced double entry', () => {
  const kinds: Partial<ProposedEntry>[] = [
    { kind: 'sale' }, { kind: 'sale', paid: 'owed', customer: 'Bisi' },
    { kind: 'sale', paid: 'partial', amountPaid: 200000, customer: 'Bisi' },
    { kind: 'payment', customer: 'Bisi' }, { kind: 'expense', item: 'transport' },
    { kind: 'stock_in', paid: 'owed', customer: 'Alhaji Musa' }, { kind: 'sale', method: 'transfer' },
  ];
  for (const k of kinds) assert.equal(postingsFor(entry(k)).reduce((s, p) => s + p.amount, 0), 0, JSON.stringify(k));
});

test('the same file twice is recognised as a duplicate', () => {
  const { l, t } = setup();
  assert.equal(l.addEvidence(t.id, 'photo', new TextEncoder().encode('page-1')).duplicate, true);
});

test('credit sales and payments drive the debtors list', () => {
  const { l, t, evidence } = setup();
  post(l, t.id, evidence.id, [
    entry({ amount: 500000 }),
    entry({ paid: 'owed', customer: 'Mama Tunde', amount: 800000, dueDate: '2026-10-31' }),
    entry({ paid: 'partial', customer: 'Bisi', amount: 600000, amountPaid: 100000 }),
  ]);
  post(l, t.id, null, [entry({ kind: 'payment', customer: "mama tunde's", amount: 300000 })]);
  assert.equal(l.outstanding(t.id, 'Mama Tunde'), 500000);
  assert.deepEqual(l.debtors(t.id).map((d) => [d.name, d.owed]), [['Bisi', 500000], ["mama tunde's", 500000]]);
  assert.equal(l.balance(t.id, 'cash'), 500000 + 100000 + 300000);
});

test('summary separates sales, cash collected, credit and spending', () => {
  const { l, t } = setup();
  post(l, t.id, null, [
    entry({ amount: 500000, item: 'Rice', quantity: 1 }),
    entry({ amount: 300000, paid: 'owed', customer: 'Bisi', item: 'rice', quantity: 2 }),
    entry({ kind: 'expense', amount: 50000, item: 'transport' }),
    entry({ kind: 'stock_in', amount: 200000, item: 'rice' }),
    entry({ amount: 999900, date: '2026-10-01' }), // outside the period
  ]);
  const s = l.summary(t.id, '2026-10-28', '2026-10-28');
  assert.equal(s.sales, 800000);
  assert.equal(s.collected, 500000);
  assert.equal(s.creditGiven, 300000);
  assert.equal(s.net, 800000 - 50000 - 200000);
  assert.deepEqual(s.topItems[0], { item: 'Rice', value: 800000, quantity: 3 });
});

test('the hash chain verifies and detects tampering', () => {
  const { l, t, evidence } = setup();
  post(l, t.id, evidence.id, [entry({ amount: 100000 }), entry({ amount: 200000 }), entry({ amount: 300000 })]);
  const ok = l.verifyChain(t.id);
  assert.equal(ok.ok, true);
  assert.equal(ok.length, 3);
  // Someone edits a confirmed amount directly in the database.
  const second = l.confirmed(t.id)[1];
  l.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify({ ...second, amount: 900000 }), second.id);
  const bad = l.verifyChain(t.id);
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, 2);
  assert.equal(bad.reason, 'changed');
  assert.equal(bad.intact, 1);
  assert.deepEqual(bad.record, { seq: 2, date: second.date, kind: 'sale', item: 'rice', amount: 900000 });
});

test('deleting a sealed record breaks the chain at the next one', () => {
  const { l, t, evidence } = setup();
  post(l, t.id, evidence.id, [entry({ amount: 100000 }), entry({ amount: 200000 }), entry({ amount: 300000 })]);
  l.db.prepare('DELETE FROM entries WHERE seq = 2 AND trader_id = ?').run(t.id);
  const bad = l.verifyChain(t.id);
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, 3);
  assert.equal(bad.reason, 'missing');
  assert.equal(bad.intact, 1);
});

test('changing the evidence fingerprint also breaks the chain', () => {
  const { l, t, evidence } = setup();
  post(l, t.id, evidence.id, [entry()]);
  l.db.prepare('UPDATE evidence SET sha256 = ? WHERE id = ?').run('f'.repeat(64), evidence.id);
  assert.equal(l.verifyChain(t.id).ok, false);
});

test('confirmed entries are immutable; proposed ones can be amended or rejected', () => {
  const { l, t } = setup();
  const [a, b] = l.propose(t.id, null, [{ entry: entry(), flags: [] }, { entry: entry({ amount: 1 }), flags: [] }]);
  assert.equal(l.amend(a.id, { amount: 650000 }).amount, 650000);
  l.reject([b.id]);
  l.confirm([a.id, b.id]);
  assert.equal(l.confirmed(t.id).length, 1);
  assert.throws(() => l.amend(a.id, { amount: 1 }));
});
