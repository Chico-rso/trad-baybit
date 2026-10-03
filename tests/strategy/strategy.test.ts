import { describe, expect, it } from 'vitest';
import { SignalScore } from '../../src/strategy/SignalScore.js';
import { ScalpingStrategy } from '../../src/strategy/ScalpingStrategy.js';
import { parseEnv } from '../../src/config/env.js';
import type { Candle } from '../../src/exchange/bybit/types.js';
const config = parseEnv({});
const bars = (interval: 1 | 5, fall = false): Candle[] =>
  Array.from({ length: 90 }, (_, i) => {
    const price = 100 + (fall ? -i : i) * 0.03 + Math.sin(i) * 0.02;
    return {
      symbol: 'BTCUSDT',
      interval,
      start: i * interval * 60000 - (interval === 5 ? 21600000 : 0),
      open: price - 0.02,
      high: price + 0.2,
      low: price - 0.2,
      close: price,
      volume: i === 89 ? 200 : 100,
      turnover: price * (i === 89 ? 200 : 100),
      confirmed: true,
    };
  });
describe('heuristic strategy', () => {
  it('normalizes configured weights to 0..100 without probabilities', () => {
    const score = new SignalScore(config);
    expect(
      score.calculate({
        trend: true,
        ema: true,
        vwap: true,
        rsi: true,
        volume: true,
        book: true,
        spread: true,
      }).score,
    ).toBe(100);
    expect(
      score.calculate({
        trend: false,
        ema: false,
        vwap: false,
        rsi: false,
        volume: false,
        book: false,
        spread: false,
      }).score,
    ).toBe(0);
  });
  it('requires 5m confirmation even when other factors are good', () => {
    const s = new ScalpingStrategy(parseEnv({ MIN_SIGNAL_SCORE: '0' }));
    const signals = s.evaluate(
      'BTCUSDT',
      bars(1),
      bars(5, true),
      { bid: 102.66, ask: 102.67, timestamp: 6000000, imbalance: 2 },
      6000000,
    );
    const long = signals.find((v) => v.side === 'Long')!;
    expect(long.decision).toBe('rejected');
    expect(long.rejections).toContain('5m trend unconfirmed');
  });
  it('records full indicator snapshots and rejects excessive spread', () => {
    const signals = new ScalpingStrategy(config).evaluate(
      'BTCUSDT',
      bars(1),
      bars(5),
      { bid: 102, ask: 103, timestamp: 6000000, imbalance: 2 },
      6000000,
    );
    expect(signals[0]?.snapshot.ema50).toBeGreaterThan(0);
    expect(signals.every((s) => s.rejections.includes('spread too high'))).toBe(true);
  });
});
