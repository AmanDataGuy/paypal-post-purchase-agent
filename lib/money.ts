/**
 * # money.ts - converts between PayPal amount strings ("38.00") and integer cents
 *
 * - All comparisons use integer cents; floats never touch money.
 */

// "38.00" -> 3800. Throws on anything that is not a plain 2-decimal amount.
export function toCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error(`Bad money amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

// 3800 -> "38.00"
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Bad cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
