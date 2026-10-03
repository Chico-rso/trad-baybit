import type { Candle } from '../exchange/bybit/types.js';
export function atr(candles: Candle[], period: number): number | undefined {
  if (period < 1 || candles.length < period + 1) return;
  const tr = candles
    .slice(1)
    .map((c, i) =>
      Math.max(
        c.high - c.low,
        Math.abs(c.high - candles[i]!.close),
        Math.abs(c.low - candles[i]!.close),
      ),
    );
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]!) / period;
  return value;
}
