import { describe, expect, it } from 'vitest';
import { moveProtection } from '../../src/trading/protection.js';
import { parseEnv } from '../../src/config/env.js';
import { instrument, signal } from '../helpers.js';
import type { Position } from '../../src/exchange/bybit/types.js';
const p: Position = {
  id: 'p',
  mode: 'paper',
  symbol: 'BTCUSDT',
  side: 'Long',
  quantity: 1,
  initialQuantity: 1,
  entry: 100,
  entryTime: 1000,
  stopLoss: 99.99,
  initialStopLoss: 99.99,
  takeProfit: 110,
  fees: 0.02,
  estimatedSlippage: 0,
  grossPnL: 0,
  exitValue: 0,
  exitQuantity: 0,
  signal,
  breakeven: false,
  trailingAnchor: 100,
};
describe('cost aware breakeven', () => {
  it('does not move the stop beyond market when fees exceed the 1R price move', () => {
    const q = { bid: 100.02, ask: 100.03, timestamp: 1000, imbalance: 1 };
    const moved = moveProtection(p, q, parseEnv({}), { ...instrument, tickSize: '0.001' });
    expect(moved.breakeven).toBe(false);
    expect(moved.stopLoss).toBeLessThan(q.bid);
  });
  it('rounds a breakeven stop to cover transaction costs and keeps it behind market', () => {
    const q = { bid: 106, ask: 106.1, timestamp: 1000, imbalance: 1 };
    const moved = moveProtection(
      { ...p, stopLoss: 95, initialStopLoss: 95 },
      q,
      parseEnv({}),
      instrument,
    );
    expect(moved.stopLoss).toBeGreaterThan(100.1);
    expect(moved.stopLoss).toBeLessThan(q.bid);
  });
});
