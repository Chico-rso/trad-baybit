import { describe, expect, it } from 'vitest';
import { parseEnv, endpoints, assertExecutionMode } from '../../src/config/env.js';

describe('configuration safety boundary', () => {
  it('validates an optional positive capital limit', () => {
    expect(parseEnv({ TRADING_CAPITAL_USDT: '24' }).TRADING_CAPITAL_USDT).toBe(24);
    for (const value of ['0', '-1', 'NaN', 'Infinity'])
      expect(() => parseEnv({ TRADING_CAPITAL_USDT: value })).toThrow();
  });
  it('defaults to signal and testnet without credentials', () => {
    const config = parseEnv({});
    expect(config.TRADING_MODE).toBe('signal');
    expect(endpoints(config).rest).toBe('https://api-testnet.bybit.com');
    expect(() => assertExecutionMode(config)).toThrow();
  });
  it.each([undefined, 'false', 'TRUE', '1'])(
    'blocks live without exact explicit true (%s)',
    (flag) => {
      expect(() => parseEnv({ TRADING_MODE: 'live', ENABLE_LIVE_TRADING: flag })).toThrow();
    },
  );
  it('requires both live flags and credentials', () => {
    expect(() => parseEnv({ TRADING_MODE: 'live', ENABLE_LIVE_TRADING: 'true' })).toThrow();
    const config = parseEnv({
      TRADING_MODE: 'live',
      ENABLE_LIVE_TRADING: 'true',
      BYBIT_API_KEY: 'test-key',
      BYBIT_API_SECRET: 'test-secret',
    });
    expect(endpoints(config).rest).toBe('https://api.bybit.com');
    expect(() => assertExecutionMode(config)).not.toThrow();
  });
  it('never changes testnet authenticated endpoints with public data selection', () => {
    const config = parseEnv({
      TRADING_MODE: 'testnet',
      MARKET_DATA_NETWORK: 'mainnet',
      BYBIT_API_KEY: 'test-key',
      BYBIT_API_SECRET: 'test-secret',
    });
    expect(endpoints(config).rest).toContain('api-testnet');
    expect(endpoints(config).publicWs).toContain('stream-testnet');
  });
  it('rejects leverage above the fixed MVP ceiling', () => {
    expect(() => parseEnv({ LEVERAGE: '4', MAX_LEVERAGE: '10' })).toThrow();
    expect(() => parseEnv({ LEVERAGE: '3', MAX_LEVERAGE: '2' })).toThrow();
  });
  it('rejects invalid numbers, symbols and half configured Telegram', () => {
    expect(() => parseEnv({ RISK_PER_TRADE_PERCENT: '-1' })).toThrow();
    expect(() => parseEnv({ SYMBOLS: '' })).toThrow();
    expect(() => parseEnv({ TELEGRAM_BOT_TOKEN: 'fake' })).toThrow();
  });
});

describe('CLI live authorization', () => {
  it('requires TRADING_MODE=live in ENV even when live is requested by CLI', async () => {
    const { runtimeConfig } = await import('../../src/config/env.js');
    const raw = {
      ENABLE_LIVE_TRADING: 'true',
      BYBIT_API_KEY: 'test-key',
      BYBIT_API_SECRET: 'test-secret',
    };
    expect(() => runtimeConfig(raw, 'live')).toThrow('TRADING_MODE=live');
    expect(runtimeConfig({ ...raw, TRADING_MODE: 'live' }, 'live').TRADING_MODE).toBe('live');
    expect(runtimeConfig({ ...raw, TRADING_MODE: 'live' }, 'signal').TRADING_MODE).toBe('signal');
  });
});
