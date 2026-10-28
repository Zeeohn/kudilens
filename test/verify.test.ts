import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEntry, checkPayment, isDuplicate, matchCustomer, misreadings, reconcileTotal } from '../src/verify.ts';
import { entry, TODAY } from './helpers.ts';

test('a clean line has no flags', () => {
  assert.deepEqual(checkEntry(entry(), TODAY), []);
});

test('quantity × price must equal the amount', () => {
  const flags = checkEntry(entry({ quantity: 3, unitPrice: 250000, amount: 760000 }), TODAY);
  assert.equal(flags[0].code, 'math');
  assert.equal(flags[0].suggestion?.amount, 750000);
  assert.deepEqual(checkEntry(entry({ quantity: 3, unitPrice: 250000, amount: 750000 }), TODAY), []);
});

test('credit sales need a customer, part payments need a sensible amount', () => {
  assert.equal(checkEntry(entry({ paid: 'owed' }), TODAY)[0].code, 'who_owes');
  assert.ok(checkEntry(entry({ paid: 'partial', customer: 'Mama Tunde', amountPaid: 900000 }), TODAY).some((f) => f.code === 'partial'));
  assert.deepEqual(checkEntry(entry({ paid: 'partial', customer: 'Mama Tunde', amountPaid: 200000 }), TODAY), []);
});

test('dates in the future or long past are flagged', () => {
  assert.equal(checkEntry(entry({ date: '2026-11-15' }), TODAY)[0].code, 'future_date');
  assert.equal(checkEntry(entry({ date: '2024-01-01' }), TODAY)[0].code, 'old_date');
  assert.deepEqual(checkEntry(entry({ date: '2026-10-29' }), TODAY), []); // timezone slack of one day
});

test('low model confidence asks the trader to check', () => {
  assert.equal(checkEntry(entry({ confidence: 0.6 }), TODAY)[0].code, 'low_confidence');
});

test('payments must match an existing debt and not exceed it', () => {
  const pay = entry({ kind: 'payment', customer: 'Mama Tunde', amount: 300000 });
  assert.deepEqual(checkPayment(pay, 500000), []);
  assert.equal(checkPayment(pay, 200000)[0].code, 'overpaid');
  assert.equal(checkPayment(pay, 0)[0].code, 'unknown_debtor');
});

test('misreadings covers confusable digits and dropped zeros', () => {
  const alts = misreadings(550000).map((m) => m.value);
  assert.ok(alts.includes(650000)); // 5 read as 6
  assert.ok(alts.includes(5500000)); // missed a zero
  assert.ok(!alts.includes(550000));
});

test('page total that matches sales or cash received', () => {
  const page = [entry({ amount: 500000 }), entry({ amount: 300000, paid: 'owed', customer: 'Bisi' })];
  assert.equal(reconcileTotal(page, 800000).status, 'match');
  const cash = reconcileTotal(page, 500000);
  assert.equal(cash.status, 'match');
  assert.equal(cash.basis, 'cash_received');
  assert.equal(reconcileTotal(page, null).status, 'no_total');
});

test('one misread digit is found from the handwritten total', () => {
  // Trader wrote 7,000 + 6,500 + 1,200 = 14,700, but the model read 6,500 as 5,500.
  const page = [entry({ amount: 700000 }), entry({ amount: 550000 }), entry({ amount: 120000 })];
  const r = reconcileTotal(page, 1470000);
  assert.equal(r.status, 'repaired');
  assert.deepEqual(r.repairs, [{ target: 1, from: 550000, to: 650000, reason: 'read 5 as 6' }]);
});

test('a misread total is repaired too, and several fixes means ask', () => {
  const page = [entry({ amount: 700000 }), entry({ amount: 650000 })];
  const r = reconcileTotal(page, 1950000); // 13,500 read as 19,500: 3→9 isn't a confusable pair
  assert.equal(r.status, 'mismatch');
  const t = reconcileTotal(page, 1850000); // 13,500 with the 3 read as 8
  assert.equal(t.status, 'repaired');
  assert.equal(t.repairs[0].target, 'total');
  const amb = reconcileTotal([entry({ amount: 100000 }), entry({ amount: 100000 })], 800000); // 1+7 or 7+1
  assert.equal(amb.status, 'ambiguous');
});

test('duplicates and customer names', () => {
  assert.ok(isDuplicate(entry({ customer: "Mama Tunde's" }), [entry({ customer: 'mama tunde' })]));
  assert.ok(!isDuplicate(entry({ amount: 1 }), [entry()]));
  assert.equal(matchCustomer('Mama Tundee', ['Mama Tunde', 'Baba Tunde'])?.name, 'Mama Tunde');
  assert.equal(matchCustomer('Chinedu', ['Mama Tunde']), null);
});

test('quantity × price breaks a tie between two possible repairs', () => {
  // 5,000 (2 × 2,500) was read as 6,000; 6,500 → 5,500 would also fix the total.
  const page = [entry({ amount: 600000, quantity: 2, unitPrice: 250000 }), entry({ amount: 650000 }), entry({ amount: 120000 })];
  const r = reconcileTotal(page, 1270000);
  assert.equal(r.status, 'repaired');
  assert.deepEqual([r.repairs[0].target, r.repairs[0].to], [0, 500000]);
});
