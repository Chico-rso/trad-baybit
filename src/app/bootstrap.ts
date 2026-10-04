import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { strategyTimeframes, type Config } from '../config/env.js';
import { createLogger, registerSecrets } from '../utils/logger.js';
import { Journal } from '../database/db.js';
import { MarketState } from '../market/MarketState.js';
import { BybitRestClient } from '../exchange/bybit/BybitRestClient.js';
import { BybitClient } from '../exchange/bybit/BybitClient.js';
import { BybitMarketData } from '../exchange/bybit/BybitMarketData.js';
import { BybitPrivateData } from '../exchange/bybit/BybitPrivateData.js';
import { PaperExecutionEngine } from '../trading/PaperExecutionEngine.js';
import { TestnetExecutionEngine } from '../trading/TestnetExecutionEngine.js';
import { DemoExecutionEngine } from '../trading/DemoExecutionEngine.js';
import { LiveExecutionEngine } from '../trading/LiveExecutionEngine.js';
import { ExchangeExecutionEngine } from '../trading/ExchangeExecutionEngine.js';
import type { ExecutionEngine } from '../trading/ExecutionEngine.js';
import { TradingEngine } from '../trading/TradingEngine.js';
import { DailyLossGuard } from '../risk/DailyLossGuard.js';
import { KillSwitch } from '../risk/KillSwitch.js';
import { health, type Health } from '../monitoring/health.js';
import { TelegramBot } from '../telegram/TelegramBot.js';
import { formatPosition, formatTrade, formatStop } from '../telegram/messages.js';
import { startApi } from '../api/server.js';
import { FileLock } from './FileLock.js';
import type {
  Candle,
  Trade,
  Position,
  PublicTrade,
  ExchangeOrder,
  ExchangeFill,
} from '../exchange/bybit/types.js';

export async function bootstrap(c: Config) {
  registerSecrets([c.BYBIT_API_KEY, c.BYBIT_API_SECRET, c.TELEGRAM_BOT_TOKEN]);
  const logger = createLogger(c.LOG_LEVEL);
  if (c.TRADING_MODE === 'testnet')
    logger.warn({ event: 'mode.testnet', message: 'BYBIT TESTNET MODE' });
  if (c.TRADING_MODE === 'demo')
    logger.warn({ event: 'mode.demo', message: 'BYBIT DEMO TRADING — VIRTUAL FUNDS ONLY' });
  const lock = new FileLock(resolve(c.DATABASE_PATH) + '.lock');
  let db: Journal;
  try {
    db = new Journal(c.DATABASE_PATH);
  } catch (err) {
    lock.release();
    throw err;
  }
  const market = new MarketState(c.SYMBOLS, c.ORDERBOOK_LEVELS),
    rest = new BybitRestClient(c, logger),
    client = new BybitClient(rest);
  const publicData = new BybitMarketData(client, market, c, logger);
  const kill = new KillSwitch(db, logger, c.TRADING_MODE),
    guard = new DailyLossGuard(c, db, c.TRADING_MODE);
  let execution: ExecutionEngine | undefined, privateData: BybitPrivateData | undefined;
  if (c.TRADING_MODE === 'paper')
    execution = new PaperExecutionEngine(c, db, logger, market.instruments);
  else if (c.TRADING_MODE === 'testnet')
    execution = new TestnetExecutionEngine(c, db, logger, market.instruments, client, kill);
  else if (c.TRADING_MODE === 'demo')
    execution = new DemoExecutionEngine(c, db, logger, market.instruments, client, kill);
  else if (c.TRADING_MODE === 'live')
    execution = new LiveExecutionEngine(c, db, logger, market.instruments, client, kill);
  const getHealth = (): Health =>
    health(
      c,
      market,
      db,
      engine.signals.strategy.warmup,
      rest.lastSuccess,
      !(execution instanceof ExchangeExecutionEngine) || execution.synchronized,
    );
  const engine = new TradingEngine(c, market, db, logger, guard, kill, execution, getHealth);
  const telegram = new TelegramBot(c.TELEGRAM_BOT_TOKEN, c.TELEGRAM_CHAT_ID, logger, (cmd) =>
    engine.command(cmd),
  );
  engine.setTelegram(telegram);
  kill.on('activated', (reason: string) => {
    telegram.notify(formatStop([reason], c.TRADING_MODE));
    if (execution) engine.enqueue(() => execution!.cancelEntries());
  });
  rest.on('failure', () => {
    if (rest.consecutiveErrors >= c.EXCHANGE_ERROR_THRESHOLD)
      kill.activate('exchange error threshold exceeded');
  });
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopped = false;
  let everHealthy = false;
  let privateDisconnectedAt = Date.now();
  let publicDisconnectedAt = Date.now();
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    engine.stopEntries();
    for (const t of timers) clearInterval(t);
    let failure: unknown;
    try {
      engine.enqueue(async () => {
        try {
          if (execution) {
            await execution.cancelEntries();
            if (c.AUTO_CLOSE_ON_SHUTDOWN) await execution.closeAll('shutdown');
          }
          if (execution instanceof ExchangeExecutionEngine) await execution.reconcile();
        } catch (err) {
          failure = err;
          throw err;
        }
      });
      await engine.drain();
      publicData.stop();
      privateData?.stop(); // no new WS work can enter the queue
      await engine.drain(); // consume updates queued while REST shutdown operations ran
      db.setState(`shutdown:${c.TRADING_MODE}`, {
        timestamp: Date.now(),
        positions: [...(execution?.positions.values() ?? [])],
      });
      db.save('events', randomUUID(), { event: 'shutdown', mode: c.TRADING_MODE });
    } catch (err) {
      failure = err;
      logger.error({ event: 'shutdown.state.failed', error: err });
    } finally {
      publicData.stop();
      privateData?.stop();
      await telegram.stop();
      await api?.stop();
      db.close();
      lock.release();
    }
    logger.info({ event: 'shutdown.completed', positionsLeftOpen: execution?.positions.size ?? 0 });
    if (failure) throw failure;
  };
  try {
    await publicData.initialize();
    const syncGuards = () => {
      if (engine.equity() > 0)
        guard.synchronize(
          db.list<Trade>('trades', 100000, c.TRADING_MODE),
          engine.equity(),
          Date.now(),
          engine.tradingEquity(),
        );
    };
    if (execution instanceof PaperExecutionEngine || execution instanceof ExchangeExecutionEngine) {
      execution.on('position', (position: Position) => telegram.notify(formatPosition(position)));
      execution.on('closed', (trade: Trade) => {
        syncGuards();
        telegram.notify(formatTrade(trade));
      });
    }
    if (execution instanceof ExchangeExecutionEngine) {
      execution.setPreflight(
        () => getHealth().status === 'HEALTHY' && !kill.active && !engine.paused,
      );
      privateData = new BybitPrivateData(c, logger);
      const exchange = execution;
      privateData.on('disconnected', () => {
        kill.interruptRecovery();
        market.privateConnected = false;
        privateDisconnectedAt = Date.now();
        exchange.synchronized = false;
      });
      privateData.on('connected', () => {
        market.privateConnected = true;
        engine.enqueue(async () => {
          await exchange.reconcile();
        });
      });
      privateData.on('orders', (orders: ExchangeOrder[]) =>
        engine.enqueue(async () => exchange.handleOrders(orders)),
      );
      privateData.on('executions', (fills: ExchangeFill[]) =>
        engine.enqueue(async () => exchange.handleExecutions(fills)),
      );
      privateData.on('accountUpdate', () => {
        kill.interruptRecovery();
        exchange.synchronized = false;
      });
      privateData.on('fault', () => logger.warn({ event: 'private.stream.fault' }));
      await exchange.initialize();
      syncGuards();
      privateData.start();
      timers.push(
        setInterval(
          () =>
            engine.enqueue(async () => {
              await exchange.reconcile();
            }),
          c.RECONCILE_INTERVAL_MS,
        ),
      );
    } else {
      syncGuards();
      timers.push(
        setInterval(
          () =>
            engine.enqueue(async () => {
              await rest.synchronizeClock();
            }),
          30000,
        ),
      );
    }
    syncGuards();
    publicData.on('candle', (candle: Candle) => engine.enqueue(() => engine.processCandle(candle)));
    publicData.on('trade', (trade: PublicTrade) => {
      if (
        execution instanceof PaperExecutionEngine &&
        execution.pendingSymbols().includes(trade.symbol)
      )
        engine.enqueue(() => execution!.onTrade(trade));
    });
    publicData.on('disconnected', () => {
      kill.interruptRecovery();
      publicDisconnectedAt = Date.now();
    });
    publicData.on('synchronized', () => {
      publicDisconnectedAt = 0;
    });
    publicData.on('fault', () => logger.warn({ event: 'market.stream.fault' }));
    timers.push(
      setInterval(() => {
        engine.enqueue(async () => {
          const current = getHealth();
          if (current.status === 'HEALTHY') everHealthy = true;
          if (
            everHealthy &&
            market.publicConnected &&
            c.SYMBOLS.some((symbol) => {
              return (
                market.synchronized.has(symbol) &&
                !market.ready(
                  symbol,
                  Date.now(),
                  c.MARKET_STALE_MS,
                  c.CANDLE_STALE_MS,
                  engine.signals.strategy.warmup,
                  strategyTimeframes(c),
                )
              );
            })
          )
            kill.activate('market data stale');
          if (
            everHealthy &&
            !market.publicConnected &&
            Date.now() - publicDisconnectedAt > c.MARKET_STALE_MS
          )
            kill.activate('market websocket disconnected too long');
          if (
            execution instanceof ExchangeExecutionEngine &&
            everHealthy &&
            !market.privateConnected &&
            Date.now() - privateDisconnectedAt > c.PRIVATE_DISCONNECT_MS
          )
            kill.activate('private websocket disconnected too long');
          if (!db.healthy()) kill.activate('database unavailable');
          if (guard.blocked(engine.equity(), Date.now(), engine.tradingEquity()))
            kill.activate('daily loss limit');
          if (execution instanceof ExchangeExecutionEngine) kill.recoverDemo(c, getHealth());
          if (execution)
            for (const symbol of c.SYMBOLS) {
              const quote = market.books.get(symbol)?.quote();
              if (quote && Date.now() - quote.timestamp <= c.MARKET_STALE_MS)
                await execution.onQuote(symbol, quote);
            }
        });
      }, 1000),
    );
    api = await startApi(c.API_HOST, c.API_PORT, engine.resources(), logger);
    telegram.start();
    if (kill.active) telegram.notify(formatStop(kill.reasons, c.TRADING_MODE));
    publicData.start();
    db.save('events', randomUUID(), { event: 'startup', mode: c.TRADING_MODE, symbols: c.SYMBOLS });
    logger.info({
      event: 'app.started',
      mode: c.TRADING_MODE,
      symbols: c.SYMBOLS,
      telegram: telegram.enabled,
    });
    return { engine, market, logger, stop };
  } catch (err) {
    engine.stopEntries();
    for (const t of timers) clearInterval(t);
    publicData.stop();
    privateData?.stop();
    await telegram.stop();
    await api?.stop();
    db.close();
    lock.release();
    throw err;
  }
}
