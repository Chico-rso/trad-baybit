import { afterEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../../src/database/db.js';
import { TradingEngine } from '../../src/trading/TradingEngine.js';
import { PaperExecutionEngine } from '../../src/trading/PaperExecutionEngine.js';
import { MarketState } from '../../src/market/MarketState.js';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/utils/logger.js';
import { DailyLossGuard } from '../../src/risk/DailyLossGuard.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { parseCommand, type Command } from '../../src/telegram/commands.js';
import { TelegramBot } from '../../src/telegram/TelegramBot.js';
import type { Position, Trade } from '../../src/exchange/bybit/types.js';
import { signal } from '../helpers.js';

const now = Date.UTC(2026, 9, 3, 12);
const midnight = Date.UTC(2026, 9, 3);
const journals: Journal[] = [];
afterEach(() => {
  for (const db of journals.splice(0)) db.close();
  vi.restoreAllMocks();
});

function setup(capital: string | null = '24') {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const c = parseEnv({
    TRADING_MODE: 'paper',
    PAPER_INITIAL_EQUITY: '100000',
    ...(capital === null ? {} : { TRADING_CAPITAL_USDT: capital }),
  });
  const db = new Journal(':memory:');
  journals.push(db);
  const logger = createLogger('silent');
  const market = new MarketState(c.SYMBOLS);
  market.publicConnected = true;
  for (const symbol of c.SYMBOLS) market.synchronized.add(symbol);
  const execution = new PaperExecutionEngine(c, db, logger, market.instruments);
  const engine = new TradingEngine(
    c,
    market,
    db,
    logger,
    new DailyLossGuard(c, db, 'paper'),
    new KillSwitch(db, logger, 'paper'),
    execution,
    () => ({ status: 'HEALTHY', reasons: [], timestamp: now }),
  );
  return { db, market, execution, engine };
}

function trade(id: string, netPnL: number, fees = 0, exitTime = now, mode = 'paper'): Trade {
  return {
    id,
    mode,
    symbol: 'BTCUSDT',
    side: 'Long',
    entryTime: exitTime - 1000,
    exitTime,
    entry: 100,
    exit: 100 + netPnL + fees,
    quantity: 1,
    stopLoss: 95,
    takeProfit: 110,
    grossPnL: netPnL + fees,
    fees,
    netPnL,
    estimatedSlippage: 0,
    signalScore: 80,
    signalReasons: [],
    exitReason: 'manual',
  };
}

function position(symbol = 'BTCUSDT', side: 'Long' | 'Short' = 'Long'): Position {
  return {
    id: symbol,
    mode: 'paper',
    symbol,
    side,
    quantity: 2,
    initialQuantity: 3,
    entry: 100,
    entryTime: now - 1000,
    stopLoss: 95,
    initialStopLoss: 95,
    takeProfit: 120,
    fees: 1.5,
    estimatedSlippage: 0,
    grossPnL: 3,
    exitValue: 103,
    exitQuantity: 1,
    signal,
    breakeven: false,
    trailingAnchor: 100,
  };
}

function quote(market: MarketState, symbol: string, bid: number, ask: number, timestamp = now) {
  market.books.get(symbol)!.apply(
    'snapshot',
    {
      b: [[String(bid), '10']],
      a: [[String(ask), '10']],
      u: 1,
      seq: 1,
    },
    timestamp,
  );
}

describe('Telegram profit report', () => {
  it('recognizes the new command including a Telegram bot suffix', () => {
    expect(parseCommand('/profit')).toBe('profit');
    expect(parseCommand('/profit@ExampleBot')).toBe('profit');
    expect(parseCommand('/profit extra')).toBeUndefined();
  });

  it('returns a readable zero report without mutating trading controls', async () => {
    const { engine, db } = setup();
    engine.paused = true;
    const eventsBefore = db.list('events').length;
    const text = await engine.command('profit' as Command);
    expect(text).toContain('💰 Прибыль бота');
    expect(text).toContain('Чистый итог: 0 USDT');
    expect(text).toContain('Открытых позиций: 0');
    expect(text).toContain('Расчётный капитал сейчас: 24 USDT');
    expect(text).toContain('Изменение: 0%');
    expect(engine.paused).toBe(true);
    expect(engine.kill.active).toBe(false);
    expect(db.list('events')).toHaveLength(eventsBefore);
  });

  it('separates winning and losing net results, fees, UTC days and trading modes', async () => {
    const { engine, db } = setup();
    for (const t of [
      trade('win', 10, 2, midnight - 1),
      trade('loss', -4, 1, midnight),
      trade('zero', 0, 0, now),
      trade('other-mode', 100, 50, now, 'demo'),
    ])
      db.save('trades', t.id, t, 42);
    const report = engine.resources().profit();
    expect(report.allTime).toEqual({
      totalTrades: 3,
      wins: 1,
      losses: 1,
      breakEven: 1,
      winningPnL: 10,
      losingPnL: -4,
      netPnL: 6,
      fees: 3,
    });
    expect(report.today.netPnL).toBe(-4);
    expect(report.today.totalTrades).toBe(2);
    expect(report.totalPnL).toBe(6);
    expect(report.currentCapital).toBe(30);
    expect(report.returnPercent).toBe(25);
    const text = await engine.command('profit' as Command);
    expect(text).toContain('Заработано на прибыльных: +10 USDT');
    expect(text).toContain('Потеряно на убыточных: −4 USDT');
    expect(text).toContain('Комиссии: 3 USDT — уже включены в итог');
    expect(text).toContain('Сегодня (UTC): −4 USDT');
  });

  it('excludes the next UTC day from today while retaining complete journal totals', () => {
    const { engine, db } = setup();
    const future = trade('next-day', 9, 0, midnight + 86400000);
    db.save('trades', future.id, future, future.exitTime);
    expect(engine.resources().profit().today.totalTrades).toBe(0);
    expect(engine.resources().profit().allTime.netPnL).toBe(9);
  });

  it('values Long at bid and Short at ask including partial exits and paid fees', () => {
    const { engine, market, execution } = setup();
    execution.positions.set('BTCUSDT', position());
    execution.positions.set('ETHUSDT', position('ETHUSDT', 'Short'));
    quote(market, 'BTCUSDT', 110, 111);
    quote(market, 'ETHUSDT', 89, 90);
    const report = engine.resources().profit();
    expect(report.openPositions).toBe(2);
    expect(report.openPnL).toBe(43);
    expect(report.totalPnL).toBe(43);
    expect(report.currentCapital).toBe(67);
    expect(report.returnPercent).toBeCloseTo((43 / 24) * 100);
  });

  it.each(['missing', 'stale', 'future', 'disconnected', 'unsynchronized'])(
    'does not fabricate an open valuation when quotes are %s',
    async (state) => {
      const { engine, db, market, execution } = setup();
      const t = trade('win', 10);
      db.save('trades', t.id, t, t.exitTime);
      execution.positions.set('BTCUSDT', position());
      if (state !== 'missing')
        quote(
          market,
          'BTCUSDT',
          110,
          111,
          state === 'stale' ? now - 15001 : state === 'future' ? now + 1 : now,
        );
      if (state === 'disconnected') market.publicConnected = false;
      if (state === 'unsynchronized') market.synchronized.delete('BTCUSDT');
      const report = engine.resources().profit();
      expect(report.allTime.netPnL).toBe(10);
      expect(report.openPnL).toBeNull();
      expect(report.totalPnL).toBeNull();
      expect(report.currentCapital).toBeNull();
      expect(report.returnPercent).toBeNull();
      const text = await engine.command('profit' as Command);
      expect(text).toContain('Чистый итог: +10 USDT');
      expect(text).toContain('Общий результат сейчас: недоступен');
    },
  );

  it('does not use unrelated wallet assets as a profit percentage denominator', async () => {
    const { engine } = setup(null);
    const report = engine.resources().profit();
    expect(report.initialCapital).toBeNull();
    expect(report.currentCapital).toBeNull();
    expect(report.returnPercent).toBeNull();
    expect(await engine.command('profit' as Command)).not.toContain('Изменение:');
  });

  it('does not truncate all-time profit at 100,000 completed trades', () => {
    const { engine, db } = setup();
    db.transaction(() => {
      for (let i = 0; i < 100001; i++)
        db.save('trades', String(i), { mode: 'paper', netPnL: 1, fees: 0, exitTime: now }, now);
    });
    const report = engine.resources().profit();
    expect(report.allTime.totalTrades).toBe(100001);
    expect(report.allTime.netPnL).toBe(100001);
    expect(report.currentCapital).toBe(100025);
  }, 15000);

  it('routes profit only for the authorized Telegram chat', async () => {
    const { engine } = setup();
    const handler = vi.fn((cmd: Command) => engine.command(cmd));
    const send = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: {} })),
    );
    const bot = new TelegramBot('fake-token', '42', createLogger('silent'), handler, send);
    await bot.handleUpdate({ update_id: 1, message: { chat: { id: 13 }, text: '/profit' } });
    expect(handler).not.toHaveBeenCalled();
    await bot.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/profit' } });
    expect(handler).toHaveBeenCalledWith('profit');
    const body = JSON.parse(String(send.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toContain('💰 Прибыль бота');
  });
});
