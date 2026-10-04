import { z } from 'zod';
import { strategyTimeframes, type Config } from '../config/env.js';
import type { Candle, Instrument, Quote, Signal, Trade } from '../exchange/bybit/types.js';
import { Journal } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { PaperExecutionEngine } from '../trading/PaperExecutionEngine.js';
import { createStrategy } from '../strategy/createStrategy.js';
import { PositionSizer, reservedMargin } from '../risk/PositionSizer.js';
import { RiskManager } from '../risk/RiskManager.js';
import { DailyLossGuard } from '../risk/DailyLossGuard.js';
import { KillSwitch } from '../risk/KillSwitch.js';
import { CandleStore } from '../market/CandleStore.js';
import { tradeStats } from '../monitoring/metrics.js';
const positive = z.number().finite().positive();
const candleSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+USDT$/),
  interval: z.literal(1),
  start: z.number().int().nonnegative(),
  open: positive,
  high: positive,
  low: positive,
  close: positive,
  volume: z.number().finite().nonnegative(),
  turnover: z.number().finite().nonnegative(),
  confirmed: z.literal(true),
});
export function validateHistory(input: unknown): Candle[] {
  const bars = z.array(candleSchema).min(1).parse(input);
  const last = new Map<string, number>();
  let lastEvent = -1;
  for (const bar of bars) {
    if (
      bar.start % 60000 !== 0 ||
      bar.start < lastEvent ||
      bar.start <= (last.get(bar.symbol) ?? -1)
    )
      throw new Error('History must be ordered and unique per symbol');
    if (
      bar.high < Math.max(bar.open, bar.close) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.high < bar.low
    )
      throw new Error('Inconsistent OHLC');
    last.set(bar.symbol, bar.start);
    lastEvent = bar.start;
  }
  return bars;
}
export function aggregateCandles(bars: Candle[], interval: Candle['interval']): Candle[] {
  const duration = interval * 60000;
  const groups = new Map<string, Candle[]>();
  for (const b of bars) {
    const start = Math.floor(b.start / duration) * duration,
      key = `${b.symbol}:${start}`;
    const group = groups.get(key) ?? [];
    group.push(b);
    groups.set(key, group);
  }
  const result: Candle[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
    const first = group[0]!;
    if (
      group.length !== interval ||
      first.start % duration !== 0 ||
      !group.every((b, i) => b.interval === 1 && b.confirmed && b.start === first.start + i * 60000)
    )
      continue;
    result.push({
      symbol: first.symbol,
      interval,
      start: first.start,
      open: first.open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((s, b) => s + b.volume, 0),
      turnover: group.reduce((s, b) => s + b.turnover, 0),
      confirmed: true,
    });
  }
  return result.sort((a, b) => a.start - b.start);
}
export function aggregateFiveMinute(bars: Candle[]): Candle[] {
  return aggregateCandles(bars, 5);
}
export async function runBacktest(
  input: Candle[],
  c: Config,
  instruments: Map<string, Instrument>,
  tradeFrom = 0,
) {
  const bars = validateHistory(input),
    db = new Journal(':memory:'),
    logger = createLogger('silent');
  const paper = new PaperExecutionEngine(
    { ...c, TRADING_MODE: 'paper' },
    db,
    logger,
    instruments,
    'backtest',
  );
  const guard = new DailyLossGuard(c, db, 'backtest'),
    kill = new KillSwitch(db, logger, 'backtest'),
    risk = new RiskManager(c, guard, kill),
    sizer = new PositionSizer(c),
    strategy = createStrategy(c);
  const [entryInterval, trendInterval] = strategyTimeframes(c);
  const store = new CandleStore();
  const queued = new Map<string, Signal>();
  const curve: { timestamp: number; equity: number }[] = [];
  const entries = entryInterval === 1 ? [] : aggregateCandles(bars, entryInterval);
  const trends = aggregateCandles(bars, trendInterval);
  let entryIndex = 0,
    trendIndex = 0;
  let signals = 0;
  paper.on('closed', (trade: Trade) => guard.record(trade.netPnL, trade.exitTime));
  const quote = (price: number, time: number): Quote => ({
    bid: price * (1 - c.BACKTEST_SPREAD_BPS / 20000),
    ask: price * (1 + c.BACKTEST_SPREAD_BPS / 20000),
    timestamp: time,
    imbalance: 1,
  });
  const context = (symbol: string, now: number) => ({
    equity: paper.equity(),
    openSymbols: [...paper.positions.keys()],
    pendingSymbols: paper.pendingSymbols(),
    healthy: true,
    marketFresh:
      store.contiguous(symbol, entryInterval, strategy.warmup) &&
      store.contiguous(symbol, trendInterval, strategy.warmup),
    paused: false,
    now,
  });
  try {
    const lastSignal = new Map<string, number>();
    for (let offset = 0; offset < bars.length;) {
      const start = bars[offset]!.start,
        end = start + 60000,
        group: Candle[] = [];
      while (offset < bars.length && bars[offset]!.start === start) group.push(bars[offset++]!);
      guard.initialize(paper.equity(), start);
      // Portfolio barriers: every symbol sees the open before any 30s/45s/60s outcome.
      for (const bar of group) await paper.onQuote(bar.symbol, quote(bar.open, start), start);
      for (const bar of group) {
        const planned = queued.get(bar.symbol);
        queued.delete(bar.symbol);
        if (
          planned &&
          start >= tradeFrom &&
          start - planned.timestamp <= c.MARKET_STALE_MS &&
          risk.check(planned, context(bar.symbol, start)).allowed
        ) {
          try {
            const q = quote(bar.open, start + 1);
            const candidate =
              c.ENTRY_ORDER_TYPE === 'Market'
                ? { ...planned, entry: planned.side === 'Long' ? q.ask : q.bid }
                : planned;
            const margin = reservedMargin(
              paper.positions.values(),
              paper.orders.values(),
              c.LEVERAGE,
            );
            const size = sizer.size(
              paper.equity(),
              candidate,
              instruments.get(bar.symbol)!,
              paper.equity() - margin,
            );
            await paper.submit(candidate, size, q, start + 1);
          } catch {
            /* Historical gaps can invalidate RR, margin or minimum quantity. */
          }
        }
      }
      if (c.ENTRY_ORDER_TYPE === 'Limit')
        for (const bar of group) {
          const order = [...paper.orders.values()].find(
            (o) => o.symbol === bar.symbol && ['new', 'partially_filled'].includes(o.state),
          );
          if (order)
            await paper.onTrade({
              id: `open:${start}:${bar.symbol}`,
              symbol: bar.symbol,
              side: order.side === 'Long' ? 'Sell' : 'Buy',
              price: bar.open,
              quantity: order.quantity,
              timestamp: start + 2,
            });
        }
      if (c.ORDER_TIMEOUT_SECONDS < 60)
        for (const bar of group)
          await paper.onQuote(
            bar.symbol,
            quote(bar.open, start + c.ORDER_TIMEOUT_SECONDS * 1000 + 2),
            start + c.ORDER_TIMEOUT_SECONDS * 1000 + 2,
          );
      if (c.ENTRY_ORDER_TYPE === 'Limit' && c.ORDER_TIMEOUT_SECONDS >= 60)
        for (const bar of group) {
          const order = [...paper.orders.values()].find(
            (o) => o.symbol === bar.symbol && ['new', 'partially_filled'].includes(o.state),
          );
          if (order)
            await paper.onTrade({
              id: `range:${start}:${bar.symbol}`,
              symbol: bar.symbol,
              side: order.side === 'Long' ? 'Sell' : 'Buy',
              price: order.side === 'Long' ? bar.low : bar.high,
              quantity: order.quantity,
              timestamp: start + 30000,
            });
        }
      // Adverse extremes precede favorable extremes across the complete portfolio.
      for (const bar of group) {
        const p = paper.positions.get(bar.symbol);
        if (p)
          await paper.onQuote(
            bar.symbol,
            quote(p.side === 'Long' ? bar.low : bar.high, start + 30000),
            start + 30000,
          );
      }
      for (const bar of group) {
        const p = paper.positions.get(bar.symbol);
        if (p)
          await paper.onQuote(
            bar.symbol,
            quote(p.side === 'Long' ? bar.high : bar.low, start + 45000),
            start + 45000,
          );
      }
      for (const bar of group) await paper.onQuote(bar.symbol, quote(bar.close, end), end);
      for (const bar of group) store.upsert(bar);
      while (
        entryIndex < entries.length &&
        entries[entryIndex]!.start + entryInterval * 60000 <= end
      )
        store.upsert(entries[entryIndex++]!);
      while (trendIndex < trends.length && trends[trendIndex]!.start + trendInterval * 60000 <= end)
        store.upsert(trends[trendIndex++]!);
      for (const bar of group)
        if (
          end >= tradeFrom &&
          store.get(bar.symbol, entryInterval).at(-1)?.start === end - entryInterval * 60000 &&
          store.contiguous(bar.symbol, entryInterval, strategy.warmup) &&
          store.contiguous(bar.symbol, trendInterval, strategy.warmup)
        ) {
          const candidates = strategy.evaluate(
            bar.symbol,
            store.get(bar.symbol, entryInterval),
            store.get(bar.symbol, trendInterval),
            quote(bar.close, end),
            end,
          );
          const accepted = candidates
            .filter((signal) => signal.decision === 'accepted')
            .sort((a, b) => b.score - a.score)[0];
          if (accepted) {
            signals++;
            if (
              end - (lastSignal.get(bar.symbol) ?? -Infinity) >= c.SIGNAL_COOLDOWN_SECONDS * 1000 &&
              risk.check(accepted, context(bar.symbol, end)).allowed
            ) {
              queued.set(bar.symbol, accepted);
              lastSignal.set(bar.symbol, end);
            }
          }
        }
      if (end >= tradeFrom) curve.push({ timestamp: end, equity: paper.equity() });
    }
    await paper.cancelEntries();
    await paper.closeAll('strategy_exit');
    const trades = db.list<Trade>('trades', 100000, 'backtest').reverse(),
      stats = tradeStats(trades, c.PAPER_INITIAL_EQUITY);
    let peak = c.PAPER_INITIAL_EQUITY;
    for (const point of curve) {
      peak = Math.max(peak, point.equity);
      stats.maxDrawdown = Math.max(stats.maxDrawdown, peak - point.equity);
      stats.maxDrawdownPercent = Math.max(
        stats.maxDrawdownPercent,
        ((peak - point.equity) / peak) * 100,
      );
    }
    return {
      stats,
      trades,
      equityCurve: curve,
      signals,
      assumptions: {
        orderbook: 'unavailable; neutral imbalance, no book confirmation points',
        intrabar: 'adverse extreme first; no sub-minute limit fill assumption',
        fees: 'entry maker only for post-only limit; exits taker',
        funding: 'not modeled; use short sessions and actual funding data for research',
      },
    };
  } finally {
    db.close();
  }
}
