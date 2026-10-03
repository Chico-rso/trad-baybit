import { describe, expect, it } from 'vitest';
import { CandleStore } from '../../src/market/CandleStore.js';
import { OrderBookStore } from '../../src/market/OrderBookStore.js';
import { TradeStore } from '../../src/market/TradeStore.js';
import { MarketState } from '../../src/market/MarketState.js';
import type { Candle } from '../../src/exchange/bybit/types.js';
const candle = (start: number): Candle => ({
  symbol: 'BTCUSDT',
  interval: 1,
  start,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
  turnover: 1000,
  confirmed: true,
});

describe('market stores', () => {
  it('deduplicates closed candles, rejects gaps and excludes in-progress bars', () => {
    const store = new CandleStore();
    store.upsert(candle(0));
    store.upsert(candle(60000));
    store.upsert({ ...candle(120000), confirmed: false });
    store.upsert({ ...candle(60000), close: 102 });
    expect(store.get('BTCUSDT', 1)).toHaveLength(2);
    expect(store.contiguous('BTCUSDT', 1, 2)).toBe(true);
    store.upsert(candle(180000));
    expect(store.contiguous('BTCUSDT', 1, 3)).toBe(false);
  });
  it('reconstructs snapshots/deltas, zero deletes, u=1 resets and regression invalidates', () => {
    const store = new OrderBookStore(10);
    expect(store.apply('delta', { b: [], a: [], u: 3, seq: 3 }, 10)).toBe(false);
    expect(
      store.apply(
        'snapshot',
        {
          b: [
            ['100', '2'],
            ['99', '3'],
          ],
          a: [['101', '1']],
          u: 2,
          seq: 10,
        },
        10,
      ),
    ).toBe(true);
    expect(store.quote()?.imbalance).toBe(5);
    expect(store.apply('delta', { b: [['99', '0']], a: [['101', '2']], u: 5, seq: 20 }, 20)).toBe(
      true,
    );
    expect(store.quote()?.imbalance).toBe(1);
    expect(store.apply('delta', { b: [], a: [], u: 4, seq: 19 }, 30)).toBe(false);
    expect(store.quote()).toBeUndefined();
    store.apply('snapshot', { b: [['90', '1']], a: [['91', '1']], u: 1, seq: 1 }, 40);
    expect(store.quote()?.bid).toBe(90);
  });
  it('deduplicates and bounds public trades', () => {
    const store = new TradeStore(2);
    for (const id of ['a', 'a', 'b', 'c'])
      store.add({ id, symbol: 'BTCUSDT', side: 'Buy', price: 100, quantity: 1, timestamp: 1 });
    expect(store.get('BTCUSDT').map((t) => t.id)).toEqual(['b', 'c']);
  });
  it('invalidates synchronization on reconnect and blocks stale market data', () => {
    const state = new MarketState(['BTCUSDT']);
    state.synchronized.add('BTCUSDT');
    state.publicConnected = true;
    state.candles.upsert(candle(0));
    state.books
      .get('BTCUSDT')
      ?.apply('snapshot', { b: [['100', '1']], a: [['101', '1']], u: 1, seq: 1 }, 100);
    expect(state.ready('BTCUSDT', 200, 1000, 100000, 1)).toBe(false); // missing 5m
    state.invalidate();
    expect(state.synchronized.size).toBe(0);
    expect(state.books.get('BTCUSDT')?.quote()).toBeUndefined();
  });
});

describe('timeframe freshness', () => {
  it('allows the configured delivery grace at a 5m close and still rejects genuinely overdue candles', () => {
    const state = new MarketState(['BTCUSDT']);
    state.publicConnected = true;
    state.synchronized.add('BTCUSDT');
    state.instruments.set('BTCUSDT', {
      symbol: 'BTCUSDT',
      tickSize: '0.1',
      qtyStep: '0.001',
      minOrderQty: '0.001',
      maxOrderQty: '100',
      maxMarketOrderQty: '100',
      minNotional: '5',
      maxLeverage: 3,
    });
    const quote = (now: number) =>
      state.books
        .get('BTCUSDT')!
        .apply('snapshot', { b: [['100', '1']], a: [['101', '1']], u: 1, seq: 1 }, now);
    state.candles.upsert(candle(540000));
    state.candles.upsert({ ...candle(0), interval: 5 });
    quote(600058);
    expect(state.ready('BTCUSDT', 600058, 15000, 180000, 1)).toBe(true);
    state.candles.upsert(candle(720000));
    quote(780001);
    expect(state.ready('BTCUSDT', 780001, 15000, 180000, 1)).toBe(false);
    state.candles.upsert({ ...candle(300000), interval: 5 });
    expect(state.ready('BTCUSDT', 780001, 15000, 180000, 1)).toBe(true);
  });
  it('keeps the most recent closed 5m candle healthy throughout the next 5m interval', () => {
    const state = new MarketState(['BTCUSDT']);
    state.publicConnected = true;
    state.synchronized.add('BTCUSDT');
    state.instruments.set('BTCUSDT', {
      symbol: 'BTCUSDT',
      tickSize: '0.1',
      qtyStep: '0.001',
      minOrderQty: '0.001',
      maxOrderQty: '100',
      maxMarketOrderQty: '100',
      minNotional: '5',
      maxLeverage: 3,
    });
    const now = 590000;
    state.candles.upsert(candle(480000));
    state.candles.upsert({ ...candle(0), interval: 5 });
    state.books
      .get('BTCUSDT')!
      .apply('snapshot', { b: [['100', '1']], a: [['101', '1']], u: 1, seq: 1 }, now);
    expect(state.ready('BTCUSDT', now, 15000, 180000, 1)).toBe(true);
  });
});
