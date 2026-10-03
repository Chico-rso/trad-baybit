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
const openPosition = async (filled = true) => {
  const s = setup();
  const now = Date.now();
  const create = vi
    .spyOn(s.client, 'createOrder')
    .mockResolvedValue({ orderId: 'entry', orderLinkId: 'ignored' });
  const cancel = vi.spyOn(s.client, 'cancelOrder').mockResolvedValue({});
  const protection = vi.spyOn(s.client, 'setProtection').mockResolvedValue({});
  await s.engine.submit(signal, plan, quote, now);
  const id = [...s.engine.orders.keys()][0]!;
  const entry = {
    execId: 'entry-fill',
    orderId: 'entry',
    orderLinkId: id,
    symbol: 'BTCUSDT',
    side: 'Buy' as const,
    execQty: '1',
    execPrice: '100',
    execFee: '0.02',
    execTime: String(now),
    execType: 'Trade',
    closedSize: '0',
  };
  if (filled) s.engine.handleExecutions([entry]);
  const close = {
    ...entry,
    execId: 'stop-fill',
    orderId: 'exchange-stop',
    orderLinkId: '',
    side: 'Sell' as const,
    execPrice: '95',
    execTime: String(now + 1),
    closedSize: '1',
    stopOrderType: 'StopLoss',
  };
  const executions = vi.spyOn(s.client, 'executions').mockResolvedValue([]);
  const positions = vi.spyOn(s.client, 'positions').mockResolvedValue([]);
  vi.spyOn(s.client, 'orders').mockResolvedValue([]);
  vi.spyOn(s.client, 'equity').mockResolvedValue(10000);
  return { ...s, now, entry, close, create, cancel, protection, executions, positions };
};
const remotePosition = {
  symbol: 'BTCUSDT',
  size: '1',
  side: 'Buy' as const,
  avgPrice: '100',
  positionIdx: 0,
  stopLoss: '95',
  takeProfit: '110',
  leverage: '1',
};
const nativeStop = {
  orderId: 'exchange-stop',
  orderLinkId: '',
  symbol: 'BTCUSDT',
  side: 'Sell' as const,
  qty: '1',
  orderStatus: 'New',
  cumExecQty: '0',
  avgPrice: '',
  createdTime: '1000',
  updatedTime: '1000',
  reduceOnly: true,
  price: '',
  orderType: 'Market' as const,
  stopOrderType: 'StopLoss',
};

describe('confirmation of a position missing from the first exchange snapshot', () => {
  it.each([false, true])(
    'confirms an owned entry before its execution with native protection orders: %s',
    async (protectionOrders) => {
      const s = await openPosition(false);
      if (protectionOrders)
        vi.mocked(s.client.orders).mockResolvedValue([
          nativeStop,
          { ...nativeStop, orderId: 'exchange-target', stopOrderType: 'TakeProfit' },
        ]);
      vi.spyOn(s.client, 'findOrder').mockResolvedValue({
        ...nativeStop,
        orderId: s.entry.orderId,
        orderLinkId: s.entry.orderLinkId,
        side: 'Buy',
        reduceOnly: false,
        stopOrderType: undefined,
        orderStatus: 'Filled',
        cumExecQty: '1',
      });
      s.executions.mockResolvedValueOnce([]).mockResolvedValue([s.entry, s.entry]);
      s.positions.mockResolvedValue([remotePosition]);
      try {
        await s.engine.reconcile();
        expect(s.kill.reasons).toEqual([]);
        expect(s.engine.synchronized).toBe(true);
        expect(s.engine.positions.get('BTCUSDT')?.quantity).toBe(1);
        expect(s.db.list('fills')).toHaveLength(1);
        expect(s.executions).toHaveBeenCalledTimes(2);
        expect(s.positions).toHaveBeenCalledTimes(2);
        expect(s.create).toHaveBeenCalledOnce();
        expect(s.cancel).not.toHaveBeenCalled();
        expect(s.protection).not.toHaveBeenCalled();
      } finally {
        s.db.close();
      }
    },
  );

  it('confirms a later partial entry fill before latching a quantity mismatch', async () => {
    const s = await openPosition(false);
    s.engine.handleExecutions([{ ...s.entry, execId: 'first-half', execQty: '0.5' }]);
    vi.mocked(s.client.orders).mockResolvedValue([
      {
        ...nativeStop,
        orderId: s.entry.orderId,
        orderLinkId: s.entry.orderLinkId,
        side: 'Buy',
        reduceOnly: false,
        stopOrderType: undefined,
        orderStatus: 'Filled',
        cumExecQty: '1',
      },
    ]);
    s.executions
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ ...s.entry, execId: 'second-half', execQty: '0.5' }]);
    s.positions.mockResolvedValue([remotePosition]);
    try {
      await s.engine.reconcile();
      expect(s.kill.reasons).toEqual([]);
      expect(s.engine.synchronized).toBe(true);
      expect(s.engine.positions.get('BTCUSDT')?.quantity).toBe(1);
      expect(s.db.list('fills')).toHaveLength(2);
      expect(s.executions).toHaveBeenCalledTimes(2);
      expect(s.create).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });

  it('keeps an actually unknown exchange position blocked after confirmation', async () => {
    const s = await openPosition();
    s.positions.mockResolvedValue([remotePosition, { ...remotePosition, symbol: 'ETHUSDT' }]);
    try {
      await s.engine.reconcile();
      expect(s.kill.reasons).toEqual(['unknown open exchange position']);
      expect(s.engine.synchronized).toBe(false);
      expect(s.executions).toHaveBeenCalledTimes(2);
      expect(s.positions).toHaveBeenCalledTimes(2);
      expect(s.create).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });

  it('preserves known native SL/TP classification from the order snapshot when confirmation closes the position', async () => {
    const s = await openPosition();
    const orders = vi
      .mocked(s.client.orders)
      .mockResolvedValue([
        nativeStop,
        { ...nativeStop, orderId: 'exchange-target', stopOrderType: 'TakeProfit' },
      ]);
    s.executions.mockResolvedValueOnce([]).mockResolvedValue([s.close]);
    try {
      await s.engine.reconcile();
      expect(s.kill.active).toBe(false);
      expect(s.engine.positions.size).toBe(0);
      expect(s.engine.synchronized).toBe(true);
      expect(s.db.state('reconcile:testnet')).toEqual(
        expect.objectContaining({ synchronized: true }),
      );
      expect(s.db.list('trades')).toHaveLength(1);
      expect(orders).toHaveBeenCalledOnce();
      expect(s.executions).toHaveBeenCalledTimes(2);
      expect(s.positions).toHaveBeenCalledTimes(2);
      expect(s.create).toHaveBeenCalledOnce();
      expect(s.cancel).not.toHaveBeenCalled();
      expect(s.protection).not.toHaveBeenCalled();
    } finally {
      s.db.close();
    }
  });

  it.each([undefined, 'StopLoss'])(
    'blocks an unknown non-reduce-only order alongside known protection: stop type %s',
    async (stopOrderType) => {
      const s = await openPosition();
      vi.mocked(s.client.orders).mockResolvedValue([
        nativeStop,
        { ...nativeStop, orderId: 'unknown-order', reduceOnly: false, stopOrderType },
      ]);
      s.executions.mockResolvedValueOnce([]).mockResolvedValue([s.close]);
      try {
        await s.engine.reconcile();
        expect(s.engine.positions.size).toBe(0);
        expect(s.db.list('trades')).toHaveLength(1);
        expect(s.engine.synchronized).toBe(false);
        expect(s.kill.reasons).toEqual(['unknown active exchange order']);
        expect(s.create).toHaveBeenCalledOnce();
      } finally {
        s.db.close();
      }
    },
  );

  it('accounts a stop fill that appears after the first executions GET without a false kill', async () => {
    const s = await openPosition();
    s.engine.synchronized = true;
    s.executions
      .mockImplementationOnce(async () => {
        expect(s.engine.synchronized).toBe(false);
        return [];
      })
      .mockImplementationOnce(async () => {
        expect(s.engine.synchronized).toBe(false);
        return [s.close];
      });
    s.positions.mockImplementation(async () => {
      expect(s.engine.synchronized).toBe(false);
      return [];
    });
    try {
      await s.engine.reconcile();
      expect(s.kill.active).toBe(false);
      expect(s.engine.synchronized).toBe(true);
      expect(s.engine.positions.size).toBe(0);
      expect(s.db.list('trades')).toEqual([
        expect.objectContaining({ exitReason: 'stop_loss', quantity: 1, netPnL: -5.04 }),
      ]);
      expect(s.db.list('fills')).toHaveLength(2);
      expect(s.executions).toHaveBeenCalledTimes(2);
      expect(s.positions).toHaveBeenCalledTimes(2);
      expect(s.executions.mock.calls[1]).toEqual(s.executions.mock.calls[0]);
      expect(s.executions.mock.calls[0]![0]).toBeGreaterThanOrEqual(s.now - 6 * 86400000);
      expect(s.create).toHaveBeenCalledOnce();
      expect(s.cancel).not.toHaveBeenCalled();
      expect(s.protection).not.toHaveBeenCalled();
    } finally {
      s.db.close();
    }
  });

  it('deduplicates repeated fills during confirmation and after restoring the persisted ledger', async () => {
    const s = await openPosition();
    s.executions.mockResolvedValueOnce([s.entry]).mockResolvedValue([s.entry, s.close, s.close]);
    try {
      await s.engine.reconcile();
      const restoredKill = new KillSwitch(s.db, createLogger('silent'), 'testnet');
      const restored = new ExchangeExecutionEngine(
        s.c,
        s.db,
        createLogger('silent'),
        new Map([['BTCUSDT', instrument]]),
        s.client,
        restoredKill,
      );
      await restored.reconcile();
      restored.handleExecutions([s.close]);
      expect(restored.positions.size).toBe(0);
      expect(restored.synchronized).toBe(true);
      expect(restoredKill.active).toBe(false);
      expect(s.db.list('trades')).toHaveLength(1);
      expect(s.db.list('fills')).toHaveLength(2);
      expect(s.create).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });

  it('preserves an unrelated persisted kill when the closing fill is confirmed', async () => {
    const s = await openPosition();
    s.kill.activate('daily loss limit');
    s.executions.mockResolvedValueOnce([]).mockResolvedValue([s.close]);
    try {
      await s.engine.reconcile();
      expect(s.engine.synchronized).toBe(true);
      expect(s.kill.reasons).toEqual(['daily loss limit']);
      expect(s.db.state('kill:testnet')).toEqual(['daily loss limit']);
      await expect(s.engine.submit(signal, plan, quote)).rejects.toThrow('preflight');
      expect(s.create).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });

  it('latches the existing missing-position reason after one unsuccessful confirmation', async () => {
    const s = await openPosition();
    try {
      await s.engine.reconcile();
      expect(s.engine.synchronized).toBe(false);
      expect(s.kill.reasons).toEqual(['local position missing on exchange']);
      expect(s.engine.positions.get('BTCUSDT')?.quantity).toBe(1);
      expect(s.db.list('trades')).toHaveLength(0);
      expect(s.executions).toHaveBeenCalledTimes(2);
      expect(s.positions).toHaveBeenCalledTimes(2);
      expect(s.create).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });

  it.each(['executions', 'positions'] as const)(
    'keeps entries blocked if the additional %s GET fails',
    async (method) => {
      const s = await openPosition();
      s[method]
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('confirmation GET failed'));
      s.engine.synchronized = true;
      try {
        await expect(s.engine.reconcile()).rejects.toThrow('confirmation GET failed');
        expect(s.engine.synchronized).toBe(false);
        expect(s.kill.reasons).toContain('cannot determine account position');
        expect(s.engine.positions.get('BTCUSDT')?.quantity).toBe(1);
        expect(s.db.list('trades')).toHaveLength(0);
        expect(s.create).toHaveBeenCalledOnce();
        expect(s.cancel).not.toHaveBeenCalled();
        expect(s.protection).not.toHaveBeenCalled();
      } finally {
        s.db.close();
      }
    },
  );

  it.each([
    [{ symbol: 'ETHUSDT' }, 'unknown open exchange position'],
    [{ size: '0.5' }, 'local/exchange position mismatch'],
    [{ side: 'Sell' as const }, 'local/exchange position mismatch'],
    [{ avgPrice: '101' }, 'local/exchange position mismatch'],
    [{ stopLoss: '0' }, 'exchange position has missing protection'],
    [{ takeProfit: '111' }, 'exchange protection differs from local state'],
    [{ leverage: '100' }, 'exchange leverage exceeds configured limit'],
    [{ positionIdx: 1 }, 'hedge mode unsupported; require one-way positions'],
    [{ size: 'NaN' }, 'unknown position quantity'],
  ] as const)('fully validates the refreshed position snapshot: %j', async (changes, reason) => {
    const s = await openPosition();
    s.positions.mockResolvedValueOnce([]).mockResolvedValue([{ ...remotePosition, ...changes }]);
    try {
      await s.engine.reconcile();
      expect(s.engine.synchronized).toBe(false);
      expect(s.kill.reasons).toContain(reason);
      expect(s.executions).toHaveBeenCalledTimes(2);
      expect(s.positions).toHaveBeenCalledTimes(2);
      expect(s.create).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });

  it('does not make extra GETs when the first position snapshot matches', async () => {
    const s = await openPosition();
    s.positions.mockResolvedValue([remotePosition]);
    try {
      await s.engine.reconcile();
      expect(s.engine.synchronized).toBe(true);
      expect(s.kill.active).toBe(false);
      expect(s.executions).toHaveBeenCalledOnce();
      expect(s.positions).toHaveBeenCalledOnce();
    } finally {
      s.db.close();
    }
  });
});

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
