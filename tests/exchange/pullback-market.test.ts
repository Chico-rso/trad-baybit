import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, type Config } from '../../src/config/env.js';
import { BybitClient } from '../../src/exchange/bybit/BybitClient.js';
import { BybitMarketData } from '../../src/exchange/bybit/BybitMarketData.js';
import { BybitRestClient } from '../../src/exchange/bybit/BybitRestClient.js';
import { MarketState } from '../../src/market/MarketState.js';
import type { Candle, CandleInterval } from '../../src/exchange/bybit/types.js';
import { createLogger } from '../../src/utils/logger.js';

const hour = 3600000;
const candle = (interval: CandleInterval, start: number): Candle => ({
  symbol: 'BTCUSDT',
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
function setup(strategy = 'trend-pullback') {
  const config = { ...parseEnv({ SYMBOLS: 'BTCUSDT' }), STRATEGY: strategy } as Config;
  const logger = createLogger('silent'),
    market = new MarketState(config.SYMBOLS);
  const client = new BybitClient(new BybitRestClient(config, logger));
  const feed = new BybitMarketData(client, market, config, logger);
  const emit = (c: Candle) =>
    feed.ws.emit('data', {
      topic: `kline.${c.interval}.${c.symbol}`,
      data: [{ ...c, interval: String(c.interval), confirm: c.confirmed }],
    });
  return { config, market, client, feed, emit };
}
afterEach(() => vi.restoreAllMocks());

describe('native pullback candles', () => {
  it('stores native 15m/60m and emits each closed entry candle once', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4 * hour + 1000);
    const { feed, emit, market } = setup();
    const entries = vi.fn();
    feed.on('candle', entries);
    try {
      emit(candle(60, 3 * hour));
      emit(candle(1, 4 * hour - 60000));
      emit({ ...candle(15, 4 * hour - 900000), confirmed: false });
      expect(entries).not.toHaveBeenCalled();
      emit(candle(15, 4 * hour - 900000));
      emit(candle(15, 4 * hour - 900000));
      expect(entries).toHaveBeenCalledTimes(1);
      expect(market.candles.get('BTCUSDT', 60)).toHaveLength(1);
      expect(market.candles.get('BTCUSDT', 15)).toHaveLength(1);
    } finally {
      feed.stop();
    }
  });

  it('waits for the matching closed hourly bar when 15m arrives first', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(4 * hour + 1000);
    const { feed, emit, client, market } = setup();
    let finish!: (candles: Candle[]) => void;
    vi.spyOn(client, 'candles').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const observed: number[] = [];
    feed.on('candle', () => observed.push(market.candles.get('BTCUSDT', 60).at(-1)!.start));
    try {
      emit(candle(60, 2 * hour));
      emit(candle(15, 4 * hour - 900000));
      expect(observed).toEqual([]);
      emit(candle(60, 3 * hour));
      expect(observed).toEqual([3 * hour]);
      finish([candle(60, 3 * hour)]);
      await Promise.resolve();
      expect(observed).toEqual([3 * hour]);
    } finally {
      feed.stop();
    }
  });

  it('fetches the closed hourly bar as fallback and drops stale or disconnected pending entries', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4 * hour + 1000);
    const { feed, emit, client, market, config } = setup();
    let finish!: (candles: Candle[]) => void;
    const fetch = vi.spyOn(client, 'candles').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const entries = vi.fn();
    feed.on('candle', entries);
    try {
      emit(candle(15, 4 * hour - 900000));
      expect(fetch).toHaveBeenCalledWith('BTCUSDT', 60, 2, 4 * hour - 1);
      finish([candle(60, 3 * hour)]);
      await Promise.resolve();
      expect(entries).toHaveBeenCalledTimes(1);
      expect(market.candles.get('BTCUSDT', 60).at(-1)?.start).toBe(3 * hour);
      now.mockReturnValue(5 * hour + 1000);
      emit(candle(15, 5 * hour - 900000));
      now.mockReturnValue(5 * hour + config.CANDLE_STALE_MS + 1);
      finish([candle(60, 4 * hour)]);
      await Promise.resolve();
      expect(entries).toHaveBeenCalledTimes(1);
      now.mockReturnValue(6 * hour + 1000);
      emit(candle(15, 6 * hour - 900000));
      feed.ws.emit('disconnected');
      finish([candle(60, 5 * hour)]);
      await Promise.resolve();
      expect(entries).toHaveBeenCalledTimes(1);
      expect(market.candles.get('BTCUSDT', 60).at(-1)?.start).toBe(4 * hour);
    } finally {
      feed.stop();
    }
  });

  it('warms up native entry/trend intervals on connection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(4 * hour + 1000);
    const { feed, client, market } = setup();
    const fetch = vi
      .spyOn(client, 'candles')
      .mockImplementation(async (_symbol, interval) => [
        candle(interval, 4 * hour - interval * 60000),
      ]);
    const synchronized = new Promise<void>((resolve) => feed.once('synchronized', resolve));
    try {
      feed.ws.emit('connected');
      await synchronized;
      expect(fetch.mock.calls.map((call) => call[1])).toEqual([1, 1, 15, 60]);
      expect(market.synchronized.has('BTCUSDT')).toBe(true);
      expect(market.candles.get('BTCUSDT', 15)).toHaveLength(1);
      expect(market.candles.get('BTCUSDT', 60)).toHaveLength(1);
    } finally {
      feed.stop();
    }
  });

  it('keeps scalping entry events on 1m candles', () => {
    const { feed, emit } = setup('scalping'),
      entries = vi.fn();
    feed.on('candle', entries);
    try {
      emit(candle(5, 0));
      emit(candle(1, 0));
      emit(candle(1, 0));
      expect(entries).toHaveBeenCalledTimes(1);
      expect(entries.mock.calls[0]![0].interval).toBe(1);
    } finally {
      feed.stop();
    }
  });
});
