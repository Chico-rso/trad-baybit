import type { Candle, CandleInterval } from '../exchange/bybit/types.js';
export class CandleStore {
  private readonly candles = new Map<string, Candle[]>();
  constructor(private readonly capacity = 1500) {}
  upsert(candle: Candle): boolean {
    if (!candle.confirmed) return false;
    const key = `${candle.symbol}:${candle.interval}`;
    const list = this.candles.get(key) ?? [];
    const old = list.findIndex((c) => c.start === candle.start);
    if (old >= 0) list[old] = candle;
    else list.push(candle);
    list.sort((a, b) => a.start - b.start);
    this.candles.set(key, list.slice(-this.capacity));
    return old < 0;
  }
  get(symbol: string, interval: CandleInterval): Candle[] {
    return this.candles.get(`${symbol}:${interval}`) ?? [];
  }
  contiguous(symbol: string, interval: CandleInterval, count: number): boolean {
    const list = this.get(symbol, interval).slice(-count);
    return (
      list.length >= count &&
      list.every((c, i) => i === 0 || c.start - list[i - 1]!.start === interval * 60000)
    );
  }
}
