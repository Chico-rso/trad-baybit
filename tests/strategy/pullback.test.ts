import { describe, expect, it } from 'vitest';
import { parseEnv, strategyTimeframes } from '../../src/config/env.js';
import { TrendPullbackStrategy } from '../../src/strategy/TrendPullbackStrategy.js';
import { createStrategy } from '../../src/strategy/createStrategy.js';
import { ScalpingStrategy } from '../../src/strategy/ScalpingStrategy.js';
import type { Candle, Quote } from '../../src/exchange/bybit/types.js';

const now = 90 * 3600000;
export function pullbackBars(short = false) {
  const mirror = (price: number) => (short ? 200 - price : price);
  const make = (interval: 15 | 60): Candle[] =>
    Array.from({ length: 90 }, (_, i) => {
      const p =
        100 + i * (interval === 60 ? 0.1 : 0.05) + (interval === 15 ? Math.sin(i) * 0.2 : 0);
      return {
        symbol: 'BTCUSDT',
        interval,
        start: now - (90 - i) * interval * 60000,
        open: mirror(p - 0.05),
        close: mirror(p),
        high: mirror(p + (short ? -0.3 : 0.3)),
        low: mirror(p + (short ? 0.3 : -0.3)),
        volume: 100,
        turnover: p * 100,
        confirmed: true,
      };
    });
  const entry = make(15),
    trend = make(60);
  Object.assign(entry[88]!, {
    open: mirror(104.1),
    close: mirror(103.9),
    high: mirror(short ? 103.5 : 104.15),
    low: mirror(short ? 104.15 : 103.5),
  });
  Object.assign(entry[89]!, {
    open: mirror(104.1),
    close: mirror(104.6),
    high: mirror(short ? 103.95 : 104.8),
    low: mirror(short ? 104.8 : 103.95),
  });
  const price = mirror(104.6);
  const quote: Quote = { bid: price - 0.005, ask: price + 0.005, timestamp: now, imbalance: 1 };
  return { entry, trend, quote };
}
const config = (extra = {}) =>
  parseEnv({
    STRATEGY: 'trend-pullback',
    RSI_LONG_MIN: 0,
    RSI_LONG_MAX: 100,
    RSI_SHORT_MIN: 0,
    RSI_SHORT_MAX: 100,
    ...extra,
  });
const evaluate = (short = false, extra = {}) => {
  const bars = pullbackBars(short);
  return new TrendPullbackStrategy(config(extra)).evaluate(
    'BTCUSDT',
    bars.entry,
    bars.trend,
    bars.quote,
    now,
  );
};

describe('trend pullback strategy', () => {
  it('selects the strategy explicitly and keeps legacy defaults', () => {
    expect(createStrategy(parseEnv({}))).toBeInstanceOf(ScalpingStrategy);
    expect(createStrategy(config())).toBeInstanceOf(TrendPullbackStrategy);
    expect(strategyTimeframes(config())).toEqual([15, 60]);
    expect(() => parseEnv({ STRATEGY: 'unknown' })).toThrow();
  });
  it.each([false, true])('accepts a confirmed directional pullback (short=%s)', (short) => {
    const signals = evaluate(short);
    const selected = signals.find((s) => s.side === (short ? 'Short' : 'Long'))!;
    expect(selected.decision).toBe('accepted');
    expect(selected.strategy).toBe('trend-pullback');
    expect(selected.protection?.breakevenTriggerR).toBe(1.5);
    const risk = Math.abs(selected.entry - selected.stopLoss);
    expect(Math.abs(selected.takeProfit - selected.entry) / risk).toBeCloseTo(2.5);
    expect(signals.filter((s) => s.decision === 'accepted')).toHaveLength(1);
  });
  it('rejects direction opposed to the hourly trend', () => {
    const bars = pullbackBars();
    bars.trend = pullbackBars(true).trend;
    const s = new TrendPullbackStrategy(config()).evaluate(
      'BTCUSDT',
      bars.entry,
      bars.trend,
      bars.quote,
      now,
    );
    expect(s.find((s) => s.side === 'Long')?.rejections).toContain('1h trend unconfirmed');
  });
  it('requires a reversal close beyond the previous extreme', () => {
    const bars = pullbackBars();
    bars.entry.at(-1)!.close = 104.05;
    const s = new TrendPullbackStrategy(config()).evaluate(
      'BTCUSDT',
      bars.entry,
      bars.trend,
      bars.quote,
      now,
    );
    expect(s.every((s) => s.decision === 'rejected')).toBe(true);
    expect(s[0]?.rejections).toContain('pullback recovery unconfirmed');
  });
  it('rejects entry when expenses overwhelm the planned price movement', () => {
    expect(evaluate(false, { TAKER_FEE_BPS: 100, SLIPPAGE_BPS: 100 })[0]?.rejections).toContain(
      'net risk reward too low',
    );
  });
  it('rejects stale quotes, spread and excessive extension', () => {
    const bars = pullbackBars();
    const strategy = new TrendPullbackStrategy(config());
    expect(
      strategy.evaluate(
        'BTCUSDT',
        bars.entry,
        bars.trend,
        { ...bars.quote, timestamp: now - 16000 },
        now,
      )[0]?.rejections,
    ).toContain('quote stale');
    expect(
      strategy.evaluate(
        'BTCUSDT',
        bars.entry,
        bars.trend,
        { ...bars.quote, ask: bars.quote.bid + 1 },
        now,
      )[0]?.rejections,
    ).toContain('spread too high');
    expect(
      strategy.evaluate(
        'BTCUSDT',
        bars.entry,
        bars.trend,
        { ...bars.quote, bid: 110, ask: 110.01 },
        now,
      )[0]?.rejections,
    ).toContain('entry extended from EMA');
  });
  it('requires the latest closed hourly bar and ignores unfinished/future bars', () => {
    const bars = pullbackBars(),
      strategy = new TrendPullbackStrategy(config());
    expect(
      strategy.evaluate('BTCUSDT', bars.entry, bars.trend.slice(0, -1), bars.quote, now),
    ).toEqual([]);
    const future = { ...bars.trend.at(-1)!, start: now, close: 1 };
    const unfinished = { ...bars.entry.at(-1)!, start: now, close: 1, confirmed: false };
    expect(
      strategy.evaluate(
        'BTCUSDT',
        [...bars.entry, unfinished],
        [...bars.trend, future],
        bars.quote,
        now,
      ),
    ).toMatchObject(
      strategy
        .evaluate('BTCUSDT', bars.entry, bars.trend, bars.quote, now)
        .map(({ id: _id, ...s }) => s),
    );
  });
  it('rejects gaps even if the latest bar and total history length look valid', () => {
    const bars = pullbackBars();
    bars.trend.splice(-5, 1);
    expect(
      new TrendPullbackStrategy(config()).evaluate(
        'BTCUSDT',
        bars.entry,
        bars.trend,
        bars.quote,
        now,
      ),
    ).toEqual([]);
  });
});
