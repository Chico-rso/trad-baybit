import type { Config } from '../config/env.js';
import type { Signal } from '../exchange/bybit/types.js';
import type { DailyLossGuard } from './DailyLossGuard.js';
import type { KillSwitch } from './KillSwitch.js';
export interface RiskContext {
  equity: number;
  tradingEquity?: number;
  openSymbols: string[];
  pendingSymbols: string[];
  healthy: boolean;
  marketFresh: boolean;
  paused: boolean;
  now: number;
}
export class RiskManager {
  constructor(
    private readonly c: Config,
    private readonly guard: DailyLossGuard,
    private readonly kill: KillSwitch,
  ) {}
  check(signal: Signal, ctx: RiskContext): { allowed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (signal.decision !== 'accepted') reasons.push('strategy rejected');
    if (this.kill.active) reasons.push('kill switch active');
    if (ctx.paused) reasons.push('paused');
    if (!ctx.healthy) reasons.push('system unhealthy');
    if (!ctx.marketFresh) reasons.push('market data stale');
    if (!Number.isFinite(ctx.equity) || ctx.equity <= 0) reasons.push('equity unavailable');
    else if (this.guard.blocked(ctx.equity, ctx.now, ctx.tradingEquity))
      reasons.push('daily loss limit');
    if (this.guard.lossLimitsEnabled) {
      if (this.guard.state.consecutiveLosses >= this.c.MAX_CONSECUTIVE_LOSSES)
        reasons.push('maximum consecutive losses');
      if (ctx.now < this.guard.state.cooldownUntil) reasons.push('loss cooldown');
    }
    if (ctx.openSymbols.includes(signal.symbol)) reasons.push('existing position');
    if (ctx.pendingSymbols.includes(signal.symbol)) reasons.push('pending order');
    if (new Set([...ctx.openSymbols, ...ctx.pendingSymbols]).size >= this.c.MAX_OPEN_POSITIONS)
      reasons.push('position capacity reached');
    if (
      Math.abs(signal.takeProfit - signal.entry) / Math.abs(signal.entry - signal.stopLoss) <
      this.c.MIN_RR
    )
      reasons.push('risk reward too low');
    return { allowed: reasons.length === 0, reasons };
  }
}
