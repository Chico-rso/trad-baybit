import { strategyTimeframes, type Config } from '../config/env.js';
import type { Journal } from '../database/db.js';
import type { Logger } from '../utils/logger.js';
import type { MarketState } from '../market/MarketState.js';
import type { DailyLossGuard } from '../risk/DailyLossGuard.js';
import type { KillSwitch } from '../risk/KillSwitch.js';
import { RiskManager } from '../risk/RiskManager.js';
import { PositionSizer, reservedMargin } from '../risk/PositionSizer.js';
import { SignalEngine } from '../strategy/SignalEngine.js';
import type { ExecutionEngine } from './ExecutionEngine.js';
import type { Health } from '../monitoring/health.js';
import { tradeStats } from '../monitoring/metrics.js';
import { buildProfitReport } from '../monitoring/profit.js';
import type { TelegramBot } from '../telegram/TelegramBot.js';
import type { Command } from '../telegram/commands.js';
import {
  formatSignal,
  formatStatus,
  formatPositions,
  formatStats,
  formatProfit,
  formatHealth,
  modeText,
  reasonText,
} from '../telegram/messages.js';
import type { Signal, Trade, Candle } from '../exchange/bybit/types.js';
export class TradingEngine {
  paused: boolean;
  private accepting = true;
  private telegram?: TelegramBot;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  readonly signals: SignalEngine;
  private readonly risk: RiskManager;
  private readonly sizer: PositionSizer;
  private lastSignal?: Signal;
  constructor(
    readonly config: Config,
    private readonly market: MarketState,
    private readonly db: Journal,
    private readonly logger: Logger,
    readonly guard: DailyLossGuard,
    readonly kill: KillSwitch,
    readonly execution: ExecutionEngine | undefined,
    readonly getHealth: () => Health,
  ) {
    this.paused = db.state<boolean>(`paused:${config.TRADING_MODE}`) ?? false;
    this.signals = new SignalEngine(config, market);
    this.risk = new RiskManager(config, guard, kill);
    this.sizer = new PositionSizer(config);
  }
  setTelegram(telegram: TelegramBot): void {
    this.telegram = telegram;
  }
  enqueue(task: () => Promise<void>): void {
    if (this.queued >= 2000) {
      this.kill.activate('event processing backlog');
      return;
    }
    this.queued++;
    this.queue = this.queue
      .then(task)
      .catch((err) => {
        this.logger.error({ event: 'engine.operation.failed', error: err });
        this.kill.activate(
          this.db.healthy()
            ? 'critical engine operation failed'
            : 'database unavailable in critical operation',
        );
      })
      .finally(() => {
        this.queued--;
      });
  }
  drain(): Promise<void> {
    return this.queue;
  }
  stopEntries(): void {
    this.accepting = false;
  }
  equity(): number {
    return this.execution?.equity() ?? this.config.PAPER_INITIAL_EQUITY;
  }
  tradingEquity(): number {
    const cap = this.config.TRADING_CAPITAL_USDT;
    if (cap === undefined) return this.equity();
    const realized = this.db
      .list<Trade>('trades', 100000, this.config.TRADING_MODE)
      .reduce((s, t) => s + t.netPnL, 0);
    const open = [...(this.execution?.positions.values() ?? [])].reduce((s, p) => {
      const quote = this.market.books.get(p.symbol)?.quote();
      const mark = quote ? (p.side === 'Long' ? quote.bid : quote.ask) : p.entry;
      return s + p.grossPnL - p.fees + (mark - p.entry) * p.quantity * (p.side === 'Long' ? 1 : -1);
    }, 0);
    return Math.min(this.equity(), cap + realized + open);
  }
  async processCandle(candle: Candle, now = Date.now()): Promise<void> {
    const c = this.config,
      symbol = candle.symbol;
    if (
      !candle.confirmed ||
      candle.interval !== strategyTimeframes(c)[0] ||
      candle.start + candle.interval * 60000 > now
    )
      return;
    if (!this.accepting || this.getHealth().status !== 'HEALTHY') return;
    const key =
      c.STRATEGY === 'scalping'
        ? `candle:${c.TRADING_MODE}:${symbol}`
        : `candle:${c.TRADING_MODE}:${c.STRATEGY}:${symbol}`;
    const previous = this.db.state<number>(key);
    if (previous !== undefined && previous >= candle.start) return;
    const candidates = this.signals.evaluate(symbol, now);
    for (const signal of candidates) {
      this.db.save('signals', signal.id, { ...signal, mode: c.TRADING_MODE }, signal.timestamp);
      this.logger.debug({
        event: signal.decision === 'accepted' ? 'signal.created' : 'signal.rejected',
        correlationId: signal.id,
        symbol,
        side: signal.side,
        score: signal.score,
        reasons: signal.rejections,
      });
    }
    this.db.setState(key, candle.start);
    const accepted = candidates
      .filter((s) => s.decision === 'accepted')
      .sort((a, b) => b.score - a.score)[0];
    if (!accepted) return;
    const risk = this.risk.check(accepted, {
      equity: this.equity(),
      tradingEquity: this.tradingEquity(),
      openSymbols: [...(this.execution?.positions.keys() ?? [])],
      pendingSymbols: this.execution?.pendingSymbols() ?? [],
      healthy: this.getHealth().status === 'HEALTHY',
      marketFresh: this.market.ready(
        symbol,
        now,
        c.MARKET_STALE_MS,
        c.CANDLE_STALE_MS,
        this.signals.strategy.warmup,
        strategyTimeframes(c),
      ),
      paused: this.paused || !this.accepting,
      now,
    });
    if (!risk.allowed) {
      this.db.save(
        'signals',
        accepted.id,
        {
          ...accepted,
          mode: c.TRADING_MODE,
          decision: 'rejected',
          rejections: [...accepted.rejections, ...risk.reasons],
        },
        accepted.timestamp,
      );
      this.logger.info({
        event: 'risk.rejected',
        correlationId: accepted.id,
        symbol,
        reasons: risk.reasons,
      });
      return;
    }
    const last = this.db.state<number>(`signal:${c.TRADING_MODE}:${symbol}`) ?? 0;
    if (now - last < c.SIGNAL_COOLDOWN_SECONDS * 1000) return;
    let plan;
    try {
      const margin = reservedMargin(
        this.execution?.positions.values() ?? [],
        this.execution?.orders.values() ?? [],
        c.LEVERAGE,
      );
      plan = this.sizer.size(
        this.tradingEquity(),
        accepted,
        this.market.instruments.get(symbol)!,
        Math.max(0, this.tradingEquity() - margin),
      );
    } catch (err) {
      this.db.save(
        'signals',
        accepted.id,
        {
          ...accepted,
          mode: c.TRADING_MODE,
          decision: 'rejected',
          rejections: [...accepted.rejections, 'position sizing rejected'],
        },
        accepted.timestamp,
      );
      this.logger.info({ event: 'risk.rejected', correlationId: accepted.id, symbol, error: err });
      return;
    }
    const normalized = {
      ...accepted,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
    };
    this.db.save(
      'signals',
      accepted.id,
      { ...normalized, mode: c.TRADING_MODE },
      accepted.timestamp,
    );
    this.db.setState(`signal:${c.TRADING_MODE}:${symbol}`, now);
    this.lastSignal = normalized;
    this.telegram?.notify(formatSignal(normalized, c.TRADING_MODE, c.RISK_PER_TRADE_PERCENT));
    this.logger.info({
      event: 'signal.created',
      correlationId: accepted.id,
      symbol,
      side: accepted.side,
      score: accepted.score,
      mode: c.TRADING_MODE,
    });
    if (this.execution && this.accepting && !this.paused && !this.kill.active)
      await this.execution.submit(normalized, plan, this.market.books.get(symbol)!.quote()!, now);
  }
  status() {
    return {
      mode: this.config.TRADING_MODE,
      strategy: this.config.STRATEGY,
      network:
        this.config.TRADING_MODE === 'live'
          ? 'mainnet'
          : this.config.TRADING_MODE === 'demo'
            ? 'demo'
            : ['signal', 'paper'].includes(this.config.TRADING_MODE)
              ? this.config.MARKET_DATA_NETWORK
              : 'testnet',
      connection: { public: this.market.publicConnected, private: this.market.privateConnected },
      symbols: this.config.SYMBOLS,
      balance: this.equity(),
      tradingCapitalUSDT: Math.min(
        this.tradingEquity(),
        this.config.TRADING_CAPITAL_USDT ?? this.equity(),
      ),
      dailyPnL: this.guard.state.dailyPnL,
      lossLimitsEnabled: this.guard.lossLimitsEnabled,
      openPositions: this.execution?.positions.size ?? 0,
      pendingSymbols: this.execution?.pendingSymbols() ?? [],
      paused: this.paused,
      killSwitch: { active: this.kill.active, reasons: this.kill.reasons },
      health: this.getHealth(),
      lastSignal: this.lastSignal ?? null,
    };
  }
  profit(now = Date.now()) {
    const date = new Date(now);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const health = this.getHealth();
    const report = buildProfitReport({
      mode: this.config.TRADING_MODE,
      allTime: this.db.profitTotals(this.config.TRADING_MODE),
      today: this.db.profitTotals(this.config.TRADING_MODE, midnight, midnight + 86400000),
      positions: this.execution?.positions.values() ?? [],
      quote: (symbol) =>
        this.market.publicConnected && this.market.synchronized.has(symbol)
          ? this.market.books.get(symbol)?.quote()
          : undefined,
      now,
      marketStaleMs: this.config.MARKET_STALE_MS,
      positionsSynchronized: !health.reasons.some((reason) =>
        ['account state unsynchronized', 'private websocket disconnected'].includes(reason),
      ),
      initialCapital: this.config.TRADING_CAPITAL_USDT,
    });
    return {
      ...report,
      activeStrategy: {
        name: this.config.STRATEGY,
        totals: this.db.profitTotals(
          this.config.TRADING_MODE,
          0,
          Number.MAX_SAFE_INTEGER,
          this.config.STRATEGY,
        ),
      },
    };
  }
  resources() {
    return {
      status: () => this.status(),
      health: () => this.getHealth(),
      signals: () => this.db.list('signals', 200, this.config.TRADING_MODE),
      trades: () => this.db.list('trades', 200, this.config.TRADING_MODE),
      positions: () => [...(this.execution?.positions.values() ?? [])],
      profit: () => this.profit(),
      stats: () =>
        tradeStats(
          this.db.list<Trade>('trades', 100000, this.config.TRADING_MODE),
          this.config.PAPER_INITIAL_EQUITY,
        ),
    };
  }
  async command(cmd: Command): Promise<string> {
    if (cmd === 'pause') {
      this.paused = true;
      this.db.setState(`paused:${this.config.TRADING_MODE}`, true);
      if (this.execution) this.enqueue(() => this.execution!.cancelEntries());
      return 'Новые входы приостановлены. Бот продолжает следить за открытыми позициями.';
    }
    if (cmd === 'resume') {
      if (this.kill.active)
        return `Возобновление невозможно: защитная остановка. ${this.kill.reasons.map(reasonText).join('; ')}`;
      if (this.getHealth().status !== 'HEALTHY')
        return `Возобновление невозможно. ${formatHealth(this.getHealth())}`;
      this.paused = false;
      this.db.setState(`paused:${this.config.TRADING_MODE}`, false);
      return 'Поиск новых входов возобновлён.';
    }
    if (cmd === 'mode')
      return `Режим: ${modeText(this.config.TRADING_MODE)}. Для смены режима нужно изменить настройки и перезапустить бота.`;
    const resources = this.resources();
    if (cmd === 'status') return formatStatus(this.status());
    if (cmd === 'positions') return formatPositions(resources.positions());
    if (cmd === 'stats') return formatStats(resources.stats());
    if (cmd === 'profit') return formatProfit(resources.profit());
    return formatHealth(this.getHealth());
  }
}
