import { describe, expect, it } from 'vitest';
import { ema } from '../../src/indicators/ema.js';
import { rsi } from '../../src/indicators/rsi.js';
import { atr } from '../../src/indicators/atr.js';
import { vwap } from '../../src/indicators/vwap.js';
import { sma } from '../../src/indicators/volume.js';
import type { Candle } from '../../src/exchange/bybit/types.js';
const bars: Candle[] = [0, 1, 2].map((i) => ({
  symbol: 'BTCUSDT',
  interval: 1,
  start: i * 60000,
  open: 10 + i,
  high: 12 + i,
  low: 9 + i,
  close: 11 + i,
  volume: i + 1,
  turnover: (11 + i) * (i + 1),
  confirmed: true,
}));
describe('indicator numeric vectors', () => {
  it('EMA seeds with SMA and uses exponential recurrence', () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(ema([1], 3)).toBeUndefined();
  });
  it('RSI uses Wilder smoothing, flat market is 50, rising 100 and falling 0', () => {
    expect(rsi([1, 2, 3, 4], 3)).toBe(100);
    expect(rsi([4, 3, 2, 1], 3)).toBe(0);
    expect(rsi([1, 1, 1, 1], 3)).toBe(50);
    expect(rsi([1, 2, 1, 2, 1], 3)).toBeCloseTo(44.44444);
  });
  it('ATR includes gaps from previous close', () => {
    expect(atr(bars, 2)).toBe(3);
    expect(
      atr(
        [
          { ...bars[0]!, high: 12, low: 10, close: 11 },
          { ...bars[1]!, high: 20, low: 19, close: 20 },
        ],
        1,
      ),
    ).toBe(9);
  });
  it('VWAP uses session turnover and resets at UTC midnight', () => {
    expect(vwap(bars)).toBeCloseTo((11 + 24 + 39) / 6);
    expect(vwap([...bars, { ...bars[0]!, start: 86400000, turnover: 99, volume: 1 }])).toBe(99);
    expect(vwap([{ ...bars[0]!, volume: 0 }])).toBeUndefined();
  });
  it('SMA only uses the configured window', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
  });
});
