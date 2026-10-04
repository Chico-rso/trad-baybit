import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBacktest } from '../../src/backtest/runner.js';
import { parseEnv } from '../../src/config/env.js';
import { instrument, signal } from '../helpers.js';
import type { Candle, Quote, Signal } from '../../src/exchange/bybit/types.js';

const spies = vi.hoisted(() => ({ factory: vi.fn(), evaluate: vi.fn() }));
vi.mock('../../src/strategy/createStrategy.js', () => ({
  createStrategy: spies.factory,
}));
const history: Candle[] = Array.from({ length: 181 }, (_, index) => ({
  symbol: 'BTCUSDT',
  interval: 1,
  start: index * 60000,
  open: 100,
  high: 100.2,
  low: 99.8,
  close: 100,
  volume: 100,
  turnover: 10000,
  confirmed: true,
}));
const instruments = new Map([['BTCUSDT', { ...instrument, qtyStep: '0.001', tickSize: '0.001' }]]);
const config = () =>
  parseEnv({ STRATEGY: 'trend-pullback', ENTRY_ORDER_TYPE: 'Market', BREAKEVEN_ENABLED: 'false' });

beforeEach(() => {
  spies.factory.mockReset();
  spies.evaluate.mockReset().mockReturnValue([]);
  spies.factory.mockReturnValue({ warmup: 2, evaluate: spies.evaluate });
});
describe('pullback replay timeframes', () => {
  it('selects configured strategy and evaluates once per closed 15m entry with closed hourly trend', async () => {
    const snapshots: [string, Candle[], Candle[], Quote, number][] = [];
    spies.evaluate.mockImplementation(
      (symbol: string, entries: Candle[], trends: Candle[], quote: Quote, now: number) => {
        snapshots.push([symbol, [...entries], [...trends], quote, now]);
        return [];
      },
    );
    await runBacktest(history, config(), instruments);
    expect(spies.factory).toHaveBeenCalledOnce();
    const calls = spies.evaluate.mock.calls;
    expect(calls.map((call) => call[4])).toEqual(
      [120, 135, 150, 165, 180].map((minute) => minute * 60000),
    );
    for (const [symbol, entries, trends, quote, now] of snapshots) {
      expect(symbol).toBe('BTCUSDT');
      expect(quote.timestamp).toBe(now);
      expect(entries.every((bar) => bar.interval === 15 && bar.start + 900000 <= now)).toBe(true);
      expect(trends.every((bar) => bar.interval === 60 && bar.start + 3600000 <= now)).toBe(true);
      expect(entries.at(-1)!.start + 900000).toBe(now);
      expect(trends.at(-1)!.start).toBe(Math.floor(now / 3600000) * 3600000 - 3600000);
    }
  });
  it('never evaluates an incomplete entry candle and waits for contiguous hourly warmup after a gap', async () => {
    const incomplete = history.slice(0, 119);
    await runBacktest(incomplete, config(), instruments);
    expect(spies.evaluate).not.toHaveBeenCalled();
    await runBacktest(
      history.filter((bar) => bar.start !== 17 * 60000),
      config(),
      instruments,
    );
    expect(spies.evaluate.mock.calls.map((call) => call[4])).toEqual([180 * 60000]);
  });
  it('submits a closed entry signal at the next minute open and accounts for costs', async () => {
    spies.evaluate.mockImplementation(
      (
        symbol: string,
        entries: Candle[],
        _trends: Candle[],
        _quote: Quote,
        now: number,
      ): Signal[] => [
        {
          ...signal,
          id: `entry:${now}`,
          symbol,
          timestamp: now,
          candleStart: entries.at(-1)!.start,
        },
      ],
    );
    const result = await runBacktest(history, config(), instruments);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryTime).toBe(120 * 60000 + 1);
    expect(result.stats.fees).toBeGreaterThan(0);
    expect(result.stats.netPnL).toBeCloseTo(result.stats.grossPnL - result.stats.fees);
  });
});
