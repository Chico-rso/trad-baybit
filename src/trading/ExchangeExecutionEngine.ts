import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { assertExecutionMode, type Config } from '../config/env.js';
import type { Journal } from '../database/db.js';
import type { Logger } from '../utils/logger.js';
import type { KillSwitch } from '../risk/KillSwitch.js';
import type { SizedPlan } from '../risk/PositionSizer.js';
import type {
  Instrument,
  Signal,
  Quote,
  PublicTrade,
  Order,
  ExchangeOrder,
  ExchangeFill,
  Fill,
  ExitReason,
  OrderState,
  OrderRequest,
} from '../exchange/bybit/types.js';
import { BybitClient } from '../exchange/bybit/BybitClient.js';
import { BybitApiError } from '../exchange/bybit/BybitRestClient.js';
import { PositionLedger } from './PositionLedger.js';
import { moveProtection } from './protection.js';
import type { ExecutionEngine } from './ExecutionEngine.js';
import { normalizePrice, normalizeQuantity, nearlyEqual } from '../utils/math.js';

export function orderState(status: string): OrderState {
  const mapping: Record<string, OrderState> = {
    Created: 'created',
    New: 'new',
    PartiallyFilled: 'partially_filled',
    Filled: 'filled',
    Cancelled: 'cancelled',
    PartiallyFilledCanceled: 'cancelled',
    Rejected: 'rejected',
    Deactivated: 'cancelled',
  };
  return mapping[status] ?? 'unknown';
}
export class ExchangeExecutionEngine extends PositionLedger implements ExecutionEngine {
  synchronized = false;
  private balance = 0;
  private preflight: () => boolean = () => false;
  private readonly quotes = new Map<string, Quote>();
  private readonly exchangeOrders = new Map<string, ExchangeOrder>();
  private readonly cancelling = new Set<string>();
  private readonly protectionAt = new Map<string, number>();
  private reconciling = false;
  constructor(
    protected readonly c: Config,
    db: Journal,
    logger: Logger,
    private readonly instruments: Map<string, Instrument>,
    protected readonly client: BybitClient,
    private readonly kill: KillSwitch,
  ) {
    assertExecutionMode(c);
    assertExecutionMode(client.rest.config);
    if (client.rest.config.TRADING_MODE !== c.TRADING_MODE)
      throw new Error('Execution/adapter network mismatch');
    super(db, logger, c.TRADING_MODE);
  }
  setPreflight(check: () => boolean): void {
    this.preflight = check;
  }
  equity(): number {
    return this.balance;
  }
  async initialize(): Promise<void> {
    await this.client.rest.synchronizeClock();
    await this.client.validateAccount();
    await this.reconcile();
    if (this.kill.active || !this.synchronized) return;
    for (const symbol of this.c.SYMBOLS) {
      const i = this.instruments.get(symbol);
      if (!i) throw new Error('Instrument metadata not ready');
      if (this.c.LEVERAGE > i.maxLeverage) throw new Error('Instrument leverage not supported');
      if (!this.positions.has(symbol)) await this.client.setLeverage(symbol, this.c.LEVERAGE);
    }
  }
  async submit(signal: Signal, plan: SizedPlan, _quote: Quote, now = Date.now()): Promise<void> {
    assertExecutionMode(this.c);
    if (this.kill.active || !this.preflight()) throw new Error('Execution health preflight failed');
    if (this.positions.has(signal.symbol) || this.pendingSymbols().includes(signal.symbol))
      throw new Error('Duplicate entry reservation');
    const instrument = this.instruments.get(signal.symbol);
    if (!instrument) throw new Error('Missing instrument');
    const id = randomUUID();
    const planned = {
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
      state: 'created',
      timestamp: now,
      signal: planned,
    };
    this.recordOrder(order); // durable intent before any external effect
    const request: OrderRequest = {
      category: 'linear',
      symbol: order.symbol,
      side: order.side === 'Long' ? 'Buy' : 'Sell',
      orderType: order.type,
      qty: normalizeQuantity(plan.quantity, instrument.qtyStep),
      orderLinkId: id,
      positionIdx: 0,
      ...(order.type === 'Limit'
        ? {
            price: normalizePrice(plan.entry, instrument.tickSize),
            timeInForce: this.c.POST_ONLY ? 'PostOnly' : 'GTC',
          }
        : {}),
      stopLoss: normalizePrice(plan.stopLoss, instrument.tickSize),
      takeProfit: normalizePrice(plan.takeProfit, instrument.tickSize),
      tpslMode: 'Full',
      slOrderType: 'Market',
      tpOrderType: 'Market',
      slTriggerBy: 'LastPrice',
      tpTriggerBy: 'LastPrice',
    };
    await this.sendOnce(order, request);
  }
  private async sendOnce(order: Order, request: OrderRequest): Promise<void> {
    try {
      const result = await this.client.createOrder(request);
      this.updateOrder(order.id, { exchangeId: result.orderId, state: 'new' });
      this.logger.info({
        event: 'order.created',
        correlationId: order.id,
        symbol: order.symbol,
        mode: this.mode,
      });
    } catch (err) {
      // Explicit validation rejections are final; duplicate IDs and server timeouts are ambiguous.
      if (err instanceof BybitApiError && ![10000, 10014, 10016, 110072].includes(err.code)) {
        this.updateOrder(order.id, { state: 'rejected' });
        this.releaseCloseReservation(order.id);
        this.logger.warn({ event: 'order.rejected', correlationId: order.id, code: err.code });
        throw err;
      }
      try {
        const remote = await this.client.findOrder(order.symbol, order.id);
        if (remote) {
          this.handleOrders([remote]);
          return;
        }
      } catch {
        /* preserve intent when the lookup also fails */
      }
      this.updateOrder(order.id, { state: 'unknown' });
      this.synchronized = false;
      this.kill.activate('ambiguous order submission');
      throw new Error('Order result is ambiguous; no duplicate POST sent');
    }
  }
  handleOrders(orders: ExchangeOrder[]): void {
    for (const remote of orders) {
      this.exchangeOrders.set(remote.orderId, remote);
      const local =
        this.orders.get(remote.orderLinkId) ??
        [...this.orders.values()].find((o) => o.exchangeId === remote.orderId);
      if (!local) {
        if (
          !this.knownProtection(remote) &&
          ['New', 'PartiallyFilled', 'Created'].includes(remote.orderStatus)
        ) {
          this.synchronized = false;
          this.kill.activate('unknown active exchange order');
        }
        continue;
      }
      const expected = Number(remote.cumExecQty);
      if (!Number.isFinite(expected) || expected < 0 || expected > local.quantity + 1e-8) {
        this.kill.activate('invalid exchange order quantity');
        continue;
      }
      const state = orderState(remote.orderStatus);
      if (local.state === 'filled' && state !== 'filled') continue;
      this.updateOrder(local.id, {
        state,
        exchangeId: remote.orderId,
        expectedFilledQuantity: Math.max(local.expectedFilledQuantity ?? 0, expected),
      });
      this.releaseCloseReservation(local.id);
      this.logger.debug({
        event: 'order.updated',
        correlationId: local.id,
        state,
        filled: expected,
      });
    }
  }
  private knownProtection(order: ExchangeOrder): boolean {
    return (
      order.reduceOnly &&
      !!this.positions.get(order.symbol) &&
      !!order.stopOrderType &&
      ['TakeProfit', 'StopLoss', 'TrailingStop', 'PartialTakeProfit', 'PartialStopLoss'].includes(
        order.stopOrderType,
      )
    );
  }
  handleExecutions(executions: ExchangeFill[]): void {
    for (const e of [...executions].sort((a, b) => Number(a.execTime) - Number(b.execTime))) {
      if (e.execType !== 'Trade' || this.db.get('fills', e.execId)) continue;
      const local =
        this.orders.get(e.orderLinkId) ??
        [...this.orders.values()].find((o) => o.exchangeId === e.orderId);
      const p = this.positions.get(e.symbol);
      const quantity = Number(e.execQty),
        price = Number(e.execPrice),
        fee = Number(e.execFee),
        timestamp = Number(e.execTime);
      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isFinite(fee) ||
        !Number.isFinite(timestamp)
      ) {
        this.kill.activate('invalid execution payload');
        continue;
      }
      const fill: Fill = {
        id: e.execId,
        orderId: e.orderId,
        symbol: e.symbol,
        mode: this.mode,
        side: e.side,
        quantity,
        price,
        fee,
        timestamp,
      };
      try {
        if (local && !local.reduceOnly && Number(e.closedSize) === 0) {
          if (this.db.get('trades', local.id))
            this.kill.activate('late entry fill after completed position');
          this.applyEntry(local.id, fill);
        } else if (
          p &&
          e.side === (p.side === 'Long' ? 'Sell' : 'Buy') &&
          Number(e.closedSize) > 0
        ) {
          const remote = this.exchangeOrders.get(e.orderId),
            stopType = e.stopOrderType ?? remote?.stopOrderType;
          const reason: ExitReason = local?.signal
            ? (p.exitReason ?? 'manual')
            : stopType?.includes('TakeProfit')
              ? 'take_profit'
              : stopType?.includes('StopLoss') || stopType === 'TrailingStop'
                ? 'stop_loss'
                : this.inferExit(e.symbol, price);
          if (this.pendingSymbols().includes(e.symbol))
            this.kill.activate('position exited while entry order is active');
          this.applyExit(fill, reason, 0, local?.reduceOnly ? local.id : undefined);
          if (local?.reduceOnly) this.releaseCloseReservation(local.id);
        } else if (local || (Number(e.closedSize) === 0 && this.c.SYMBOLS.includes(e.symbol))) {
          this.synchronized = false;
          this.kill.activate('unowned execution or exposure');
        }
      } catch (err) {
        this.synchronized = false;
        this.kill.activate('execution accounting mismatch');
        throw err;
      }
    }
  }
  private inferExit(symbol: string, price: number): ExitReason {
    const p = this.positions.get(symbol);
    if (!p) return 'manual';
    if (p.side === 'Long' ? price <= p.stopLoss : price >= p.stopLoss) return 'stop_loss';
    if (p.side === 'Long' ? price >= p.takeProfit : price <= p.takeProfit) return 'take_profit';
    return p.exitReason ?? 'manual';
  }
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    this.synchronized = false;
    try {
      const earliest = Math.min(
        Date.now(),
        ...[...this.positions.values()].map((p) => p.entryTime),
        ...[...this.orders.values()]
          .filter((o) => this.pendingSymbols().includes(o.symbol))
          .map((o) => o.timestamp),
      );
      if (Date.now() - earliest > 6 * 86400000)
        this.kill.activate('reconciliation history exceeds six days; manual audit required');
      const executions = await this.client.executions(
        Math.max(earliest - 60000, Date.now() - 6 * 86400000),
      );
      this.handleExecutions(executions);
      const orders = await this.client.orders();
      this.handleOrders(orders);
      // Recover a crash between a terminal close-order write and clearing its reservation.
      for (const order of this.orders.values()) this.releaseCloseReservation(order.id);
      for (const local of [...this.orders.values()]) {
        if (
          !['created', 'new', 'partially_filled', 'unknown'].includes(local.state) ||
          orders.some((o) => o.orderLinkId === local.id)
        )
          continue;
        const remote = await this.client.findOrder(local.symbol, local.id);
        if (remote) this.handleOrders([remote]);
        else this.kill.activate('unresolved durable order intent');
      }
      const positions = await this.client.positions();
      this.balance = await this.client.equity();
      let mismatch = false;
      for (const remote of positions) {
        if (this.c.SYMBOLS.includes(remote.symbol) && remote.positionIdx !== 0) {
          mismatch = true;
          this.kill.activate('hedge mode unsupported; require one-way positions');
        }
        const size = Number(remote.size);
        if (size === 0) continue;
        if (!Number.isFinite(size) || size < 0) {
          mismatch = true;
          this.kill.activate('unknown position quantity');
          continue;
        }
        const local = this.positions.get(remote.symbol);
        if (!local) {
          mismatch = true;
          this.kill.activate('unknown open exchange position');
          continue;
        }
        if (
          !nearlyEqual(size, local.quantity) ||
          remote.side !== (local.side === 'Long' ? 'Buy' : 'Sell') ||
          !nearlyEqual(Number(remote.avgPrice), local.entry, 1e-5)
        ) {
          mismatch = true;
          this.kill.activate('local/exchange position mismatch');
        }
        const protectedStop = Number(remote.stopLoss),
          protectedTarget = Number(remote.takeProfit);
        if (!(protectedStop > 0 && protectedTarget > 0)) {
          mismatch = true;
          this.kill.activate('exchange position has missing protection');
        } else if (
          !nearlyEqual(protectedStop, local.stopLoss) ||
          !nearlyEqual(protectedTarget, local.takeProfit)
        ) {
          mismatch = true;
          this.kill.activate('exchange protection differs from local state');
        }
        if (Number(remote.leverage) > this.c.MAX_LEVERAGE) {
          mismatch = true;
          this.kill.activate('exchange leverage exceeds configured limit');
        }
      }
      for (const local of this.positions.values())
        if (!positions.some((p) => p.symbol === local.symbol && Number(p.size) > 0)) {
          mismatch = true;
          this.kill.activate('local position missing on exchange');
        }
      for (const order of this.orders.values())
        if ((order.expectedFilledQuantity ?? 0) > order.filledQuantity + 1e-8) {
          mismatch = true;
          this.kill.activate('order fills not fully reconciled');
        }
      if (
        orders.some(
          (o) =>
            !this.orders.has(o.orderLinkId) &&
            ![...this.orders.values()].some((local) => local.exchangeId === o.orderId) &&
            !this.knownProtection(o),
        )
      )
        mismatch = true;
      this.synchronized = !mismatch;
      this.db.setState(`reconcile:${this.mode}`, {
        timestamp: Date.now(),
        equity: this.balance,
        synchronized: this.synchronized,
      });
      this.logger.info({
        event: 'account.reconciled',
        synchronized: this.synchronized,
        equity: this.balance,
        positions: this.positions.size,
      });
    } catch (err) {
      this.kill.activate('cannot determine account position');
      throw err;
    } finally {
      this.reconciling = false;
    }
  }
  async onQuote(symbol: string, quote: Quote, now = Date.now()): Promise<void> {
    this.quotes.set(symbol, quote);
    for (const o of this.orders.values())
      if (
        o.symbol === symbol &&
        !o.reduceOnly &&
        ['new', 'partially_filled'].includes(o.state) &&
        now - o.timestamp >= this.c.ORDER_TIMEOUT_SECONDS * 1000 &&
        !this.cancelling.has(o.id)
      )
        await this.cancelOne(o);
    const p = this.positions.get(symbol);
    if (!p || now - (this.protectionAt.get(symbol) ?? 0) < 1000 || !this.synchronized) return;
    const moved = moveProtection(p, quote, this.c, this.instruments.get(symbol)!);
    if (moved.stopLoss !== p.stopLoss) {
      this.protectionAt.set(symbol, now);
      try {
        await this.client.setProtection(
          symbol,
          normalizePrice(moved.stopLoss, this.instruments.get(symbol)!.tickSize),
          normalizePrice(moved.takeProfit, this.instruments.get(symbol)!.tickSize),
        );
        this.savePosition(moved);
      } catch (err) {
        this.kill.activate('failed to update exchange protection');
        throw err;
      }
    }
  }
  async onTrade(_trade: PublicTrade): Promise<void> {
    /* Exchange execution stream is authoritative for fills. */
  }
  private releaseCloseReservation(id: string): void {
    const order = this.orders.get(id);
    if (
      !order?.reduceOnly ||
      !['cancelled', 'rejected', 'filled'].includes(order.state) ||
      (order.expectedFilledQuantity ?? 0) > order.filledQuantity + 1e-8
    )
      return;
    const p = this.positions.get(order.symbol);
    if (
      p?.closing &&
      p.signal.id === order.signal.id &&
      ![...this.orders.values()].some(
        (o) =>
          o.reduceOnly &&
          o.symbol === p.symbol &&
          o.signal.id === p.signal.id &&
          (['created', 'new', 'partially_filled', 'unknown'].includes(o.state) ||
            (o.expectedFilledQuantity ?? 0) > o.filledQuantity + 1e-8),
      )
    )
      this.savePosition({ ...p, closing: false, exitReason: undefined });
  }
  private async cancelOne(order: Order): Promise<void> {
    if (!this.cancelling.has(order.id)) {
      this.cancelling.add(order.id);
      try {
        await this.client.cancelOrder(order.symbol, order.id);
      } catch {
        /* Even an ACK timeout is reconciled; the cancellation POST is never repeated. */
      }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await this.client.findOrder(order.symbol, order.id);
      if (remote) {
        this.handleOrders([remote]);
        if (
          ['Filled', 'Cancelled', 'PartiallyFilledCanceled', 'Rejected', 'Deactivated'].includes(
            remote.orderStatus,
          )
        )
          return;
      }
      if (attempt < 3) await delay(250);
    }
    this.kill.activate('ambiguous order cancellation');
    throw new Error('Order cancellation unconfirmed');
  }
  async cancelEntries(): Promise<void> {
    for (const o of [...this.orders.values()])
      if (!o.reduceOnly && ['created', 'new', 'partially_filled', 'unknown'].includes(o.state))
        await this.cancelOne(o);
  }
  async closeAll(reason: ExitReason): Promise<void> {
    await this.cancelEntries();
    await this.reconcile(); // authoritative fills after terminal cancellation, before close sizing
    for (const symbol of [...this.positions.keys()]) {
      const p = this.positions.get(symbol);
      if (!p || p.closing) continue;
      const i = this.instruments.get(p.symbol);
      if (!i) throw new Error('Cannot close without instrument metadata');
      const id = randomUUID();
      const closing = { ...p, closing: true, exitReason: reason };
      const order: Order = {
        id,
        mode: this.mode,
        symbol: p.symbol,
        side: p.side === 'Long' ? 'Short' : 'Long',
        quantity: p.quantity,
        filledQuantity: 0,
        entry: p.entry,
        type: 'Market',
        state: 'created',
        timestamp: Date.now(),
        signal: p.signal,
        reduceOnly: true,
      };
      this.db.transaction(() => {
        this.db.save('positions', closing.id, closing, closing.entryTime);
        this.db.save('orders', order.id, order, order.timestamp);
      });
      this.positions.set(p.symbol, closing);
      this.orders.set(order.id, order);
      await this.sendOnce(order, {
        category: 'linear',
        symbol: p.symbol,
        side: p.side === 'Long' ? 'Sell' : 'Buy',
        orderType: 'Market',
        qty: normalizeQuantity(p.quantity, i.qtyStep),
        orderLinkId: id,
        positionIdx: 0,
        reduceOnly: true,
      });
    }
  }
}
