import { describe, expect, it } from 'vitest';
import { aggregateFiveMinute, validateHistory, runBacktest } from '../../src/backtest/runner.js';
import * as runner from '../../src/backtest/runner.js';
import { tradeStats } from '../../src/monitoring/metrics.js';
import { parseEnv } from '../../src/config/env.js';
import { instrument } from '../helpers.js';
import type { Candle, Trade } from '../../src/exchange/bybit/types.js';
const bars: Candle[] = Array.from({ length: 600 }, (_, i) => {
  const price = 100 + i * 0.01 + Math.sin(i / 3) * 0.05;
  return {
    symbol: 'BTCUSDT',
    interval: 1,
    start: i * 60000,
    open: price,
    high: price + 0.2,
    low: price - 0.2,
    close: price + 0.01,
    volume: i % 10 === 0 ? 300 : 100,
    turnover: price * (i % 10 === 0 ? 300 : 100),
    confirmed: true,
  };
});
describe('historical replay without lookahead', () => {
  it('aggregates only complete 15m and 1h candles independently for each symbol', () => {
    const aggregate = runner.aggregateCandles;
    const twoSymbols = bars.slice(0, 60).flatMap((bar) => [bar, { ...bar, symbol: 'ETHUSDT' }]);
    expect(aggregate(twoSymbols, 15)).toHaveLength(8);
    const hourly = aggregate(twoSymbols, 60);
    expect(hourly).toHaveLength(2);
    expect(hourly.map((bar) => bar.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(hourly[0]).toMatchObject({ interval: 60, start: 0, close: bars[59]!.close });
    expect(aggregate(bars.slice(0, 59), 60)).toHaveLength(0);
    expect(aggregate(bars.slice(1, 61), 60)).toHaveLength(0);
    expect(
      aggregate(
        bars.slice(0, 60).filter((_, index) => index !== 17),
        60,
      ),
    ).toHaveLength(0);
    expect(
      aggregate(
        bars.slice(0, 60).map((bar, index) => ({ ...bar, confirmed: index !== 17 })),
        60,
      ),
    ).toHaveLength(0);
  });
  it('creates 5m confirmation only from five contiguous completed bars', () => {
    expect(aggregateFiveMinute(bars.slice(0, 4))).toHaveLength(0);
    const five = aggregateFiveMinute(bars.slice(0, 5));
    expect(five).toHaveLength(1);
    expect(five[0]?.close).toBe(bars[4]?.close);
    expect(aggregateFiveMinute([bars[0]!, bars[1]!, bars[3]!, bars[4]!, bars[5]!])).toHaveLength(0);
  });
  it('rejects duplicate, out of order, incomplete and inconsistent OHLC history', () => {
    expect(() => validateHistory([bars[1]!, bars[0]!])).toThrow();
    expect(() => validateHistory([{ ...bars[0]!, high: 50 }])).toThrow();
    expect(() => validateHistory([{ ...bars[0]!, confirmed: false }])).toThrow();
  });
  it('replays with real cost accounting and chronological executions', async () => {
    const result = await runBacktest(
      bars,
      parseEnv({
        ENTRY_ORDER_TYPE: 'Market',
        MIN_SIGNAL_SCORE: '60',
        MAKER_FEE_BPS: '2',
        BREAKEVEN_ENABLED: 'false',
      }),
      new Map([['BTCUSDT', { ...instrument, tickSize: '0.001', qtyStep: '0.001' }]]),
    );
    expect(result.stats.totalTrades).toBeGreaterThan(0);
    expect(result.stats.fees).toBeGreaterThan(0);
    expect(result.trades.every((t) => t.exitTime >= t.entryTime)).toBe(true);
    expect(result.trades.every((t) => t.entryTime >= (t.signalScore >= 0 ? 300 * 60000 : 0))).toBe(
      true,
    );
    expect(result.stats.netPnL).toBeCloseTo(result.stats.grossPnL - result.stats.fees);
  });
  it('reports expectancy and drawdown after costs', () => {
    const trades = [
      { exitTime: 1, grossPnL: 12, fees: 2, netPnL: 10, estimatedSlippage: 1 },
      { exitTime: 2, grossPnL: -3, fees: 2, netPnL: -5, estimatedSlippage: 1 },
    ] as Trade[];
    expect(tradeStats(trades, 100).profitFactor).toBe(2);
    expect(tradeStats(trades, 100).expectancy).toBe(2.5);
    expect(tradeStats(trades, 100).maxDrawdown).toBe(5);
  });
});

describe('portfolio replay barriers', () => {
  it('sizes all same-minute entries before any later intrabar loss', async () => {
    const shaped = bars.map((b, i) => (i === 300 ? { ...b, low: b.open - 2 } : b));
    const multi = shaped.flatMap((b) => [
      { ...b, symbol: 'BTCUSDT' },
      { ...b, symbol: 'ETHUSDT' },
    ]);
    const c = parseEnv({
      ENTRY_ORDER_TYPE: 'Market',
      MIN_SIGNAL_SCORE: '60',
      BREAKEVEN_ENABLED: 'false',
      MAX_OPEN_POSITIONS: '2',
      MAX_CONSECUTIVE_LOSSES: '50',
      COOLDOWN_AFTER_LOSS_MINUTES: '0',
    });
    const result = await runBacktest(
      multi,
      c,
      new Map([
        ['BTCUSDT', { ...instrument, tickSize: '0.001', qtyStep: '0.001' }],
        ['ETHUSDT', { ...instrument, symbol: 'ETHUSDT', tickSize: '0.001', qtyStep: '0.001' }],
      ]),
    );
    const first = result.trades.find((t) => t.symbol === 'BTCUSDT')!,
      second = result.trades.find((t) => t.symbol === 'ETHUSDT')!;
    expect(first.entryTime).toBe(second.entryTime);
    // Entry fees can slightly lower second sizing; a later stop loss cannot.
    expect(Math.abs(first.quantity - second.quantity)).toBeLessThan(0.02);
  });
});
