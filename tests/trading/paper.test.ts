import { describe, expect, it } from 'vitest';
import { PaperExecutionEngine } from '../../src/trading/PaperExecutionEngine.js';
import { parseEnv } from '../../src/config/env.js';
import { Journal } from '../../src/database/db.js';
import { createLogger } from '../../src/utils/logger.js';
import { instrument, signal } from '../helpers.js';
import type { Trade } from '../../src/exchange/bybit/types.js';
const plan = {
  entry: 100,
  stopLoss: 95,
  takeProfit: 110,
  quantity: 1,
  riskAmount: 5,
  riskBudget: 25,
};
const quote = { bid: 99.9, ask: 100.1, timestamp: 1000, imbalance: 1 };
describe('paper execution on executable prices', () => {
  it('accounts for entry/exit fees and adverse market slippage', async () => {
    const db = new Journal(':memory:');
    const paper = new PaperExecutionEngine(
      parseEnv({ TRADING_MODE: 'paper', ENTRY_ORDER_TYPE: 'Market' }),
      db,
      createLogger('silent'),
      new Map([['BTCUSDT', instrument]]),
    );
    await paper.submit(signal, plan, quote, 1000);
    expect(paper.positions.get('BTCUSDT')?.entry).toBeGreaterThan(quote.ask);
    await paper.onQuote('BTCUSDT', { ...quote, bid: 111, ask: 111.2, timestamp: 2000 }, 2000);
    const trade = db.list<Trade>('trades')[0]!;
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.estimatedSlippage).toBeGreaterThan(0);
    expect(trade.netPnL).toBeCloseTo(trade.grossPnL - trade.fees);
    expect(trade.exitReason).toBe('take_profit');
    db.close();
  });
  it('limit orders require later trade-through, allow partial fills and expire remainder', async () => {
    const db = new Journal(':memory:');
    const c = parseEnv({ TRADING_MODE: 'paper', ORDER_TIMEOUT_SECONDS: '2' });
    const p = new PaperExecutionEngine(
      c,
      db,
      createLogger('silent'),
      new Map([['BTCUSDT', instrument]]),
    );
    await p.submit(signal, plan, quote, 1000);
    expect(p.positions.size).toBe(0);
    await p.onTrade({
      id: 't',
      symbol: 'BTCUSDT',
      side: 'Sell',
      price: 99.5,
      quantity: 0.3,
      timestamp: 1500,
    });
    expect(p.positions.get('BTCUSDT')?.quantity).toBe(0.3);
    await p.onTrade({
      id: 't',
      symbol: 'BTCUSDT',
      side: 'Sell',
      price: 99.5,
      quantity: 0.3,
      timestamp: 1500,
    });
    expect(p.positions.get('BTCUSDT')?.quantity).toBe(0.3);
    await p.onQuote('BTCUSDT', { ...quote, timestamp: 4000 }, 4000);
    expect(p.pendingSymbols()).toHaveLength(0);
    expect(p.positions.get('BTCUSDT')?.quantity).toBe(0.3);
    const restored = new PaperExecutionEngine(
      c,
      db,
      createLogger('silent'),
      new Map([['BTCUSDT', instrument]]),
    );
    expect(restored.positions.get('BTCUSDT')?.quantity).toBe(0.3);
    db.close();
  });
  it('fills stop gaps at the worse available quote and persists a complete journal', async () => {
    const db = new Journal(':memory:');
    const p = new PaperExecutionEngine(
      parseEnv({ TRADING_MODE: 'paper', ENTRY_ORDER_TYPE: 'Market' }),
      db,
      createLogger('silent'),
      new Map([['BTCUSDT', instrument]]),
    );
    await p.submit(signal, plan, quote, 1000);
    await p.onQuote('BTCUSDT', { ...quote, bid: 90, ask: 90.2, timestamp: 2000 }, 2000);
    expect(db.list<Trade>('trades')[0]?.exit).toBeLessThanOrEqual(90);
    expect(db.list<Trade>('trades')[0]?.exitReason).toBe('stop_loss');
    db.close();
  });
  it('rejects duplicate entry reservations', async () => {
    const db = new Journal(':memory:');
    const p = new PaperExecutionEngine(
      parseEnv({ TRADING_MODE: 'paper' }),
      db,
      createLogger('silent'),
      new Map([['BTCUSDT', instrument]]),
    );
    await p.submit(signal, plan, quote, 1000);
    await expect(p.submit(signal, plan, quote, 1001)).rejects.toThrow('Duplicate');
    db.close();
  });
});
