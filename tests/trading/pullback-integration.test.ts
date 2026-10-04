import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { Journal } from '../../src/database/db.js';
import { TradingEngine } from '../../src/trading/TradingEngine.js';
import { MarketState } from '../../src/market/MarketState.js';
import { PaperExecutionEngine } from '../../src/trading/PaperExecutionEngine.js';
import { DailyLossGuard } from '../../src/risk/DailyLossGuard.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { PositionSizer } from '../../src/risk/PositionSizer.js';
import { moveProtection } from '../../src/trading/protection.js';
import { createLogger } from '../../src/utils/logger.js';
import { formatProfit } from '../../src/telegram/messages.js';
import { instrument, signal } from '../helpers.js';
import type { Candle, Trade } from '../../src/exchange/bybit/types.js';

function setup() {
  const c = parseEnv({
    STRATEGY: 'trend-pullback',
    TRADING_MODE: 'paper',
    ENTRY_ORDER_TYPE: 'Market',
  });
  const db = new Journal(':memory:'),
    logger = createLogger('silent'),
    market = new MarketState(c.SYMBOLS);
  const execution = new PaperExecutionEngine(c, db, logger, new Map([['BTCUSDT', instrument]]));
  const engine = new TradingEngine(
    c,
    market,
    db,
    logger,
    new DailyLossGuard(c, db, 'paper'),
    new KillSwitch(db, logger, 'paper'),
    execution,
    () => ({ status: 'HEALTHY', reasons: [], timestamp: 3600000 }),
  );
  return { c, db, engine, execution };
}
describe('pullback integration', () => {
  it('evaluates each 15m close once and never evaluates minute/unconfirmed events', async () => {
    const { db, engine } = setup();
    try {
      db.setState('candle:paper:BTCUSDT', 2700000);
      const evaluate = vi.spyOn(engine.signals, 'evaluate').mockReturnValue([]);
      const bar: Candle = {
        symbol: 'BTCUSDT',
        interval: 15,
        start: 2700000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
        turnover: 100,
        confirmed: true,
      };
      await engine.processCandle({ ...bar, interval: 1 }, 3600000);
      await engine.processCandle({ ...bar, confirmed: false }, 3600000);
      expect(evaluate).not.toHaveBeenCalled();
      await engine.processCandle(bar, 3600000);
      await engine.processCandle(bar, 3600000);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(db.state('candle:paper:trend-pullback:BTCUSDT')).toBe(2700000);
      expect(engine.status().strategy).toBe('trend-pullback');
    } finally {
      db.close();
    }
  });
  it('persists strategy on trade closure and freezes new protection settings', async () => {
    const { c, db, execution } = setup();
    try {
      const tagged = {
        ...signal,
        strategy: 'trend-pullback' as const,
        protection: {
          breakevenEnabled: true,
          breakevenTriggerR: 1.5,
          trailingStopEnabled: false,
          trailingAtrMultiplier: 1,
        },
      };
      await execution.submit(
        tagged,
        {
          entry: 100,
          stopLoss: 95,
          takeProfit: 112.5,
          quantity: 1,
          riskAmount: 5.2,
          riskBudget: 25,
        },
        { bid: 99.99, ask: 100, timestamp: 1000, imbalance: 1 },
        1000,
      );
      const p = execution.positions.get('BTCUSDT')!;
      const moved = moveProtection(
        p,
        { bid: 106, ask: 106.01, timestamp: 2000, imbalance: 1 },
        { ...c, TRAILING_STOP_ENABLED: true, BREAKEVEN_TRIGGER_R: 1 },
        instrument,
      );
      expect(moved.stopLoss).toBe(95);
      expect(moved.breakeven).toBe(false);
      const legacy = moveProtection(
        { ...p, signal },
        { bid: 106, ask: 106.01, timestamp: 2000, imbalance: 1 },
        c,
        instrument,
      );
      expect(legacy.breakeven).toBe(true);
      await execution.closeAll('manual');
      expect(db.list<Trade>('trades')[0]?.strategy).toBe('trend-pullback');
    } finally {
      db.close();
    }
  });
  it('rechecks net viability after tick rounding', () => {
    const c = parseEnv({ STRATEGY: 'trend-pullback', MIN_RR: 1.3 });
    expect(() =>
      new PositionSizer(c).size(
        10000,
        { ...signal, strategy: 'trend-pullback', entry: 100, stopLoss: 99.5, takeProfit: 101.25 },
        instrument,
      ),
    ).toThrow('net risk reward');
  });
  it('separates active strategy profits and counts untagged legacy trades as scalping', () => {
    const { db, engine } = setup();
    try {
      const common = { mode: 'paper', symbol: 'BTCUSDT', exitTime: 1000, fees: 0.1 };
      db.save('trades', 'legacy', { ...common, netPnL: -4 });
      db.save('trades', 'scalp', { ...common, strategy: 'scalping', netPnL: -1 });
      db.save('trades', 'pullback', { ...common, strategy: 'trend-pullback', netPnL: 2 });
      const report = engine.profit(2000);
      expect(report.allTime.netPnL).toBe(-3);
      expect(report.activeStrategy?.totals.netPnL).toBe(2);
      expect(report.activeStrategy?.totals.totalTrades).toBe(1);
      expect(db.profitTotals('paper', 0, 3000, 'scalping').netPnL).toBe(-5);
      expect(formatProfit(report)).toContain('Тренд и откат 15м / 1ч');
      expect(formatProfit(report)).toContain('Результат этой стратегии: +2 USDT');
    } finally {
      db.close();
    }
  });
});
