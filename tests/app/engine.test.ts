import { describe, expect, it } from 'vitest';
import { TradingEngine } from '../../src/trading/TradingEngine.js';
import { MarketState } from '../../src/market/MarketState.js';
import { Journal } from '../../src/database/db.js';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { DailyLossGuard } from '../../src/risk/DailyLossGuard.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { TelegramBot } from '../../src/telegram/TelegramBot.js';
import { PaperExecutionEngine } from '../../src/trading/PaperExecutionEngine.js';
import { instrument, signal } from '../helpers.js';
import { FileLock } from '../../src/app/FileLock.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('application controls', () => {
  it('includes own realized and open PnL in allocated capital instead of unrelated wallet assets', async () => {
    const c = parseEnv({
      TRADING_MODE: 'paper',
      PAPER_INITIAL_EQUITY: '100000',
      TRADING_CAPITAL_USDT: '24',
      ENTRY_ORDER_TYPE: 'Market',
      SLIPPAGE_BPS: '0',
    });
    const db = new Journal(':memory:'),
      log = createLogger('silent'),
      market = new MarketState(c.SYMBOLS);
    const execution = new PaperExecutionEngine(c, db, log, new Map([['BTCUSDT', instrument]]));
    const engine = new TradingEngine(
      c,
      market,
      db,
      log,
      new DailyLossGuard(c, db, 'paper'),
      new KillSwitch(db, log, 'paper'),
      execution,
      () => ({ status: 'HEALTHY', reasons: [], timestamp: 1000 }),
    );
    expect(engine.tradingEquity()).toBe(24);
    await execution.submit(
      signal,
      {
        entry: 100,
        stopLoss: 95,
        takeProfit: 110,
        quantity: 0.1,
        riskAmount: 0.5,
        riskBudget: 0.5,
      },
      { bid: 99.9, ask: 100, timestamp: 1000, imbalance: 1 },
      1000,
    );
    market.books
      .get('BTCUSDT')!
      .apply('snapshot', { b: [['99', '1']], a: [['100', '1']], u: 1, seq: 1 }, 1100);
    expect(engine.tradingEquity()).toBeCloseTo(23.8945);
    await execution.closeAll('manual');
    const net = db.list<{ netPnL: number }>('trades')[0]!.netPnL;
    expect(engine.tradingEquity()).toBeCloseTo(24 + net);
    db.close();
  });
  it('pause takes effect immediately and resume cannot bypass kill switch', async () => {
    const c = parseEnv({}),
      db = new Journal(':memory:'),
      log = createLogger('silent'),
      kill = new KillSwitch(db, log, 'signal');
    const engine = new TradingEngine(
      c,
      new MarketState(c.SYMBOLS),
      db,
      log,
      new DailyLossGuard(c, db, 'signal'),
      kill,
      undefined,
      () => ({ status: 'HEALTHY', reasons: [], timestamp: 1000 }),
    );
    engine.setTelegram(new TelegramBot('', '', log, (cmd) => engine.command(cmd)));
    const reply = engine.command('pause');
    expect(engine.paused).toBe(true);
    expect(await reply).toContain('приостановлены');
    kill.activate('state mismatch');
    expect(await engine.command('resume')).toContain('защитная остановка');
    expect(engine.paused).toBe(true);
    const status = await engine.command('status');
    expect(status).toContain('Открытых позиций: 0');
    expect(status).toContain('Сигнала для входа пока нет');
    expect(status).not.toContain('openPositions');
    expect(await engine.command('positions')).toContain('нет');
    expect(await engine.command('stats')).toContain('Завершённых сделок: 0');
    db.close();
  });
  it('prevents two processes using one trading journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-lock-'));
    const file = join(dir, 'bot.lock');
    const first = new FileLock(file);
    expect(() => new FileLock(file)).toThrow();
    first.release();
    const next = new FileLock(file);
    next.release();
    rmSync(dir, { recursive: true });
  });
});
