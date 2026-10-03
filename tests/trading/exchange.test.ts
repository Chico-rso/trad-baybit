import { describe, expect, it, vi } from 'vitest';
import { ExchangeExecutionEngine } from '../../src/trading/ExchangeExecutionEngine.js';
import { LiveExecutionEngine } from '../../src/trading/LiveExecutionEngine.js';
import { BybitClient } from '../../src/exchange/bybit/BybitClient.js';
import { BybitRestClient } from '../../src/exchange/bybit/BybitRestClient.js';
import { parseEnv } from '../../src/config/env.js';
import { Journal } from '../../src/database/db.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { createLogger } from '../../src/utils/logger.js';
import { instrument, signal } from '../helpers.js';
const setup = () => {
  const c = parseEnv({
    TRADING_MODE: 'testnet',
    BYBIT_API_KEY: 'test-key',
    BYBIT_API_SECRET: 'test-secret',
  });
  const db = new Journal(':memory:'),
    logger = createLogger('silent');
  const client = new BybitClient(new BybitRestClient(c, logger));
  const kill = new KillSwitch(db, logger, 'testnet');
  const engine = new ExchangeExecutionEngine(
    c,
    db,
    logger,
    new Map([['BTCUSDT', instrument]]),
    client,
    kill,
  );
  engine.setPreflight(() => true);
  return { c, db, client, kill, engine };
};
const plan = {
  entry: 100,
  stopLoss: 95,
  takeProfit: 110,
  quantity: 1,
  riskAmount: 5,
  riskBudget: 25,
};
const quote = { bid: 99.9, ask: 100.1, timestamp: 1000, imbalance: 1 };
describe('authenticated execution safety', () => {
  it('blocks construction of live engine without both flags', () => {
    const s = setup();
    expect(
      () =>
        new LiveExecutionEngine(
          { ...s.c, TRADING_MODE: 'live', ENABLE_LIVE_TRADING: false },
          s.db,
          createLogger('silent'),
          new Map(),
          s.client,
          s.kill,
        ),
    ).toThrow();
    s.db.close();
  });
  it('persists an ambiguous order intent, reconciles by link id and never resends', async () => {
    const s = setup();
    const create = vi.spyOn(s.client, 'createOrder').mockRejectedValue(new Error('timeout'));
    vi.spyOn(s.client, 'findOrder').mockResolvedValue(undefined);
    await expect(s.engine.submit(signal, plan, quote, 1000)).rejects.toThrow('ambiguous');
    expect(create).toHaveBeenCalledOnce();
    expect(s.kill.active).toBe(true);
    expect(s.engine.pendingSymbols()).toContain('BTCUSDT');
    await expect(s.engine.submit(signal, plan, quote, 1001)).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
    s.db.close();
  });
  it('reconciles successful timeout response without sending another POST', async () => {
    const s = setup();
    const create = vi.spyOn(s.client, 'createOrder').mockRejectedValue(new Error('timeout'));
    vi.spyOn(s.client, 'findOrder').mockImplementation(async (_symbol, id) => ({
      orderId: 'ex',
      orderLinkId: id,
      symbol: 'BTCUSDT',
      side: 'Buy',
      qty: '1',
      orderStatus: 'New',
      cumExecQty: '0',
      avgPrice: '',
      createdTime: '1000',
      updatedTime: '1000',
      reduceOnly: false,
      price: '100',
      orderType: 'Limit',
    }));
    await s.engine.submit(signal, plan, quote, 1000);
    expect(create).toHaveBeenCalledOnce();
    expect(s.kill.active).toBe(false);
    s.db.close();
  });
  it('accounts partial fills and deduplicates execution ids independently from order messages', async () => {
    const s = setup();
    vi.spyOn(s.client, 'createOrder').mockResolvedValue({ orderId: 'ex', orderLinkId: 'ignored' });
    await s.engine.submit(signal, plan, quote, 1000);
    const id = [...s.engine.orders.keys()][0]!;
    const fill = {
      execId: 'fill-1',
      orderId: 'ex',
      orderLinkId: id,
      symbol: 'BTCUSDT',
      side: 'Buy' as const,
      execQty: '0.3',
      execPrice: '100',
      execFee: '0.006',
      execTime: '1100',
      execType: 'Trade',
      closedSize: '0',
    };
    s.engine.handleExecutions([fill]);
    s.engine.handleExecutions([fill]);
    expect(s.engine.positions.get('BTCUSDT')?.quantity).toBe(0.3);
    s.db.close();
  });
  it('blocks startup for an unknown account position', async () => {
    const s = setup();
    vi.spyOn(s.client, 'equity').mockResolvedValue(10000);
    vi.spyOn(s.client, 'orders').mockResolvedValue([]);
    vi.spyOn(s.client, 'executions').mockResolvedValue([]);
    vi.spyOn(s.client, 'positions').mockResolvedValue([
      {
        symbol: 'ETHUSDT',
        size: '1',
        side: 'Buy',
        avgPrice: '100',
        positionIdx: 0,
        stopLoss: '0',
        takeProfit: '0',
        leverage: '1',
      },
    ]);
    await s.engine.reconcile();
    expect(s.kill.active).toBe(true);
    expect(s.engine.synchronized).toBe(false);
    s.db.close();
  });
});

describe('exchange recovery regressions', () => {
  it('confirms asynchronous cancellation before considering the entry cancelled', async () => {
    const s = setup();
    vi.spyOn(s.client, 'createOrder').mockResolvedValue({ orderId: 'ex', orderLinkId: 'ignored' });
    await s.engine.submit(signal, plan, quote, Date.now());
    const id = [...s.engine.orders.keys()][0]!;
    vi.spyOn(s.client, 'cancelOrder').mockResolvedValue({});
    const remote = {
      orderId: 'ex',
      orderLinkId: id,
      symbol: 'BTCUSDT',
      side: 'Buy' as const,
      qty: '1',
      orderStatus: 'New',
      cumExecQty: '0',
      avgPrice: '',
      createdTime: String(Date.now()),
      updatedTime: String(Date.now()),
      reduceOnly: false,
      price: '100',
      orderType: 'Limit' as const,
    };
    const find = vi
      .spyOn(s.client, 'findOrder')
      .mockResolvedValueOnce(remote)
      .mockResolvedValue({ ...remote, orderStatus: 'Cancelled' });
    await s.engine.cancelEntries();
    expect(find).toHaveBeenCalledTimes(2);
    expect(s.engine.orders.get(id)?.state).toBe('cancelled');
    s.db.close();
  });
  it('keeps reconciled position management available while a kill blocks new entries', async () => {
    const s = setup();
    const now = Date.now();
    vi.spyOn(s.client, 'createOrder').mockResolvedValue({ orderId: 'ex', orderLinkId: 'ignored' });
    await s.engine.submit(signal, plan, quote, now);
    const id = [...s.engine.orders.keys()][0]!;
    s.engine.handleExecutions([
      {
        execId: 'in',
        orderId: 'ex',
        orderLinkId: id,
        symbol: 'BTCUSDT',
        side: 'Buy',
        execQty: '1',
        execPrice: '100',
        execFee: '0.02',
        execTime: String(now),
        execType: 'Trade',
        closedSize: '0',
      },
    ]);
    vi.spyOn(s.client, 'executions').mockResolvedValue([]);
    vi.spyOn(s.client, 'orders').mockResolvedValue([]);
    vi.spyOn(s.client, 'equity').mockResolvedValue(10000);
    vi.spyOn(s.client, 'positions').mockResolvedValue([
      {
        symbol: 'BTCUSDT',
        size: '1',
        side: 'Buy',
        avgPrice: '100',
        positionIdx: 0,
        stopLoss: '95',
        takeProfit: '110',
        leverage: '1',
      },
    ]);
    s.kill.activate('daily loss limit');
    await s.engine.reconcile();
    expect(s.engine.synchronized).toBe(true);
    const protection = vi.spyOn(s.client, 'setProtection').mockResolvedValue({});
    await s.engine.onQuote('BTCUSDT', { ...quote, bid: 106, ask: 106.2 }, now + 2000);
    expect(protection).toHaveBeenCalledOnce();
    s.db.close();
  });
});

describe('definitive close rejection', () => {
  it('releases closing reservation so an explicitly requested later close can be attempted', async () => {
    const s = setup();
    const now = Date.now();
    const create = vi
      .spyOn(s.client, 'createOrder')
      .mockResolvedValue({ orderId: 'ex', orderLinkId: 'ignored' });
    await s.engine.submit(signal, plan, quote, now);
    const id = [...s.engine.orders.keys()][0]!;
    s.engine.handleExecutions([
      {
        execId: 'in',
        orderId: 'ex',
        orderLinkId: id,
        symbol: 'BTCUSDT',
        side: 'Buy',
        execQty: '1',
        execPrice: '100',
        execFee: '0.02',
        execTime: String(now),
        execType: 'Trade',
        closedSize: '0',
      },
    ]);
    vi.spyOn(s.client, 'executions').mockResolvedValue([]);
    vi.spyOn(s.client, 'orders').mockResolvedValue([]);
    vi.spyOn(s.client, 'equity').mockResolvedValue(10000);
    vi.spyOn(s.client, 'positions').mockResolvedValue([
      {
        symbol: 'BTCUSDT',
        size: '1',
        side: 'Buy',
        avgPrice: '100',
        positionIdx: 0,
        stopLoss: '95',
        takeProfit: '110',
        leverage: '1',
      },
    ]);
    const { BybitApiError } = await import('../../src/exchange/bybit/BybitRestClient.js');
    create.mockRejectedValue(new BybitApiError(110007));
    await expect(s.engine.closeAll('shutdown')).rejects.toThrow();
    expect(s.engine.positions.get('BTCUSDT')?.closing).toBe(false);
    await expect(s.engine.closeAll('shutdown')).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(3);
    s.db.close();
  });
});

describe('shutdown and restart reservations', () => {
  it('recovers a closing flag left behind by a terminal order write', async () => {
    const s = setup(),
      now = Date.now();
    vi.spyOn(s.client, 'createOrder').mockResolvedValue({ orderId: 'ex', orderLinkId: 'ignored' });
    await s.engine.submit(signal, plan, quote, now);
    const entry = [...s.engine.orders.values()][0]!;
    s.engine.handleExecutions([
      {
        execId: 'in',
        orderId: 'ex',
        orderLinkId: entry.id,
        symbol: 'BTCUSDT',
        side: 'Buy',
        execQty: '1',
        execPrice: '100',
        execFee: '0.02',
        execTime: String(now),
        execType: 'Trade',
        closedSize: '0',
      },
    ]);
    const p = s.engine.positions.get('BTCUSDT')!;
    s.db.save('positions', p.id, { ...p, closing: true }, now);
    s.db.save(
      'orders',
      'rejected-close',
      { ...entry, id: 'rejected-close', side: 'Short', reduceOnly: true, state: 'rejected' },
      now,
    );
    const restored = new ExchangeExecutionEngine(
      s.c,
      s.db,
      createLogger('silent'),
      new Map([['BTCUSDT', instrument]]),
      s.client,
      s.kill,
    );
    vi.spyOn(s.client, 'executions').mockResolvedValue([]);
    vi.spyOn(s.client, 'orders').mockResolvedValue([]);
    vi.spyOn(s.client, 'equity').mockResolvedValue(10000);
    vi.spyOn(s.client, 'positions').mockResolvedValue([
      {
        symbol: 'BTCUSDT',
        size: '1',
        side: 'Buy',
        avgPrice: '100',
        positionIdx: 0,
        stopLoss: '95',
        takeProfit: '110',
        leverage: '1',
      },
    ]);
    expect(restored.positions.get('BTCUSDT')?.closing).toBe(true);
    await restored.reconcile();
    expect(restored.positions.get('BTCUSDT')?.closing).toBe(false);
    s.db.close();
  });
  it('does not resurrect another symbol closed while an earlier shutdown order is awaiting response', async () => {
    const s = setup(),
      now = Date.now(),
      log = createLogger('silent');
    const engine = new ExchangeExecutionEngine(
      s.c,
      s.db,
      log,
      new Map([
        ['BTCUSDT', instrument],
        ['ETHUSDT', { ...instrument, symbol: 'ETHUSDT' }],
      ]),
      s.client,
      s.kill,
    );
    engine.setPreflight(() => true);
    const create = vi
      .spyOn(s.client, 'createOrder')
      .mockImplementation(async (r) => ({ orderId: r.symbol, orderLinkId: r.orderLinkId }));
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      await engine.submit({ ...signal, id: 'signal-' + symbol, symbol }, plan, quote, now);
      const o = [...engine.orders.values()].find((o) => o.symbol === symbol)!;
      engine.handleExecutions([
        {
          execId: 'in-' + symbol,
          orderId: symbol,
          orderLinkId: o.id,
          symbol,
          side: 'Buy',
          execQty: '1',
          execPrice: '100',
          execFee: '0.02',
          execTime: String(now),
          execType: 'Trade',
          closedSize: '0',
        },
      ]);
    }
    vi.spyOn(s.client, 'executions').mockResolvedValue([]);
    vi.spyOn(s.client, 'orders').mockResolvedValue([]);
    vi.spyOn(s.client, 'equity').mockResolvedValue(10000);
    vi.spyOn(s.client, 'positions').mockResolvedValue(
      ['BTCUSDT', 'ETHUSDT'].map((symbol) => ({
        symbol,
        size: '1',
        side: 'Buy',
        avgPrice: '100',
        positionIdx: 0,
        stopLoss: '95',
        takeProfit: '110',
        leverage: '1',
      })),
    );
    create.mockImplementation(async (r) => {
      if (r.reduceOnly && r.symbol === 'BTCUSDT')
        engine.handleExecutions([
          {
            execId: 'out-eth',
            orderId: 'external-close',
            orderLinkId: '',
            symbol: 'ETHUSDT',
            side: 'Sell',
            execQty: '1',
            execPrice: '101',
            execFee: '0.02',
            execTime: String(now + 1),
            execType: 'Trade',
            closedSize: '1',
          },
        ]);
      return { orderId: 'close-' + r.symbol, orderLinkId: r.orderLinkId };
    });
    await engine.closeAll('shutdown');
    expect(engine.positions.has('ETHUSDT')).toBe(false);
    expect(s.db.list('trades')).toHaveLength(1);
    expect([...engine.orders.values()].filter((o) => o.reduceOnly)).toHaveLength(1);
    s.db.close();
  });
});
