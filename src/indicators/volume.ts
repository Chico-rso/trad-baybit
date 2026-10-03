export function sma(values: number[], period: number): number | undefined {
  if (period < 1 || values.length < period) return;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}
