import type { Candle } from '../exchange/bybit/types.js';
export function vwap(candles: Candle[]): number | undefined {
  const last = candles.at(-1);
  if (!last) return;
  const day = Math.floor(last.start / 86400000);
  const session = candles.filter((c) => Math.floor(c.start / 86400000) === day);
  const volume = session.reduce((s, c) => s + c.volume, 0);
  if (volume <= 0) return;
  return session.reduce((s, c) => s + c.turnover, 0) / volume;
}
