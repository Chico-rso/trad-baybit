import { z } from 'zod';
import type {
  Candle,
  CandleInterval,
  Instrument,
  ExchangeOrder,
  ExchangePosition,
  ExchangeFill,
  OrderRequest,
} from './types.js';
import { BybitRestClient, BybitApiError } from './BybitRestClient.js';

const positiveString = z.string().refine((v) => Number.isFinite(Number(v)) && Number(v) > 0);
const instrumentSchema = z.object({
  symbol: z.string(),
  status: z.literal('Trading'),
  contractType: z.literal('LinearPerpetual'),
  settleCoin: z.literal('USDT'),
  priceFilter: z.object({ tickSize: positiveString }),
  lotSizeFilter: z.object({
    qtyStep: positiveString,
    minOrderQty: positiveString,
    maxOrderQty: positiveString,
    maxMktOrderQty: positiveString,
    minNotionalValue: positiveString,
  }),
  leverageFilter: z.object({ maxLeverage: positiveString }),
});
export class BybitClient {
  constructor(readonly rest: BybitRestClient) {}
  async instrument(symbol: string): Promise<Instrument> {
    const raw = await this.rest.get<{ list: unknown[] }>('/v5/market/instruments-info', {
      category: 'linear',
      symbol,
    });
    const i = instrumentSchema.parse(raw.list[0]);
    return {
      symbol: i.symbol,
      tickSize: i.priceFilter.tickSize,
      qtyStep: i.lotSizeFilter.qtyStep,
      minOrderQty: i.lotSizeFilter.minOrderQty,
      maxOrderQty: i.lotSizeFilter.maxOrderQty,
      maxMarketOrderQty: i.lotSizeFilter.maxMktOrderQty,
      minNotional: i.lotSizeFilter.minNotionalValue,
      maxLeverage: Number(i.leverageFilter.maxLeverage),
    };
  }
  async candles(
    symbol: string,
    interval: CandleInterval,
    limit = 1000,
    end?: number,
  ): Promise<Candle[]> {
    const result = await this.rest.get<{ list: string[][] }>('/v5/market/kline', {
      category: 'linear',
      symbol,
      interval: String(interval),
      limit: String(limit),
      ...(end !== undefined ? { end: String(end) } : {}),
    });
    return result.list
      .map((row) => {
        const values = row.map(Number);
        if (values.length < 7 || values.some((v) => !Number.isFinite(v)))
          throw new Error('Invalid candle response');
        const [start, open, high, low, close, volume, turnover] = values as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        return {
          symbol,
          interval,
          start,
          open,
          high,
          low,
          close,
          volume,
          turnover,
          confirmed: start + interval * 60000 <= Date.now(),
        };
      })
      .filter((c) => c.confirmed)
      .sort((a, b) => a.start - b.start);
  }
  async equity(): Promise<number> {
    const r = await this.rest.get<{ list: { totalEquity: string }[] }>(
      '/v5/account/wallet-balance',
      { accountType: 'UNIFIED' },
      true,
    );
    const equity = Number(r.list[0]?.totalEquity);
    if (!Number.isFinite(equity) || equity <= 0)
      throw new Error('Cannot determine unified account equity');
    return equity;
  }
  async positions(): Promise<ExchangePosition[]> {
    return this.paginated('/v5/position/list', {
      category: 'linear',
      settleCoin: 'USDT',
      limit: '200',
    });
  }
  async orders(): Promise<ExchangeOrder[]> {
    return this.paginated('/v5/order/realtime', {
      category: 'linear',
      settleCoin: 'USDT',
      openOnly: '0',
      limit: '50',
    });
  }
  async executions(startTime?: number): Promise<ExchangeFill[]> {
    return this.paginated('/v5/execution/list', {
      category: 'linear',
      limit: '100',
      ...(startTime !== undefined ? { startTime: String(startTime) } : {}),
    });
  }
  private async paginated<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const rows: T[] = [];
    let cursor = '';
    do {
      const r = await this.rest.get<{ list: T[]; nextPageCursor?: string }>(
        path,
        { ...params, ...(cursor ? { cursor } : {}) },
        true,
      );
      rows.push(...r.list);
      cursor = r.nextPageCursor ?? '';
      if (rows.length > 10000) throw new Error('Reconciliation pagination limit exceeded');
    } while (cursor);
    return rows;
  }
  async findOrder(symbol: string, orderLinkId: string): Promise<ExchangeOrder | undefined> {
    const params = { category: 'linear', symbol, orderLinkId };
    const realtime = await this.rest.get<{ list: ExchangeOrder[] }>(
      '/v5/order/realtime',
      params,
      true,
    );
    if (realtime.list[0]) return realtime.list[0];
    return (await this.rest.get<{ list: ExchangeOrder[] }>('/v5/order/history', params, true))
      .list[0];
  }
  createOrder(request: OrderRequest): Promise<{ orderId: string; orderLinkId: string }> {
    return this.rest.post('/v5/order/create', { ...request });
  }
  cancelOrder(symbol: string, orderLinkId: string): Promise<unknown> {
    return this.rest.post('/v5/order/cancel', { category: 'linear', symbol, orderLinkId });
  }
  setProtection(
    symbol: string,
    stopLoss: string,
    takeProfit: string,
    trailingStop?: string,
  ): Promise<unknown> {
    return this.rest.post('/v5/position/trading-stop', {
      category: 'linear',
      symbol,
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss,
      takeProfit,
      slTriggerBy: 'LastPrice',
      tpTriggerBy: 'LastPrice',
      ...(trailingStop ? { trailingStop } : {}),
    });
  }
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.rest.post('/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
    } catch (err) {
      if (!(err instanceof BybitApiError && err.code === 110043)) throw err;
    }
  }
  async validateAccount(): Promise<void> {
    const key = await this.rest.get<{ readOnly: number; permissions: { Wallet?: string[] } }>(
      '/v5/user/query-api',
      {},
      true,
    );
    if (key.readOnly !== 0) throw new Error('Testnet/demo/live requires trade-enabled API key');
    if (key.permissions.Wallet?.some((p) => /withdraw/i.test(p)))
      throw new Error('Withdraw permission is forbidden');
    const info = await this.rest.get<{ unifiedMarginStatus: number; marginMode: string }>(
      '/v5/account/info',
      {},
      true,
    );
    if (![3, 4, 5, 6].includes(info.unifiedMarginStatus))
      throw new Error('Unified account required');
    if (info.marginMode !== 'REGULAR_MARGIN')
      throw new Error('MVP requires unified cross margin (REGULAR_MARGIN)');
  }
}
