import { describe, expect, it, vi } from 'vitest';
import { parseEnv, endpoints, assertExecutionMode, runtimeConfig } from '../../src/config/env.js';
import { BybitRestClient } from '../../src/exchange/bybit/BybitRestClient.js';
import { BybitClient } from '../../src/exchange/bybit/BybitClient.js';
import { BybitPrivateData } from '../../src/exchange/bybit/BybitPrivateData.js';
import { ExchangeExecutionEngine } from '../../src/trading/ExchangeExecutionEngine.js';
import { TradingEngine } from '../../src/trading/TradingEngine.js';
import { Journal } from '../../src/database/db.js';
import { MarketState } from '../../src/market/MarketState.js';
import { DailyLossGuard } from '../../src/risk/DailyLossGuard.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { health } from '../../src/monitoring/health.js';
import { createLogger } from '../../src/utils/logger.js';

const raw = {
  TRADING_MODE: 'demo',
  BYBIT_API_KEY: 'demo-test-key',
  BYBIT_API_SECRET: 'demo-test-secret',
};
const logger = createLogger('silent');

describe('Bybit Demo Trading isolation', () => {
  it('requires demo credentials and keeps real-money trading disabled', () => {
    expect(() => parseEnv({ TRADING_MODE: 'demo' })).toThrow('credentials');
    const c = parseEnv(raw);
    expect(c.ENABLE_LIVE_TRADING).toBe(false);
    expect(() => assertExecutionMode(c)).not.toThrow();
    expect(() => parseEnv({ ...raw, ENABLE_LIVE_TRADING: 'true' })).toThrow('DEMO');
    expect(() => assertExecutionMode({ ...c, ENABLE_LIVE_TRADING: true })).toThrow('DEMO');
    expect(() => runtimeConfig(raw, 'live')).toThrow('TRADING_MODE=live');
  });

  it.each(['testnet', 'mainnet'])(
    'pins demo private endpoints and mainnet public data despite %s selection',
    (network) => {
      const c = parseEnv({ ...raw, MARKET_DATA_NETWORK: network });
      expect(endpoints(c)).toEqual({
        rest: 'https://api-demo.bybit.com',
        publicRest: 'https://api.bybit.com',
        publicWs: 'wss://stream.bybit.com/v5/public/linear',
        privateWs: 'wss://stream-demo.bybit.com/v5/private',
      });
    },
  );

  it('sends signed exchange orders only to demo, and no credentials to public mainnet', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ retCode: 0, result: { orderId: 'demo-order', orderLinkId: 'intent' } }),
        ),
    );
    const client = new BybitClient(new BybitRestClient(parseEnv(raw), logger, fetcher));
    await client.rest.get('/v5/market/time');
    await client.createOrder({
      category: 'linear',
      symbol: 'BTCUSDT',
      side: 'Buy',
      orderType: 'Limit',
      qty: '0.001',
      price: '100',
      orderLinkId: 'intent',
      positionIdx: 0,
    });
    const publicCall = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const orderCall = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(publicCall[0]).toBe('https://api.bybit.com/v5/market/time');
    expect(publicCall[1].headers).not.toHaveProperty('X-BAPI-API-KEY');
    expect(orderCall[0]).toBe('https://api-demo.bybit.com/v5/order/create');
    expect(orderCall[1].headers).toHaveProperty('X-BAPI-API-KEY', raw.BYBIT_API_KEY);
  });

  it('never falls back to a funded account when demo authentication is rejected', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ retCode: 10003, result: {} })),
    );
    const rest = new BybitRestClient(parseEnv(raw), logger, fetcher);
    await expect(rest.post('/v5/order/create', {})).rejects.toThrow('10003');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api-demo.bybit.com/v5/order/create');
  });

  it('requires private demo stream readiness and reports the demo account network', () => {
    const c = parseEnv(raw),
      db = new Journal(':memory:'),
      market = new MarketState(c.SYMBOLS),
      kill = new KillSwitch(db, logger, 'demo');
    try {
      expect(health(c, market, db, 1, 1000, true, 1000).reasons).toContain(
        'private websocket disconnected',
      );
      const privateData = new BybitPrivateData(c, logger);
      privateData.stop();
      const engine = new TradingEngine(
        c,
        market,
        db,
        logger,
        new DailyLossGuard(c, db, 'demo'),
        kill,
        undefined,
        () => ({ status: 'HEALTHY', reasons: [], timestamp: 1000 }),
      );
      expect(engine.status().network).toBe('demo');
      const testnet = parseEnv({ ...raw, TRADING_MODE: 'testnet' });
      expect(
        () =>
          new ExchangeExecutionEngine(
            c,
            db,
            logger,
            new Map(),
            new BybitClient(new BybitRestClient(testnet, logger)),
            kill,
          ),
      ).toThrow('mismatch');
    } finally {
      db.close();
    }
  });
});
