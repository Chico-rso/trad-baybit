import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { endpoints, strategyTimeframes, type Config } from '../../config/env.js';
import type { MarketState } from '../../market/MarketState.js';
import type { Logger } from '../../utils/logger.js';
import type { Candle, CandleInterval } from './types.js';
import { BybitClient } from './BybitClient.js';
import { BybitWebSocket, type WsMessage } from './BybitWebSocket.js';
const numeric = z.union([z.string(), z.number()]).transform(Number).refine(Number.isFinite);
const klineSchema = z.array(
  z.object({
    start: numeric,
    interval: z.string(),
    open: numeric,
    high: numeric,
    low: numeric,
    close: numeric,
    volume: numeric,
    turnover: numeric,
    confirm: z.boolean(),
  }),
);
const bookSchema = z.object({
  s: z.string(),
  b: z.array(z.array(z.string())),
  a: z.array(z.array(z.string())),
  u: z.number(),
  seq: z.number(),
});
const tradesSchema = z.array(
  z.object({
    i: z.string(),
    s: z.string(),
    S: z.enum(['Buy', 'Sell']),
    p: numeric,
    v: numeric,
    T: numeric,
  }),
);
export class BybitMarketData extends EventEmitter {
  readonly ws: BybitWebSocket;
  private generation = 0;
  private stopped = false;
  private readonly pendingEntries = new Map<string, Candle>();
  private readonly trendFetches = new Set<string>();
  private readonly intervals: readonly CandleInterval[];
  constructor(
    private readonly client: BybitClient,
    private readonly market: MarketState,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    super();
    this.intervals = [...new Set<CandleInterval>([1, ...strategyTimeframes(config)])];
    this.ws = new BybitWebSocket(
      endpoints(config).publicWs,
      config.SYMBOLS.flatMap((s) => [
        ...this.intervals.map((interval) => `kline.${interval}.${s}`),
        `orderbook.50.${s}`,
        `publicTrade.${s}`,
      ]),
      logger,
    );
    this.ws.on('disconnected', () => {
      this.generation++;
      this.pendingEntries.clear();
      this.trendFetches.clear();
      market.invalidate();
      this.emit('disconnected');
    });
    this.ws.on('connected', () => {
      market.publicConnected = true;
      void this.synchronize(++this.generation);
    });
    this.ws.on('fault', (err) => this.emit('fault', err));
    this.ws.on('data', (msg: WsMessage) => this.onData(msg));
  }
  async initialize(): Promise<void> {
    await this.client.rest.synchronizeClock();
    for (const symbol of this.config.SYMBOLS)
      this.market.instruments.set(symbol, await this.client.instrument(symbol));
  }
  start(): void {
    this.ws.start();
  }
  private async synchronize(generation: number): Promise<void> {
    try {
      for (const symbol of this.config.SYMBOLS) {
        // Session VWAP uses all candles since 00:00 UTC; fetch up to 1440 bars.
        for (const interval of this.intervals) {
          const recent = await this.client.candles(symbol, interval, 1000);
          const oldest = recent[0];
          const day = Math.floor(Date.now() / 86400000) * 86400000;
          const prior =
            interval === 1 && oldest && oldest.start > day
              ? await this.client.candles(symbol, interval, 1000, oldest.start - 1)
              : [];
          if (generation !== this.generation || this.stopped) return;
          for (const candle of [...prior, ...recent]) this.market.candles.upsert(candle);
        }
        if (generation !== this.generation || this.stopped) return;
        this.market.synchronized.add(symbol);
        this.flushEntry(symbol);
      }
      this.logger.info({ event: 'market.synchronized', symbols: this.config.SYMBOLS });
      this.emit('synchronized');
    } catch (err) {
      this.market.synchronized.clear();
      this.logger.error({ event: 'market.sync.failed', error: err });
      this.emit('fault', err);
      this.ws.forceReconnect();
    }
  }
  private onData(msg: WsMessage): void {
    try {
      if (msg.topic?.startsWith('kline.')) {
        const symbol = msg.topic.split('.')[2]!;
        if (!this.market.books.has(symbol)) return;
        for (const c of klineSchema.parse(msg.data)) {
          const interval = Number(c.interval) as CandleInterval;
          if (!this.intervals.includes(interval)) continue;
          const candle: Candle = {
            symbol,
            interval,
            start: c.start,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            turnover: c.turnover,
            confirmed: c.confirm,
          };
          const added = this.market.candles.upsert(candle);
          const [entryInterval, trendInterval] = strategyTimeframes(this.config);
          if (added && interval === entryInterval) {
            if (this.config.STRATEGY === 'trend-pullback') {
              const existing = this.pendingEntries.get(symbol);
              if (!existing || existing.start < candle.start)
                this.pendingEntries.set(symbol, candle);
              if (!this.flushEntry(symbol)) void this.fetchTrend(candle);
            } else this.emit('candle', candle);
          }
          if (interval === trendInterval && candle.confirmed) this.flushEntry(symbol);
        }
      } else if (msg.topic?.startsWith('orderbook.')) {
        const b = bookSchema.parse(msg.data);
        const book = this.market.books.get(b.s);
        if (!book) return;
        if (msg.type !== 'snapshot' && msg.type !== 'delta') throw new Error('Invalid book type');
        const receivedAt = Date.now();
        const localTimestamp = this.client.rest.localTimestamp(msg.ts ?? 0);
        if (localTimestamp > receivedAt + 1000)
          throw new Error('Orderbook timestamp too far ahead');
        // Convert exchange clock to the local clock. Small RTT estimation errors
        // must not make a newly received update appear to arrive in the future.
        // Retain older source timestamps so genuinely delayed data stays stale.
        if (!book.apply(msg.type, b, Math.min(receivedAt, localTimestamp))) {
          this.market.synchronized.delete(b.s);
          this.emit('fault', new Error('Orderbook continuity lost'));
          this.ws.forceReconnect();
        } else this.emit('quote', b.s, book.quote());
      } else if (msg.topic?.startsWith('publicTrade.')) {
        for (const t of tradesSchema.parse(msg.data)) {
          const trade = {
            id: t.i,
            symbol: t.s,
            side: t.S,
            price: t.p,
            quantity: t.v,
            timestamp: t.T,
          };
          if (this.market.trades.add(trade)) this.emit('trade', trade);
        }
      }
    } catch (err) {
      this.emit('fault', err);
      this.ws.forceReconnect();
    }
  }
  // A 15m close and the corresponding hourly close can arrive in either order.
  // Never evaluate against the previous hour just because it is still within
  // delivery grace. REST fills the bar immediately if the WS packet is delayed.
  private flushEntry(symbol: string): boolean {
    const entry = this.pendingEntries.get(symbol);
    if (!entry) return true;
    const [, trendInterval] = strategyTimeframes(this.config);
    const end = entry.start + entry.interval * 60000;
    const now = Date.now();
    const trendDuration = trendInterval * 60000;
    const expected = Math.floor(end / trendDuration) * trendDuration - trendDuration;
    const latest = this.market.candles.get(symbol, trendInterval).at(-1);
    if (now - end > this.config.CANDLE_STALE_MS || (latest && latest.start > expected)) {
      this.pendingEntries.delete(symbol);
      return true;
    }
    if (now < end || latest?.start !== expected) return false;
    this.pendingEntries.delete(symbol);
    this.emit('candle', entry);
    return true;
  }
  private async fetchTrend(entry: Candle): Promise<void> {
    const generation = this.generation;
    const [, trendInterval] = strategyTimeframes(this.config);
    const key = `${generation}:${entry.symbol}:${entry.start}`;
    if (this.trendFetches.has(key)) return;
    this.trendFetches.add(key);
    try {
      const bars = await this.client.candles(
        entry.symbol,
        trendInterval,
        2,
        entry.start + entry.interval * 60000 - 1,
      );
      if (generation !== this.generation || this.stopped) return;
      for (const bar of bars) this.market.candles.upsert(bar);
      this.flushEntry(entry.symbol);
    } catch (err) {
      if (generation !== this.generation || this.stopped) return;
      this.logger.warn({ event: 'market.trend.sync.failed', symbol: entry.symbol, error: err });
      this.emit('fault', err);
    } finally {
      this.trendFetches.delete(key);
    }
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.pendingEntries.clear();
    this.trendFetches.clear();
    this.ws.stop();
  }
}
