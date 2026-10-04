import { CandleStore } from './CandleStore.js';
import { OrderBookStore } from './OrderBookStore.js';
import { TradeStore } from './TradeStore.js';
import type { Instrument, CandleInterval } from '../exchange/bybit/types.js';
export class MarketState {
  readonly candles = new CandleStore();
  readonly trades = new TradeStore();
  readonly books = new Map<string, OrderBookStore>();
  readonly instruments = new Map<string, Instrument>();
  readonly synchronized = new Set<string>();
  publicConnected = false;
  privateConnected = false;
  constructor(
    readonly symbols: string[],
    levels = 10,
  ) {
    for (const symbol of symbols) this.books.set(symbol, new OrderBookStore(levels));
  }
  invalidate(): void {
    this.publicConnected = false;
    this.synchronized.clear();
    for (const book of this.books.values()) book.reset();
  }
  ready(
    symbol: string,
    now: number,
    staleMs: number,
    candleStaleMs: number,
    warmup: number,
    intervals: readonly [CandleInterval, CandleInterval] = [1, 5],
  ): boolean {
    const quote = this.books.get(symbol)?.quote();
    return (
      this.publicConnected &&
      this.synchronized.has(symbol) &&
      this.instruments.has(symbol) &&
      !!quote &&
      now >= quote.timestamp &&
      now - quote.timestamp <= staleMs &&
      intervals.every((interval) => {
        const candle = this.candles.get(symbol, interval).at(-1);
        const duration = interval * 60000;
        return (
          !!candle &&
          candle.start + duration >= Math.floor((now - candleStaleMs) / duration) * duration &&
          candle.start + duration <= now &&
          this.candles.contiguous(symbol, interval, warmup)
        );
      })
    );
  }
}
