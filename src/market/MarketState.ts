import { CandleStore } from './CandleStore.js';
import { OrderBookStore } from './OrderBookStore.js';
import { TradeStore } from './TradeStore.js';
import type { Instrument } from '../exchange/bybit/types.js';
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
  ): boolean {
    const quote = this.books.get(symbol)?.quote();
    const one = this.candles.get(symbol, 1).at(-1),
      five = this.candles.get(symbol, 5).at(-1);
    return (
      this.publicConnected &&
      this.synchronized.has(symbol) &&
      this.instruments.has(symbol) &&
      !!quote &&
      now >= quote.timestamp &&
      now - quote.timestamp <= staleMs &&
      !!one &&
      !!five &&
      one.start + 60000 >= Math.floor((now - candleStaleMs) / 60000) * 60000 &&
      five.start + 300000 >= Math.floor((now - candleStaleMs) / 300000) * 300000 &&
      one.start + 60000 <= now &&
      five.start + 300000 <= now &&
      this.candles.contiguous(symbol, 1, warmup) &&
      this.candles.contiguous(symbol, 5, warmup)
    );
  }
}
