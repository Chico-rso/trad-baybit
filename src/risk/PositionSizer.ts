import { Decimal } from 'decimal.js';
import type { Config } from '../config/env.js';
import type { Instrument, Signal, Position, Order } from '../exchange/bybit/types.js';
import { pendingEntry } from '../trading/ExecutionEngine.js';
import { normalizePrice, normalizeQuantity } from '../utils/math.js';
export interface SizedPlan {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  riskAmount: number;
  riskBudget: number;
}
export function reservedMargin(
  positions: Iterable<Position>,
  orders: Iterable<Order>,
  leverage: number,
): number {
  let reserved = 0;
  for (const p of positions) reserved += (p.entry * p.quantity) / leverage;
  for (const o of orders)
    if (pendingEntry(o))
      reserved += (o.entry * Math.max(0, o.quantity - o.filledQuantity)) / leverage;
  return reserved;
}
export class PositionSizer {
  constructor(private readonly c: Config) {}
  size(
    equity: number,
    signal: Signal,
    instrument: Instrument,
    availableEquity = equity,
  ): SizedPlan {
    if (
      !Number.isFinite(equity) ||
      !Number.isFinite(availableEquity) ||
      equity <= 0 ||
      availableEquity <= 0
    )
      throw new Error('Invalid equity');
    const reservedMargin = Math.max(0, equity - availableEquity);
    equity = Math.min(equity, this.c.TRADING_CAPITAL_USDT ?? equity);
    availableEquity = Math.min(availableEquity, equity - reservedMargin);
    if (availableEquity <= 0) throw new Error('Allocated capital is already reserved');
    if (instrument.maxLeverage < this.c.LEVERAGE) throw new Error('Instrument leverage limit');
    const long = signal.side === 'Long';
    const entry = Number(
      normalizePrice(
        signal.entry,
        instrument.tickSize,
        this.c.ENTRY_ORDER_TYPE === 'Market' ? (long ? 'up' : 'down') : long ? 'down' : 'up',
      ),
    );
    // Stops round toward entry so normalization cannot silently increase risk.
    const stopLoss = Number(
      normalizePrice(signal.stopLoss, instrument.tickSize, long ? 'up' : 'down'),
    );
    const takeProfit = Number(
      normalizePrice(signal.takeProfit, instrument.tickSize, long ? 'down' : 'up'),
    );
    const distance = Math.abs(entry - stopLoss),
      reward = Math.abs(takeProfit - entry);
    if (
      entry <= 0 ||
      distance <= 0 ||
      (long ? stopLoss >= entry || takeProfit <= entry : stopLoss <= entry || takeProfit >= entry)
    )
      throw new Error('Invalid protective prices');
    if (reward / distance < this.c.MIN_RR) throw new Error('Normalized risk reward below minimum');
    const entryFee =
      signal.strategy === 'trend-pullback'
        ? this.c.TAKER_FEE_BPS
        : this.c.ENTRY_ORDER_TYPE === 'Limit' && this.c.POST_ONLY
          ? this.c.MAKER_FEE_BPS
          : this.c.TAKER_FEE_BPS;
    const roundingAllowance =
      this.c.SLIPPAGE_BPS > 0
        ? Number(instrument.tickSize) * (this.c.ENTRY_ORDER_TYPE === 'Market' ? 2 : 1)
        : 0;
    const costs = new Decimal(entry)
      .mul((entryFee + this.c.TAKER_FEE_BPS + 2 * this.c.SLIPPAGE_BPS) / 10000)
      .plus(roundingAllowance);
    if (new Decimal(reward).lte(costs))
      throw new Error('Take-profit reward does not cover estimated round-trip costs');
    if (
      signal.strategy === 'trend-pullback' &&
      (new Decimal(reward)
        .minus(costs)
        .div(new Decimal(distance).plus(costs))
        .lt(this.c.PULLBACK_MIN_NET_RR) ||
        new Decimal(distance).lt(costs.mul(3)))
    )
      throw new Error('Normalized net risk reward below pullback minimum');
    const perUnit = new Decimal(distance).plus(costs);
    const budget = new Decimal(equity).mul(this.c.RISK_PER_TRADE_PERCENT).div(100);
    const riskQty = budget.div(perUnit);
    const marginQty = new Decimal(availableEquity).mul(this.c.LEVERAGE).mul(0.95).div(entry);
    const maxQty = new Decimal(
      this.c.ENTRY_ORDER_TYPE === 'Market' ? instrument.maxMarketOrderQty : instrument.maxOrderQty,
    );
    const quantity = Number(
      normalizeQuantity(Decimal.min(riskQty, marginQty, maxQty).toString(), instrument.qtyStep),
    );
    if (
      quantity <= 0 ||
      quantity < Number(instrument.minOrderQty) ||
      new Decimal(quantity).mul(entry).lt(instrument.minNotional)
    )
      throw new Error('Position is below instrument minimums; never round risk upward');
    return {
      entry,
      stopLoss,
      takeProfit,
      quantity,
      riskAmount: perUnit.mul(quantity).toNumber(),
      riskBudget: budget.toNumber(),
    };
  }
}
