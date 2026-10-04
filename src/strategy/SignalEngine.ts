import { strategyTimeframes, type Config } from '../config/env.js';
import type { MarketState } from '../market/MarketState.js';
import { createStrategy } from './createStrategy.js';
export class SignalEngine {
  readonly strategy: ReturnType<typeof createStrategy>;
  constructor(
    private readonly c: Config,
    private readonly market: MarketState,
  ) {
    this.strategy = createStrategy(c);
  }
  evaluate(symbol: string, now = Date.now()) {
    const quote = this.market.books.get(symbol)?.quote();
    const [entry, trend] = strategyTimeframes(this.c);
    return quote
      ? this.strategy.evaluate(
          symbol,
          this.market.candles.get(symbol, entry),
          this.market.candles.get(symbol, trend),
          quote,
          now,
        )
      : [];
  }
}
