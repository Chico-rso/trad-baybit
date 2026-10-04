import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Journal } from '../database/db.js';
import type { Logger } from '../utils/logger.js';
import type { Order, Position, Fill, Trade, ExitReason } from '../exchange/bybit/types.js';
import { nearlyEqual } from '../utils/math.js';
import { pendingEntry } from './ExecutionEngine.js';
export class PositionLedger extends EventEmitter {
  readonly orders = new Map<string, Order>();
  readonly positions = new Map<string, Position>();
  constructor(
    protected readonly db: Journal,
    protected readonly logger: Logger,
    protected readonly mode: string,
  ) {
    super();
    for (const o of db.list<Order>('orders', 10000, mode)) this.orders.set(o.id, o);
    for (const p of db.list<Position>('positions', 10000, mode))
      if (!p.closed) this.positions.set(p.symbol, p);
  }
  pendingSymbols(): string[] {
    return [...this.orders.values()].filter(pendingEntry).map((o) => o.symbol);
  }
  protected recordOrder(order: Order): void {
    this.db.save('orders', order.id, order, order.timestamp);
    this.orders.set(order.id, order);
  }
  protected updateOrder(id: string, changes: Partial<Order>): void {
    const previous = this.orders.get(id);
    if (!previous) throw new Error('Unknown local order');
    this.recordOrder({ ...previous, ...changes });
  }
  protected applyEntry(orderId: string, fill: Fill, slippage = 0): boolean {
    if (this.db.get('fills', fill.id)) return false;
    const original = this.orders.get(orderId);
    if (!original) throw new Error('Fill without durable order intent');
    if (original.filledQuantity + fill.quantity > original.quantity + 1e-8)
      throw new Error('Entry quantity exceeds reservation');
    const existing = this.positions.get(fill.symbol);
    if (existing && (existing.signal.id !== original.signal.id || existing.side !== original.side))
      throw new Error('Position ownership mismatch');
    const order = { ...original, filledQuantity: original.filledQuantity + fill.quantity };
    order.state = nearlyEqual(order.filledQuantity, order.quantity) ? 'filled' : 'partially_filled';
    if (['cancelled', 'rejected'].includes(original.state) && order.state !== 'filled')
      order.state = original.state;
    const p: Position = existing
      ? structuredClone(existing)
      : {
          id: this.db.get('trades', order.id) ? randomUUID() : order.id,
          mode: this.mode,
          symbol: order.symbol,
          side: order.side,
          quantity: 0,
          initialQuantity: 0,
          entry: 0,
          entryTime: fill.timestamp,
          stopLoss: order.signal.stopLoss,
          initialStopLoss: order.signal.stopLoss,
          takeProfit: order.signal.takeProfit,
          fees: 0,
          estimatedSlippage: 0,
          grossPnL: 0,
          exitValue: 0,
          exitQuantity: 0,
          signal: order.signal,
          breakeven: false,
          trailingAnchor: fill.price,
        };
    p.entryCost = (p.entryCost ?? p.entry * p.initialQuantity) + fill.price * fill.quantity;
    p.entry = (p.entry * p.quantity + fill.price * fill.quantity) / (p.quantity + fill.quantity);
    p.quantity += fill.quantity;
    p.initialQuantity += fill.quantity;
    p.fees += fill.fee;
    p.estimatedSlippage += slippage;
    this.db.transaction(() => {
      if (!this.db.insert('fills', fill.id, fill, fill.timestamp))
        throw new Error('Duplicate fill race');
      this.db.save('orders', order.id, order, order.timestamp);
      this.db.save('positions', p.id, p, p.entryTime);
    });
    this.orders.set(order.id, order);
    this.positions.set(p.symbol, p);
    this.logger.info({
      event: 'order.filled',
      correlationId: order.id,
      symbol: p.symbol,
      quantity: fill.quantity,
      partial: order.state !== 'filled',
    });
    this.logger.info({
      event: 'position.opened',
      correlationId: p.id,
      symbol: p.symbol,
      quantity: p.quantity,
    });
    this.emit('position', p);
    return true;
  }
  protected applyExit(fill: Fill, reason: ExitReason, slippage = 0, exitOrderId?: string): boolean {
    if (this.db.get('fills', fill.id)) return false;
    const original = this.positions.get(fill.symbol);
    if (!original) throw new Error('Exit fill without known position');
    if (fill.quantity > original.quantity + 1e-8)
      throw new Error('Exit fill exceeds known position');
    const exitOrder = exitOrderId ? this.orders.get(exitOrderId) : undefined;
    if (exitOrderId && (!exitOrder || !exitOrder.reduceOnly))
      throw new Error('Unknown reduce-only exit intent');
    const progressed = exitOrder
      ? { ...exitOrder, filledQuantity: exitOrder.filledQuantity + fill.quantity }
      : undefined;
    if (progressed) {
      if (progressed.filledQuantity > progressed.quantity + 1e-8)
        throw new Error('Close fill exceeds reserved quantity');
      progressed.state = nearlyEqual(progressed.filledQuantity, progressed.quantity)
        ? 'filled'
        : ['cancelled', 'rejected'].includes(progressed.state)
          ? progressed.state
          : 'partially_filled';
    }
    const p = structuredClone(original),
      direction = p.side === 'Long' ? 1 : -1;
    p.grossPnL += (fill.price - p.entry) * fill.quantity * direction;
    p.fees += fill.fee;
    p.estimatedSlippage += slippage;
    p.exitValue += fill.price * fill.quantity;
    p.exitQuantity += fill.quantity;
    p.quantity = Math.max(0, p.quantity - fill.quantity);
    const closed = nearlyEqual(p.quantity, 0);
    let trade: Trade | undefined;
    if (closed) {
      p.closed = true;
      trade = {
        strategy: p.signal.strategy ?? 'scalping',
        id: p.id,
        mode: this.mode,
        symbol: p.symbol,
        side: p.side,
        entryTime: p.entryTime,
        exitTime: fill.timestamp,
        entry: (p.entryCost ?? p.entry * p.initialQuantity) / p.initialQuantity,
        exit: p.exitValue / p.exitQuantity,
        quantity: p.initialQuantity,
        stopLoss: p.initialStopLoss,
        takeProfit: p.takeProfit,
        grossPnL: p.grossPnL,
        fees: p.fees,
        estimatedSlippage: p.estimatedSlippage,
        netPnL: p.grossPnL - p.fees,
        signalScore: p.signal.score,
        signalReasons: p.signal.reasons,
        exitReason: reason,
      };
    }
    this.db.transaction(() => {
      this.db.insert('fills', fill.id, fill, fill.timestamp);
      this.db.save('positions', p.id, p, p.entryTime);
      if (progressed) this.db.save('orders', progressed.id, progressed, progressed.timestamp);
      if (trade) this.db.save('trades', trade.id, trade, trade.exitTime);
    });
    if (progressed) this.orders.set(progressed.id, progressed);
    if (closed) this.positions.delete(p.symbol);
    else this.positions.set(p.symbol, p);
    if (trade) {
      this.logger.info({
        event: 'position.closed',
        correlationId: p.id,
        symbol: p.symbol,
        netPnL: trade.netPnL,
        reason,
      });
      this.emit('closed', trade);
    }
    return true;
  }
  protected savePosition(p: Position): void {
    this.db.save('positions', p.id, p, p.entryTime);
    this.positions.set(p.symbol, p);
  }
}
