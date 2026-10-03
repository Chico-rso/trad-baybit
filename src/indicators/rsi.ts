export function rsi(values: number[], period: number): number | undefined {
  if (period < 1 || values.length < period + 1) return;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i]! - values[i - 1]!;
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
