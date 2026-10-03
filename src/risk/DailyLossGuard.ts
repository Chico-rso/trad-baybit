import type { Config } from '../config/env.js';
import type { Journal } from '../database/db.js';
interface GuardState {
  day: string;
  baseline: number;
  accountBaseline?: number;
  dailyPnL: number;
  consecutiveLosses: number;
  cooldownUntil: number;
}
export class DailyLossGuard {
  private value: GuardState;
  constructor(
    private readonly c: Config,
    private readonly db: Journal,
    private readonly mode: string,
  ) {
    this.value = db.state<GuardState>(`risk:${mode}`) ?? {
      day: '',
      baseline: 0,
      dailyPnL: 0,
      consecutiveLosses: 0,
      cooldownUntil: 0,
    };
  }
  private persist(): void {
    this.db.setState(`risk:${this.mode}`, this.value);
  }
  private recoverAccountBaseline(equity: number): void {
    if (this.value.accountBaseline !== undefined) return;
    const cap = this.c.TRADING_CAPITAL_USDT;
    if (cap !== undefined && this.value.baseline <= cap && equity > cap)
      throw new Error('Cannot restore uncapped daily equity baseline; manual audit required');
    this.value.accountBaseline = this.value.baseline;
  }
  initialize(equity: number, now = Date.now(), tradingEquity?: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.value.day !== day) {
      this.value = {
        ...this.value,
        day,
        baseline: Math.min(tradingEquity ?? equity, this.c.TRADING_CAPITAL_USDT ?? equity),
        accountBaseline: equity,
        dailyPnL: 0,
      };
      this.persist();
    }
    if (this.value.accountBaseline === undefined) {
      this.recoverAccountBaseline(equity);
      this.persist();
    }
    if (
      this.c.TRADING_CAPITAL_USDT !== undefined &&
      this.value.baseline > this.c.TRADING_CAPITAL_USDT
    ) {
      this.value.baseline = this.c.TRADING_CAPITAL_USDT;
      this.persist();
    }
  }
  synchronize(
    trades: { netPnL: number; exitTime: number }[],
    equity: number,
    now = Date.now(),
    tradingEquity?: number,
  ): void {
    const ordered = [...trades]
      .filter((t) => t.exitTime <= now)
      .sort((a, b) => a.exitTime - b.exitTime);
    const day = new Date(now).toISOString().slice(0, 10);
    const daily = ordered
      .filter((t) => new Date(t.exitTime).toISOString().slice(0, 10) === day)
      .reduce((s, t) => s + t.netPnL, 0);
    if (this.value.day !== day)
      this.value = {
        ...this.value,
        day,
        baseline: (tradingEquity ?? equity) - daily,
        accountBaseline: equity - daily,
      };
    this.recoverAccountBaseline(equity);
    if (this.c.TRADING_CAPITAL_USDT !== undefined)
      this.value.baseline = Math.min(this.value.baseline, this.c.TRADING_CAPITAL_USDT);
    let consecutive = 0,
      lastLoss = 0;
    for (const t of ordered) {
      if (t.netPnL < 0) {
        consecutive++;
        lastLoss = t.exitTime;
      } else if (t.netPnL > 0) consecutive = 0;
    }
    this.value = {
      ...this.value,
      dailyPnL: daily,
      consecutiveLosses: consecutive,
      cooldownUntil: lastLoss + this.c.COOLDOWN_AFTER_LOSS_MINUTES * 60000,
    };
    this.persist();
  }
  record(pnl: number, now = Date.now()): void {
    if (!Number.isFinite(pnl)) throw new Error('Invalid PnL');
    this.value.dailyPnL += pnl;
    if (pnl < 0) {
      this.value.consecutiveLosses++;
      this.value.cooldownUntil = now + this.c.COOLDOWN_AFTER_LOSS_MINUTES * 60000;
    } else if (pnl > 0) this.value.consecutiveLosses = 0;
    this.persist();
  }
  blocked(equity: number, now = Date.now(), tradingEquity?: number): boolean {
    if (
      !Number.isFinite(equity) ||
      equity <= 0 ||
      (tradingEquity !== undefined && (!Number.isFinite(tradingEquity) || tradingEquity <= 0))
    )
      return true;
    this.initialize(equity, now, tradingEquity);
    if (this.value.baseline <= 0) return true;
    const loss = Math.max(
      -this.value.dailyPnL,
      tradingEquity !== undefined
        ? this.value.baseline - tradingEquity
        : (this.value.accountBaseline ?? this.value.baseline) - equity,
      0,
    );
    const accountLoss = (this.value.accountBaseline ?? this.value.baseline) - equity;
    const accountLimit =
      ((this.value.accountBaseline ?? this.value.baseline) * this.c.MAX_DAILY_LOSS_PERCENT) / 100;
    return (
      loss + 1e-9 >= (this.value.baseline * this.c.MAX_DAILY_LOSS_PERCENT) / 100 ||
      accountLoss + 1e-9 >= accountLimit
    );
  }
  get state(): Readonly<GuardState> {
    return this.value;
  }
}
