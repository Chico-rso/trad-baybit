import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { endpoints, type Config } from '../../config/env.js';
import type { MarketState } from '../../market/MarketState.js';
import type { Logger } from '../../utils/logger.js';
import type { Candle } from './types.js';
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
  constructor(
    private readonly client: BybitClient,
    private readonly market: MarketState,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    super();
    this.ws = new BybitWebSocket(
      endpoints(config).publicWs,
      config.SYMBOLS.flatMap((s) => [
        `kline.1.${s}`,
        `kline.5.${s}`,
        `orderbook.50.${s}`,
        `publicTrade.${s}`,
      ]),
      logger,
    );
    this.ws.on('disconnected', () => {
      this.generation++;
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
        for (const interval of [1, 5] as const) {
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
          const interval = Number(c.interval);
          if (interval !== 1 && interval !== 5) continue;
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
          if (this.market.candles.upsert(candle) && interval === 1) this.emit('candle', candle);
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
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.ws.stop();
  }
}
