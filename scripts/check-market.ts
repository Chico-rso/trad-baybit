import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/utils/logger.js';
import { BybitRestClient } from '../src/exchange/bybit/BybitRestClient.js';
import { BybitClient } from '../src/exchange/bybit/BybitClient.js';
import { BybitMarketData } from '../src/exchange/bybit/BybitMarketData.js';
import { MarketState } from '../src/market/MarketState.js';
import { ScalpingStrategy } from '../src/strategy/ScalpingStrategy.js';
import type { WsMessage } from '../src/exchange/bybit/BybitWebSocket.js';
const index = process.argv.indexOf('--network');
const c = parseEnv({
  MARKET_DATA_NETWORK: index >= 0 ? process.argv[index + 1] : 'testnet',
  LOG_LEVEL: 'warn',
});
const market = new MarketState(c.SYMBOLS, c.ORDERBOOK_LEVELS),
  log = createLogger('warn');
const data = new BybitMarketData(new BybitClient(new BybitRestClient(c, log)), market, c, log);
const counts: Record<string, number> = {};
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await data.initialize();
  await new Promise<void>((resolve, reject) => {
    data.ws.on('data', (msg: WsMessage) => {
      if (msg.topic) counts[msg.topic] = (counts[msg.topic] ?? 0) + 1;
    });
    timer = setTimeout(() => {
      const warmup = new ScalpingStrategy(c).warmup;
      const symbols = c.SYMBOLS.map((symbol) => ({
        symbol,
        ready: market.ready(symbol, Date.now(), c.MARKET_STALE_MS, c.CANDLE_STALE_MS, warmup),
        candles1m: market.candles.get(symbol, 1).length,
        candles5m: market.candles.get(symbol, 5).length,
        quote: market.books.get(symbol)?.quote(),
        trades: market.trades.get(symbol).length,
      }));
      console.log(
        JSON.stringify(
          { network: c.MARKET_DATA_NETWORK, connected: market.publicConnected, counts, symbols },
          null,
          2,
        ),
      );
      if (
        symbols.every((s) => s.ready) &&
        c.SYMBOLS.every((s) =>
          [`kline.1.${s}`, `kline.5.${s}`, `orderbook.50.${s}`, `publicTrade.${s}`].every(
            (t) => (counts[t] ?? 0) > 0,
          ),
        )
      )
        resolve();
      else
        reject(
          new Error(
            'Public market smoke check incomplete; inspect per-topic counters. No orders were sent.',
          ),
        );
    }, 20000);
    data.start();
  });
} catch (err) {
  log.error({ event: 'check.market.failed', error: err });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  data.stop();
}
