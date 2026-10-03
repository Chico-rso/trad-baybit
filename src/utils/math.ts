import { Decimal } from 'decimal.js';
function quantize(value: number | string, step: string, rounding: Decimal.Rounding): string {
  const v = new Decimal(value),
    s = new Decimal(step);
  if (!v.isFinite() || v.isNegative() || !s.isFinite() || s.lte(0))
    throw new Error('Invalid value or instrument step');
  return v
    .div(s)
    .toDecimalPlaces(0, rounding)
    .mul(s)
    .toFixed(s.decimalPlaces())
    .replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
}
export function normalizePrice(
  price: number | string,
  tickSize: string,
  direction: 'down' | 'up' | 'nearest' = 'nearest',
): string {
  return quantize(
    price,
    tickSize,
    direction === 'down'
      ? Decimal.ROUND_FLOOR
      : direction === 'up'
        ? Decimal.ROUND_CEIL
        : Decimal.ROUND_HALF_UP,
  );
}
export function normalizeQuantity(quantity: number | string, qtyStep: string): string {
  return quantize(quantity, qtyStep, Decimal.ROUND_FLOOR);
}
export function nearlyEqual(a: number, b: number, tolerance = 1e-8): boolean {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}
