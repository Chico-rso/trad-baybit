import { expect, it } from 'vitest';
import { reservedMargin } from '../../src/risk/PositionSizer.js';
import { signal } from '../helpers.js';
import type { Order, Position } from '../../src/exchange/bybit/types.js';

it('does not reserve cancelled history when another order for that symbol is pending', () => {
  const order: Order = {
    id: 'old',
    mode: 'demo',
    symbol: 'BTCUSDT',
    side: 'Long',
    quantity: 100,
    filledQuantity: 0,
    entry: 100,
    type: 'Limit',
    state: 'cancelled',
    timestamp: 1000,
    signal,
  };
  const orders = [order, { ...order, id: 'new', quantity: 0.1, state: 'new' as const }];
  expect(reservedMargin([], orders, 1)).toBe(10);
});
it('counts only unfilled entry quantity alongside the existing partial position', () => {
  const order: Order = {
    id: 'new',
    mode: 'demo',
    symbol: 'BTCUSDT',
    side: 'Long',
    quantity: 1,
    filledQuantity: 0.3,
    entry: 100,
    type: 'Limit',
    state: 'partially_filled',
    timestamp: 1000,
    signal,
  };
  const position = { entry: 100, quantity: 0.3 } as Position;
  expect(reservedMargin([position], [order, { ...order, id: 'close', reduceOnly: true }], 1)).toBe(
    100,
  );
  expect(reservedMargin([position], [{ ...order, state: 'cancelled' }], 1)).toBe(30);
});
it('retains a reservation for a reported fill until its execution is accounted for', () => {
  const order: Order = {
    id: 'new',
    mode: 'demo',
    symbol: 'BTCUSDT',
    side: 'Long',
    quantity: 1,
    filledQuantity: 0.3,
    expectedFilledQuantity: 1,
    entry: 100,
    type: 'Limit',
    state: 'filled',
    timestamp: 1000,
    signal,
  };
  expect(reservedMargin([], [order], 1)).toBe(70);
});
