// Money is stored as integer kobo (₦1 = 100 kobo) so every sum is exact.

export type Kobo = number;

export const fromNaira = (n: number): Kobo => Math.round(n * 100);
export const toNaira = (k: Kobo): number => k / 100;

export function formatNaira(k: Kobo): string {
  const sign = k < 0 ? '-' : '';
  const abs = Math.abs(k);
  const whole = Math.floor(abs / 100).toLocaleString('en-NG');
  const frac = abs % 100;
  return `${sign}₦${whole}${frac ? '.' + String(frac).padStart(2, '0') : ''}`;
}

/**
 * Parse an amount the way traders write it: "7,500", "7500.00", "N7500", "₦7,500",
 * "7.5k", "2m", "1,200/=". Returns null when there is no number.
 */
export function parseNaira(input: string | number | null | undefined): Kobo | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? fromNaira(input) : null;
  let s = input.toLowerCase().replace(/naira|ngn|₦|\/=|\s/g, '').replace(/^n(?=\d)/, '');
  let mult = 1;
  if (/k$/.test(s)) { mult = 1_000; s = s.slice(0, -1); }
  else if (/m$/.test(s)) { mult = 1_000_000; s = s.slice(0, -1); }
  // "7,500" uses comma thousands; a lone comma with 1–2 trailing digits is a decimal ("7,5").
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return fromNaira(Number(s) * mult);
}
