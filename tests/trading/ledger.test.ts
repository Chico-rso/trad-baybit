import { describe, expect, it, vi } from 'vitest';
import { PositionLedger } from '../../src/trading/PositionLedger.js';
import { Journal } from '../../src/database/db.js';
import { createLogger } from '../../src/utils/logger.js';
import { signal } from '../helpers.js';
import type { Fill, Order } from '../../src/exchange/bybit/types.js';
class Ledger extends PositionLedger {
  add(order: Order) {
    this.recordOrder(order);
  }
  entry(id: string, fill: Fill) {
    return this.applyEntry(id, fill);
  }
  exit(fill: Fill, id: string) {
    return this.applyExit(fill, 'manual', 0, id);
  }
}
describe('durable exit transaction', () => {
  it('commits reduce-only order progress with the fill and rolls both back on failure', () => {
    const db = new Journal(':memory:'),
      ledger = new Ledger(db, createLogger('silent'), 'paper');
    const o: Order = {
      id: 'entry',
      mode: 'paper',
      symbol: 'BTCUSDT',
      side: 'Long',
      quantity: 1,
      filledQuantity: 0,
      entry: 100,
      type: 'Market',
      state: 'new',
      timestamp: 1000,
      signal,
    };
    ledger.add(o);
    ledger.entry(o.id, {
      id: 'in',
      orderId: o.id,
      mode: 'paper',
      symbol: o.symbol,
      side: 'Buy',
      quantity: 1,
      price: 100,
      fee: 0.01,
      timestamp: 1000,
    });
    ledger.add({ ...o, id: 'close', side: 'Short', reduceOnly: true });
    const fill: Fill = {
      id: 'out',
      orderId: 'close',
      mode: 'paper',
      symbol: o.symbol,
      side: 'Sell',
      quantity: 0.3,
      price: 101,
      fee: 0.01,
      timestamp: 2000,
    };
    const save = db.save.bind(db);
    const spy = vi.spyOn(db, 'save').mockImplementation((table, id, value, time) => {
      if (table === 'orders' && id === 'close') throw new Error('disk failure');
      save(table, id, value, time);
    });
    expect(() => ledger.exit(fill, 'close')).toThrow('disk failure');
    expect(db.get('fills', 'out')).toBeUndefined();
    expect(ledger.positions.get(o.symbol)?.quantity).toBe(1);
    spy.mockRestore();
    ledger.exit(fill, 'close');
    expect(db.get<Order>('orders', 'close')?.filledQuantity).toBe(0.3);
    expect(ledger.positions.get(o.symbol)?.quantity).toBe(0.7);
    db.close();
  });
});

describe('late partial entry after a closed lifecycle', () => {
  it('keeps the completed journal intact and creates a distinct position lifecycle', () => {
    const db = new Journal(':memory:'),
      ledger = new Ledger(db, createLogger('silent'), 'paper');
    const o: Order = {
      id: 'entry',
      mode: 'paper',
      symbol: 'BTCUSDT',
      side: 'Long',
      quantity: 2,
      filledQuantity: 0,
      entry: 100,
      type: 'Limit',
      state: 'new',
      timestamp: 1000,
      signal,
    };
    ledger.add(o);
    ledger.entry(o.id, {
      id: 'in-1',
      orderId: o.id,
      mode: 'paper',
      symbol: o.symbol,
      side: 'Buy',
      quantity: 1,
      price: 100,
      fee: 0.01,
      timestamp: 1000,
    });
    ledger.add({ ...o, id: 'close-1', quantity: 1, side: 'Short', reduceOnly: true });
    ledger.exit(
      {
        id: 'out-1',
        orderId: 'close-1',
        mode: 'paper',
        symbol: o.symbol,
        side: 'Sell',
        quantity: 1,
        price: 101,
        fee: 0.01,
        timestamp: 2000,
      },
      'close-1',
    );
    ledger.entry(o.id, {
      id: 'in-2',
      orderId: o.id,
      mode: 'paper',
      symbol: o.symbol,
      side: 'Buy',
      quantity: 1,
      price: 99,
      fee: 0.01,
      timestamp: 3000,
    });
    expect(ledger.positions.get(o.symbol)?.id).not.toBe(o.id);
    ledger.add({ ...o, id: 'close-2', quantity: 1, side: 'Short', reduceOnly: true });
    ledger.exit(
      {
        id: 'out-2',
        orderId: 'close-2',
        mode: 'paper',
        symbol: o.symbol,
        side: 'Sell',
        quantity: 1,
        price: 100,
        fee: 0.01,
        timestamp: 4000,
      },
      'close-2',
    );
    expect(db.list('trades')).toHaveLength(2);
    db.close();
  });
});

describe('journal average entry across partial exits', () => {
  it('reports total weighted entry independently of remaining position average', () => {
    const db = new Journal(':memory:'),
      ledger = new Ledger(db, createLogger('silent'), 'paper');
    const o: Order = {
      id: 'entry',
      mode: 'paper',
      symbol: 'BTCUSDT',
      side: 'Long',
      quantity: 2,
      filledQuantity: 0,
      entry: 100,
      type: 'Limit',
      state: 'new',
      timestamp: 1000,
      signal,
    };
    ledger.add(o);
    ledger.entry(o.id, {
      id: 'in1',
      orderId: o.id,
      mode: 'paper',
      symbol: o.symbol,
      side: 'Buy',
      quantity: 1,
      price: 100,
      fee: 0,
      timestamp: 1000,
    });
    ledger.add({ ...o, id: 'close', quantity: 2, side: 'Short', reduceOnly: true });
    ledger.exit(
      {
        id: 'out1',
        orderId: 'close',
        mode: 'paper',
        symbol: o.symbol,
        side: 'Sell',
        quantity: 0.5,
        price: 102,
        fee: 0,
        timestamp: 2000,
      },
      'close',
    );
    ledger.entry(o.id, {
      id: 'in2',
      orderId: o.id,
      mode: 'paper',
      symbol: o.symbol,
      side: 'Buy',
      quantity: 1,
      price: 101,
      fee: 0,
      timestamp: 3000,
    });
    ledger.exit(
      {
        id: 'out2',
        orderId: 'close',
        mode: 'paper',
        symbol: o.symbol,
        side: 'Sell',
        quantity: 1.5,
        price: 102,
        fee: 0,
        timestamp: 4000,
      },
      'close',
    );
    const trade = db.list<{ entry: number; grossPnL: number }>('trades')[0]!;
    expect(trade.entry).toBe(100.5);
    expect(trade.grossPnL).toBeCloseTo(3);
    db.close();
  });
});
