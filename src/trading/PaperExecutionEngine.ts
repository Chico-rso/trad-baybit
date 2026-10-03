import { randomUUID } from 'node:crypto';
import type { Config } from '../config/env.js';
import type { Journal } from '../database/db.js';
import type { Logger } from '../utils/logger.js';
import type {
  Signal,
  Quote,
  PublicTrade,
  Instrument,
  Order,
  Trade,
  Fill,
  ExitReason,
} from '../exchange/bybit/types.js';
import type { SizedPlan } from '../risk/PositionSizer.js';
import type { ExecutionEngine } from './ExecutionEngine.js';
import { PositionLedger } from './PositionLedger.js';
import { moveProtection } from './protection.js';
import { normalizePrice, normalizeQuantity } from '../utils/math.js';
export class PaperExecutionEngine extends PositionLedger implements ExecutionEngine {
  private readonly quotes = new Map<string, Quote>();
  private readonly initialEquity: number;
  constructor(
    private readonly c: Config,
    db: Journal,
    logger: Logger,
    private readonly instruments: Map<string, Instrument>,
    mode = 'paper',
  ) {
    super(db, logger, mode);
    this.initialEquity = db.state<number>(`initialEquity:${mode}`) ?? c.PAPER_INITIAL_EQUITY;
    db.setState(`initialEquity:${mode}`, this.initialEquity);
  }
  equity(): number {
    const realized = this.db
      .list<Trade>('trades', 100000, this.mode)
      .reduce((s, t) => s + t.netPnL, 0);
    const open = [...this.positions.values()].reduce((s, p) => {
      const q = this.quotes.get(p.symbol);
      const price = q ? (p.side === 'Long' ? q.bid : q.ask) : p.entry;
      return (
        s + p.grossPnL - p.fees + (price - p.entry) * p.quantity * (p.side === 'Long' ? 1 : -1)
      );
    }, 0);
    return this.initialEquity + realized + open;
  }
  async submit(signal: Signal, plan: SizedPlan, quote: Quote, now = Date.now()): Promise<void> {
    if (this.positions.has(signal.symbol) || this.pendingSymbols().includes(signal.symbol))
      throw new Error('Duplicate entry reservation');
    const id = randomUUID(),
      normalized = {
        ...signal,
        entry: plan.entry,
        stopLoss: plan.stopLoss,
        takeProfit: plan.takeProfit,
      };
    const order: Order = {
      id,
      mode: this.mode,
      symbol: signal.symbol,
      side: signal.side,
      quantity: plan.quantity,
      filledQuantity: 0,
      entry: plan.entry,
      type: this.c.ENTRY_ORDER_TYPE,
      state: 'new',
      timestamp: now,
      signal: normalized,
    };
    this.recordOrder(order);
    this.quotes.set(signal.symbol, quote);
    this.logger.info({
      event: 'order.created',
      correlationId: id,
      symbol: order.symbol,
      mode: this.mode,
    });
    if (order.type === 'Market') this.marketFill(order, quote, now);
  }
  private marketFill(order: Order, quote: Quote, now: number): void {
    const long = order.side === 'Long',
      base = long ? quote.ask : quote.bid;
    const instrument = this.instruments.get(order.symbol);
    if (!instrument) throw new Error('Missing instrument');
    const price = Number(
      normalizePrice(
        base * (1 + ((long ? 1 : -1) * this.c.SLIPPAGE_BPS) / 10000),
        instrument.tickSize,
        long ? 'up' : 'down',
      ),
    );
    const fill: Fill = {
      id: randomUUID(),
      orderId: order.id,
      mode: this.mode,
      symbol: order.symbol,
      side: long ? 'Buy' : 'Sell',
      price,
      quantity: order.quantity,
      fee: (price * order.quantity * this.c.TAKER_FEE_BPS) / 10000,
      timestamp: now,
    };
    this.applyEntry(order.id, fill, Math.abs(price - base) * fill.quantity);
  }
  async onTrade(trade: PublicTrade): Promise<void> {
    for (const order of [...this.orders.values()]) {
      if (
        order.symbol !== trade.symbol ||
        order.type !== 'Limit' ||
        !['new', 'partially_filled'].includes(order.state) ||
        trade.timestamp <= order.timestamp
      )
        continue;
      if (trade.timestamp - order.timestamp >= this.c.ORDER_TIMEOUT_SECONDS * 1000) {
        this.updateOrder(order.id, { state: 'cancelled' });
        continue;
      }
      const long = order.side === 'Long';
      if (
        !(long
          ? trade.side === 'Sell' && trade.price < order.entry
          : trade.side === 'Buy' && trade.price > order.entry)
      )
        continue;
      const instrument = this.instruments.get(order.symbol)!;
      const quantity = Number(
        normalizeQuantity(
          Math.min(trade.quantity, order.quantity - order.filledQuantity),
          instrument.qtyStep,
        ),
      );
      if (quantity <= 0) continue;
      const fill: Fill = {
        id: `paper:${order.id}:${trade.id}`,
        orderId: order.id,
        mode: this.mode,
        symbol: order.symbol,
        side: long ? 'Buy' : 'Sell',
        price: order.entry,
        quantity,
        fee:
          (order.entry *
            quantity *
            (this.c.POST_ONLY ? this.c.MAKER_FEE_BPS : this.c.TAKER_FEE_BPS)) /
          10000,
        timestamp: trade.timestamp,
      };
      this.applyEntry(order.id, fill);
    }
  }
  async onQuote(symbol: string, quote: Quote, now = Date.now()): Promise<void> {
    this.quotes.set(symbol, quote);
    for (const order of [...this.orders.values()])
      if (
        order.symbol === symbol &&
        ['new', 'partially_filled'].includes(order.state) &&
        now - order.timestamp >= this.c.ORDER_TIMEOUT_SECONDS * 1000
      )
        this.updateOrder(order.id, { state: 'cancelled' });
    const position = this.positions.get(symbol);
    if (!position) return;
    const long = position.side === 'Long',
      price = long ? quote.bid : quote.ask;
    const stopped = long ? price <= position.stopLoss : price >= position.stopLoss;
    const target = long ? price >= position.takeProfit : price <= position.takeProfit;
    if (stopped || target) {
      await this.closePosition(symbol, quote, stopped ? 'stop_loss' : 'take_profit', now);
      return;
    }
    const moved = moveProtection(position, quote, this.c, this.instruments.get(symbol)!);
    if (
      moved.stopLoss !== position.stopLoss ||
      moved.breakeven !== position.breakeven ||
      moved.trailingAnchor !== position.trailingAnchor
    )
      this.savePosition(moved);
  }
  private async closePosition(
    symbol: string,
    quote: Quote,
    reason: ExitReason,
    now: number,
  ): Promise<void> {
    const p = this.positions.get(symbol);
    if (!p) return;
    for (const order of [...this.orders.values()])
      if (order.symbol === symbol && ['new', 'partially_filled'].includes(order.state))
        this.updateOrder(order.id, { state: 'cancelled' });
    const long = p.side === 'Long',
      base = long ? quote.bid : quote.ask;
    const price = Number(
      normalizePrice(
        base * (1 + ((long ? -1 : 1) * this.c.SLIPPAGE_BPS) / 10000),
        this.instruments.get(symbol)!.tickSize,
        long ? 'down' : 'up',
      ),
    );
    this.applyExit(
      {
        id: randomUUID(),
        orderId: p.id,
        symbol,
        mode: this.mode,
        side: long ? 'Sell' : 'Buy',
        price,
        quantity: p.quantity,
        fee: (price * p.quantity * this.c.TAKER_FEE_BPS) / 10000,
        timestamp: now,
      },
      reason,
      Math.abs(price - base) * p.quantity,
    );
  }
  async cancelEntries(): Promise<void> {
    for (const o of [...this.orders.values()])
      if (['new', 'partially_filled', 'created'].includes(o.state))
        this.updateOrder(o.id, { state: 'cancelled' });
  }
  async closeAll(reason: ExitReason): Promise<void> {
    for (const p of [...this.positions.values()]) {
      const quote = this.quotes.get(p.symbol);
      if (!quote) throw new Error('No quote for position close');
      await this.closePosition(p.symbol, quote, reason, quote.timestamp);
    }
  }
}
