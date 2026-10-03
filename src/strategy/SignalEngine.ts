import type { Config } from '../config/env.js';
import type { MarketState } from '../market/MarketState.js';
import { ScalpingStrategy } from './ScalpingStrategy.js';
export class SignalEngine {
  readonly strategy: ScalpingStrategy;
  constructor(
    c: Config,
    private readonly market: MarketState,
  ) {
    this.strategy = new ScalpingStrategy(c);
  }
  evaluate(symbol: string, now = Date.now()) {
    const quote = this.market.books.get(symbol)?.quote();
    return quote
      ? this.strategy.evaluate(
          symbol,
          this.market.candles.get(symbol, 1),
          this.market.candles.get(symbol, 5),
          quote,
          now,
        )
      : [];
  }
}
