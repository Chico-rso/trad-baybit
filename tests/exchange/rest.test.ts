import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { BybitRestClient } from '../../src/exchange/bybit/BybitRestClient.js';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';

describe('V5 REST adapter', () => {
  it('does not count already configured leverage as consecutive exchange failures', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ retCode: 110043, result: {} })),
    );
    const rest = new BybitRestClient(
      parseEnv({
        TRADING_MODE: 'demo',
        BYBIT_API_KEY: 'test-key',
        BYBIT_API_SECRET: 'test-secret',
      }),
      createLogger('silent'),
      fetcher,
    );
    const failure = vi.fn();
    rest.on('failure', failure);
    for (let i = 0; i < 6; i++)
      await expect(
        rest.post('/v5/position/set-leverage', {
          symbol: 'SOLUSDT',
          buyLeverage: '1',
          sellLeverage: '1',
        }),
      ).resolves.toEqual({});
    expect(rest.consecutiveErrors).toBe(0);
    expect(rest.lastSuccess).toBeGreaterThan(0);
    expect(failure).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('still counts genuine leverage errors and never exempts an order endpoint', async () => {
    const c = parseEnv({
      TRADING_MODE: 'demo',
      BYBIT_API_KEY: 'test-key',
      BYBIT_API_SECRET: 'test-secret',
    });
    const other = new BybitRestClient(
      c,
      createLogger('silent'),
      async () => new Response(JSON.stringify({ retCode: 110043, result: {} })),
    );
    await expect(other.post('/v5/order/create', {})).rejects.toThrow('110043');
    expect(other.consecutiveErrors).toBe(1);
    const denied = new BybitRestClient(
      c,
      createLogger('silent'),
      async () => new Response(JSON.stringify({ retCode: 110013, result: {} })),
    );
    await expect(denied.post('/v5/position/set-leverage', {})).rejects.toThrow('110013');
    expect(denied.consecutiveErrors).toBe(1);
  });
  it('signs GET canonical query, never exposes credentials and gates writes independently', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      const expected = createHmac('sha256', 'test-secret')
        .update(h['X-BAPI-TIMESTAMP'] + 'test-key5000category=linear&symbol=BTCUSDT')
        .digest('hex');
      expect(h['X-BAPI-SIGN']).toBe(expected);
      return new Response(JSON.stringify({ retCode: 0, result: { list: [] }, time: Date.now() }));
    });
    const config = parseEnv({ BYBIT_API_KEY: 'test-key', BYBIT_API_SECRET: 'test-secret' });
    const rest = new BybitRestClient(config, createLogger('silent'), fetcher);
    await rest.get('/v5/position/list', { category: 'linear', symbol: 'BTCUSDT' }, true);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(rest.post('/v5/order/create', {})).rejects.toThrow('forbidden');
  });
  it('does not retry an ambiguous order POST', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network timeout');
    });
    const rest = new BybitRestClient(
      parseEnv({
        TRADING_MODE: 'testnet',
        BYBIT_API_KEY: 'test-key',
        BYBIT_API_SECRET: 'test-secret',
      }),
      createLogger('silent'),
      fetcher,
    );
    await expect(rest.post('/v5/order/create', {})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
