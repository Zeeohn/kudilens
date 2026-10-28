import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNaira, parseNaira } from '../src/money.ts';

test('parses the ways traders write amounts', () => {
  const cases: [string | number, number | null][] = [
    ['7500', 750000], ['7,500', 750000], ['₦7,500', 750000], ['N7500', 750000], ['n 7,500.00', 750000],
    ['7.5k', 750000], ['2m', 200000000], ['1,200/=', 120000], ['12,345,678', 1234567800], ['7,5', 750],
    [52000, 5200000], ['', null], ['abc', null], ['7,50,0', null],
  ];
  for (const [input, want] of cases) assert.equal(parseNaira(input), want, String(input));
});

test('formats kobo as naira', () => {
  assert.equal(formatNaira(750000), '₦7,500');
  assert.equal(formatNaira(1234567850), '₦12,345,678.50');
  assert.equal(formatNaira(-5000), '-₦50');
  assert.equal(formatNaira(0), '₦0');
});
