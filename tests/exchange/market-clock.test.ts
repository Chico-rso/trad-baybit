import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { BybitRestClient } from '../../src/exchange/bybit/BybitRestClient.js';
import { BybitClient } from '../../src/exchange/bybit/BybitClient.js';
import { BybitMarketData } from '../../src/exchange/bybit/BybitMarketData.js';
import { MarketState } from '../../src/market/MarketState.js';
import { createLogger } from '../../src/utils/logger.js';

afterEach(() => vi.restoreAllMocks());

describe('public orderbook clock alignment', () => {
  it('uses synchronized server time and clamps small estimation skew to receipt time', async () => {
    const now = 1000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const c = parseEnv({}),
      logger = createLogger('silent');
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            retCode: 0,
            result: { timeNano: String((now + 500) * 1e6) },
          }),
        ),
    );
    const rest = new BybitRestClient(c, logger, fetcher);
    await rest.synchronizeClock();
    const market = new MarketState(c.SYMBOLS);
    const data = new BybitMarketData(new BybitClient(rest), market, c, logger);
    try {
      const book = {
        topic: 'orderbook.50.BTCUSDT',
        type: 'snapshot',
        ts: now + 520,
        data: { s: 'BTCUSDT', b: [['100', '1']], a: [['101', '1']], u: 1, seq: 1 },
      };
      data.ws.emit('data', book);
      expect(market.books.get('BTCUSDT')!.quote()?.timestamp).toBe(now);
      data.ws.emit('data', {
        ...book,
        type: 'delta',
        ts: now + 400,
        data: { ...book.data, u: 2, seq: 2 },
      });
      expect(market.books.get('BTCUSDT')!.quote()?.timestamp).toBe(now - 100);
      data.ws.emit('data', {
        ...book,
        type: 'delta',
        ts: now + 500 - c.MARKET_STALE_MS - 1,
        data: { ...book.data, u: 3, seq: 3 },
      });
      const quote = market.books.get('BTCUSDT')!.quote()!;
      expect(now - quote.timestamp).toBeGreaterThan(c.MARKET_STALE_MS);
    } finally {
      data.stop();
    }
  });

  it('rejects missing or implausibly future timestamps rather than marking them fresh', () => {
    const c = parseEnv({}),
      logger = createLogger('silent'),
      market = new MarketState(c.SYMBOLS);
    const data = new BybitMarketData(
      new BybitClient(new BybitRestClient(c, logger)),
      market,
      c,
      logger,
    );
    const fault = vi.fn();
    data.on('fault', fault);
    try {
      const book = {
        topic: 'orderbook.50.BTCUSDT',
        type: 'snapshot',
        data: { s: 'BTCUSDT', b: [['100', '1']], a: [['101', '1']], u: 1, seq: 1 },
      };
      data.ws.emit('data', book);
      data.ws.emit('data', { ...book, ts: Date.now() + 60000 });
      expect(fault).toHaveBeenCalledTimes(2);
      expect(market.books.get('BTCUSDT')!.quote()).toBeUndefined();
    } finally {
      data.stop();
    }
  });
});
