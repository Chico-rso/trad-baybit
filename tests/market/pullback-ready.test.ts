import { describe, expect, it } from 'vitest';
import { MarketState } from '../../src/market/MarketState.js';
import type { Candle, CandleInterval } from '../../src/exchange/bybit/types.js';
import { instrument } from '../helpers.js';

const hour = 60 * 60000;
const candle = (interval: CandleInterval, start: number): Candle => ({
  symbol: instrument.symbol,
  interval,
  start,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 10,
  turnover: 1000,
  confirmed: true,
});
function market(now: number) {
  const state = new MarketState([instrument.symbol]);
  state.publicConnected = true;
  state.synchronized.add(instrument.symbol);
  state.instruments.set(instrument.symbol, instrument);
  state.books.get(instrument.symbol)!.apply(
    'snapshot',
    {
      b: [['100', '1']],
      a: [['101', '1']],
      u: 1,
      seq: 1,
    },
    now,
  );
  return state;
}

describe('pullback market readiness', () => {
  it('uses confirmed native 15m/60m bars without requiring 1m/5m', () => {
    const now = 4 * hour + 1000,
      state = market(now);
    for (const interval of [15, 60] as const)
      for (let i = 1; i <= 3; i++)
        state.candles.upsert(candle(interval, 4 * hour - i * interval * 60000));
    expect(state.ready(instrument.symbol, now, 15000, 180000, 3, [15, 60])).toBe(true);
    expect(state.ready(instrument.symbol, now, 15000, 180000, 3)).toBe(false);
  });

  it('rejects gaps, in-progress bars, future closes and overdue native intervals', () => {
    const now = 4 * hour + 180001,
      state = market(now);
    state.candles.upsert(candle(15, 4 * hour - 15 * 60000));
    state.candles.upsert(candle(60, 2 * hour));
    expect(state.ready(instrument.symbol, now, 15000, 180000, 1, [15, 60])).toBe(false);
    state.candles.upsert({ ...candle(60, 3 * hour), confirmed: false });
    expect(state.ready(instrument.symbol, now, 15000, 180000, 1, [15, 60])).toBe(false);
    state.candles.upsert(candle(60, 3 * hour));
    expect(state.ready(instrument.symbol, now, 15000, 180000, 1, [15, 60])).toBe(true);
    state.candles.upsert(candle(60, 4 * hour));
    expect(state.ready(instrument.symbol, now, 15000, 180000, 1, [15, 60])).toBe(false);
    const gapped = market(now);
    for (const interval of [15, 60] as const) {
      gapped.candles.upsert(candle(interval, 4 * hour - interval * 60000));
      gapped.candles.upsert(candle(interval, 4 * hour - 3 * interval * 60000));
    }
    expect(gapped.ready(instrument.symbol, now, 15000, 180000, 2, [15, 60])).toBe(false);
  });
});
