export function ema(values: number[], period: number): number | undefined {
  if (period < 1 || values.length < period) return;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) value = values[i]! * k + value * (1 - k);
  return value;
}
