import { describe, expect, it } from 'vitest';
import { PositionSizer } from '../../src/risk/PositionSizer.js';
import { DailyLossGuard } from '../../src/risk/DailyLossGuard.js';
import { RiskManager } from '../../src/risk/RiskManager.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { normalizePrice, normalizeQuantity } from '../../src/utils/math.js';
import { parseEnv } from '../../src/config/env.js';
import { Journal } from '../../src/database/db.js';
import { createLogger } from '../../src/utils/logger.js';
import { instrument, signal } from '../helpers.js';
describe('instrument normalization', () => {
  it('uses exact decimals with non-power-of-ten steps', () => {
    expect(normalizePrice(100.74, '0.5', 'down')).toBe('100.5');
    expect(normalizePrice(100.74, '0.5', 'up')).toBe('101');
    expect(normalizeQuantity(0.3, '0.1')).toBe('0.3');
    expect(normalizeQuantity(1.24, '0.25')).toBe('1');
  });
  it('rejects NaN/negative values and invalid steps', () => {
    expect(() => normalizeQuantity(NaN, '0.1')).toThrow();
    expect(() => normalizePrice(1, '0')).toThrow();
  });
});
describe('risk sizing and guards', () => {
  it('isolates allocated bot equity while still protecting the full account', () => {
    const db = new Journal(':memory:');
    const guard = new DailyLossGuard(parseEnv({ TRADING_CAPITAL_USDT: '24' }), db, 'demo');
    guard.initialize(100000, 1000, 24);
    expect(guard.blocked(99999, 1000, 24)).toBe(false);
    expect(guard.blocked(100000, 1000, 23.52)).toBe(true);
    expect(guard.blocked(98000, 1000, 24)).toBe(true);
    expect(
      new DailyLossGuard(parseEnv({ TRADING_CAPITAL_USDT: '24' }), db, 'demo').blocked(
        100000,
        1000,
        23.52,
      ),
    ).toBe(true);
    db.close();
  });
  it('fails closed when a legacy capped journal has lost the raw daily baseline', () => {
    const db = new Journal(':memory:');
    db.setState('risk:demo', {
      day: '1970-01-01',
      baseline: 23.95,
      dailyPnL: 0,
      consecutiveLosses: 0,
      cooldownUntil: 0,
    });
    const c = parseEnv({ TRADING_CAPITAL_USDT: '23.95' });
    expect(() => new DailyLossGuard(c, db, 'demo').blocked(100000, 1000)).toThrow(
      'daily equity baseline',
    );
    expect(() => new DailyLossGuard(c, db, 'demo').synchronize([], 100000, 1000)).toThrow(
      'daily equity baseline',
    );
    db.close();
  });
  it('does not hide account drawdown above the capital limit, including after restart', () => {
    const db = new Journal(':memory:');
    const c = parseEnv({ TRADING_CAPITAL_USDT: '23.95' });
    const guard = new DailyLossGuard(c, db, 'demo');
    guard.initialize(100000, 1000);
    expect(guard.blocked(99999.6, 1000)).toBe(false);
    expect(guard.blocked(99999, 1000)).toBe(true);
    expect(new DailyLossGuard(c, db, 'demo').blocked(99999, 1000)).toBe(true);
    db.close();
  });
  it('uses allocated capital instead of the whole demo account for risk', () => {
    const c = parseEnv({
      TRADING_CAPITAL_USDT: '200',
      MAKER_FEE_BPS: '0',
      TAKER_FEE_BPS: '0',
      SLIPPAGE_BPS: '0',
    });
    const size = new PositionSizer(c).size(187000, signal, instrument);
    expect(size.riskBudget).toBe(0.5);
    expect(size.quantity).toBe(0.1);
  });
  it('subtracts already reserved margin from the allocated capital', () => {
    const c = parseEnv({
      TRADING_CAPITAL_USDT: '100',
      RISK_PER_TRADE_PERCENT: '2',
      MAKER_FEE_BPS: '0',
      TAKER_FEE_BPS: '0',
      SLIPPAGE_BPS: '0',
    });
    const size = new PositionSizer(c).size(
      100000,
      { ...signal, entry: 10, stopLoss: 9, takeProfit: 12 },
      instrument,
      99980,
    );
    expect(size.riskBudget).toBe(2);
    expect(size.quantity).toBe(2);
    const constrained = new PositionSizer(c).size(
      100000,
      { ...signal, entry: 10, stopLoss: 9, takeProfit: 12 },
      instrument,
      99920,
    );
    expect(constrained.quantity).toBe(1.9);
    expect(() => new PositionSizer(c).size(100000, signal, instrument, 99900)).toThrow();
  });
  it('does not exceed a smaller actual account balance', () => {
    const c = parseEnv({
      TRADING_CAPITAL_USDT: '200',
      MAKER_FEE_BPS: '0',
      TAKER_FEE_BPS: '0',
      SLIPPAGE_BPS: '0',
    });
    expect(() => new PositionSizer(c).size(100, signal, instrument)).toThrow();
  });
  it('applies the daily loss boundary to allocated capital and preserves losses on restart', () => {
    const db = new Journal(':memory:');
    const now = 1000;
    const original = new DailyLossGuard(parseEnv({}), db, 'demo');
    original.initialize(187000, now);
    original.record(-0.479, now);
    const c = parseEnv({ TRADING_CAPITAL_USDT: '24' });
    const guard = new DailyLossGuard(c, db, 'demo');
    expect(guard.blocked(187000, now)).toBe(false);
    expect(guard.state.baseline).toBe(24);
    expect(guard.state.consecutiveLosses).toBe(1);
    expect(guard.state.cooldownUntil).toBe(original.state.cooldownUntil);
    guard.record(-0.001, now);
    expect(guard.blocked(187000, now)).toBe(true);
    const restored = new DailyLossGuard(c, db, 'demo');
    restored.synchronize(
      [
        { netPnL: -0.479, exitTime: now },
        { netPnL: -0.001, exitTime: now },
      ],
      187000,
      now,
    );
    expect(restored.blocked(187000, now)).toBe(true);
    expect(restored.state.consecutiveLosses).toBe(2);
    db.close();
  });
  it('sizes from stop distance and never increases risk using leverage', () => {
    const c = parseEnv({ MAKER_FEE_BPS: '0', TAKER_FEE_BPS: '0', SLIPPAGE_BPS: '0' });
    const size = new PositionSizer(c).size(10000, signal, instrument);
    expect(size.quantity).toBe(5);
    expect(size.riskAmount).toBe(25);
    expect(new PositionSizer({ ...c, LEVERAGE: 3 }).size(10000, signal, instrument).quantity).toBe(
      5,
    );
  });
  it('includes transaction cost budget and never rounds up to minimum', () => {
    expect(new PositionSizer(parseEnv({})).size(10000, signal, instrument).quantity).toBeLessThan(
      5,
    );
    expect(() => new PositionSizer(parseEnv({})).size(1, signal, instrument)).toThrow();
  });
  it('blocks daily loss at the exact boundary and persists it through restart', () => {
    const db = new Journal(':memory:');
    const c = parseEnv({});
    const guard = new DailyLossGuard(c, db, 'paper');
    guard.initialize(10000, 1000);
    guard.record(-200, 1000);
    expect(guard.blocked(9800, 1000)).toBe(true);
    expect(new DailyLossGuard(c, db, 'paper').blocked(9800, 1000)).toBe(true);
    guard.initialize(9800, 86400000);
    expect(guard.blocked(9800, 86400000)).toBe(false);
    db.close();
  });
  it('blocks stale data, pending, max losses and kill switch independently', () => {
    const db = new Journal(':memory:');
    const c = parseEnv({ COOLDOWN_AFTER_LOSS_MINUTES: '0' });
    const guard = new DailyLossGuard(c, db, 'paper');
    guard.initialize(10000, 1000);
    const kill = new KillSwitch(db, createLogger('silent'), 'paper');
    const risk = new RiskManager(c, guard, kill);
    const ctx = {
      equity: 10000,
      openSymbols: [] as string[],
      pendingSymbols: [] as string[],
      healthy: true,
      marketFresh: true,
      paused: false,
      now: 1000,
    };
    expect(risk.check(signal, ctx).allowed).toBe(true);
    expect(risk.check(signal, { ...ctx, marketFresh: false }).reasons).toContain(
      'market data stale',
    );
    expect(risk.check(signal, { ...ctx, pendingSymbols: ['BTCUSDT'] }).allowed).toBe(false);
    guard.record(-1, 1000);
    guard.record(-1, 1000);
    guard.record(-1, 1000);
    expect(risk.check(signal, ctx).reasons).toContain('maximum consecutive losses');
    kill.activate('state mismatch');
    expect(risk.check(signal, ctx).allowed).toBe(false);
    db.close();
  });
});

describe('guard journal recovery', () => {
  it('restores daily PnL, consecutive losses and cooldown after a crash between trade and guard writes', () => {
    const db = new Journal(':memory:'),
      c = parseEnv({});
    const guard = new DailyLossGuard(c, db, 'paper');
    guard.initialize(10000, 1000);
    guard.synchronize(
      [
        { netPnL: -50, exitTime: 1000 },
        { netPnL: -70, exitTime: 2000 },
        { netPnL: -80, exitTime: 3000 },
      ],
      9800,
      4000,
    );
    expect(guard.state.dailyPnL).toBe(-200);
    expect(guard.state.consecutiveLosses).toBe(3);
    expect(guard.blocked(9800, 4000)).toBe(true);
    guard.synchronize(
      [
        { netPnL: -50, exitTime: 1000 },
        { netPnL: -70, exitTime: 2000 },
        { netPnL: -80, exitTime: 3000 },
      ],
      9800,
      5000,
    );
    expect(guard.state.dailyPnL).toBe(-200);
    db.close();
  });
});

describe('cost viability', () => {
  it('rejects an ATR target that cannot even pay estimated round-trip expenses', () => {
    const db = new Journal(':memory:');
    const tiny = { ...signal, entry: 100, stopLoss: 99.995, takeProfit: 100.01 };
    expect(() =>
      new PositionSizer(parseEnv({})).size(10000, tiny, {
        ...instrument,
        tickSize: '0.001',
        qtyStep: '0.001',
      }),
    ).toThrow('costs');
    db.close();
  });
});
