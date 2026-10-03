import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(String(fallback) as 'true' | 'false')
    .transform((v) => v === 'true');
const num = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().finite().min(min).max(max).default(fallback);
const integer = (fallback: number, min = 1, max = 10000) =>
  num(fallback, min, max).refine(Number.isInteger, 'must be an integer');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  TRADING_MODE: z.enum(['signal', 'paper', 'testnet', 'demo', 'live']).default('signal'),
  ENABLE_LIVE_TRADING: bool(false),
  MARKET_DATA_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  BYBIT_API_KEY: z.string().default(''),
  BYBIT_API_SECRET: z.string().default(''),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  SYMBOLS: z
    .string()
    .default('BTCUSDT,ETHUSDT')
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()))])
    .refine(
      (v) => v.length > 0 && v.length <= 20 && v.every((s) => /^[A-Z0-9]+USDT$/.test(s)),
      'invalid USDT symbols',
    ),
  RISK_PER_TRADE_PERCENT: num(0.25, 0.001, 2),
  TRADING_CAPITAL_USDT: z.coerce.number().finite().positive().optional(),
  MAX_DAILY_LOSS_PERCENT: num(2, 0.01, 20),
  MAX_OPEN_POSITIONS: integer(1, 1, 20),
  MAX_CONSECUTIVE_LOSSES: integer(3, 1, 50),
  COOLDOWN_AFTER_LOSS_MINUTES: num(5, 0, 1440),
  SIGNAL_COOLDOWN_SECONDS: num(60, 0, 3600),
  LEVERAGE: num(1, 1, 3),
  MAX_LEVERAGE: num(3, 1, 3),
  MIN_SIGNAL_SCORE: num(70, 0, 100),
  MIN_CONFIRMATIONS: integer(3, 2, 6),
  SL_ATR_MULTIPLIER: num(1.2, 0.1, 10),
  TP_ATR_MULTIPLIER: num(1.8, 0.1, 20),
  MIN_RR: num(1.3, 0.1, 10),
  ORDERBOOK_LEVELS: integer(10, 1, 50),
  ENTRY_ORDER_TYPE: z.enum(['Market', 'Limit']).default('Limit'),
  POST_ONLY: bool(true),
  ORDER_TIMEOUT_SECONDS: num(20, 1, 600),
  MAKER_FEE_BPS: num(2, 0, 100),
  TAKER_FEE_BPS: num(5.5, 0, 100),
  SLIPPAGE_BPS: num(2, 0, 100),
  BACKTEST_SPREAD_BPS: num(2, 0, 100),
  PAPER_INITIAL_EQUITY: num(10000, 1),
  BREAKEVEN_ENABLED: bool(true),
  BREAKEVEN_TRIGGER_R: num(1, 0.1, 10),
  TRAILING_STOP_ENABLED: bool(false),
  TRAILING_ATR_MULTIPLIER: num(1, 0.1, 10),
  AUTO_CLOSE_ON_SHUTDOWN: bool(false),
  EMA_FAST: integer(9, 2, 200),
  EMA_SLOW: integer(21, 2, 200),
  EMA_TREND: integer(50, 2, 300),
  RSI_PERIOD: integer(14, 2, 100),
  ATR_PERIOD: integer(14, 2, 100),
  VOLUME_PERIOD: integer(20, 2, 200),
  RSI_LONG_MIN: num(45, 0, 100),
  RSI_LONG_MAX: num(70, 0, 100),
  RSI_SHORT_MIN: num(30, 0, 100),
  RSI_SHORT_MAX: num(55, 0, 100),
  VOLUME_MULTIPLIER: num(1.1, 0.1, 10),
  BOOK_IMBALANCE_MIN: num(1.15, 1, 10),
  MAX_SPREAD_BPS: num(5, 0.1, 100),
  MAX_ATR_PERCENT: num(1, 0.001, 20),
  WEIGHT_TREND: num(25, 0, 100),
  WEIGHT_EMA: num(20, 0, 100),
  WEIGHT_VWAP: num(15, 0, 100),
  WEIGHT_RSI: num(10, 0, 100),
  WEIGHT_VOLUME: num(15, 0, 100),
  WEIGHT_BOOK: num(10, 0, 100),
  WEIGHT_SPREAD: num(5, 0, 100),
  MARKET_STALE_MS: integer(15000, 1000, 300000),
  CANDLE_STALE_MS: integer(180000, 60000, 900000),
  PRIVATE_DISCONNECT_MS: integer(30000, 1000, 300000),
  EXCHANGE_ERROR_THRESHOLD: integer(5, 1, 100),
  REST_TIMEOUT_MS: integer(10000, 100, 60000),
  RECONCILE_INTERVAL_MS: integer(15000, 1000, 300000),
  API_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  API_PORT: integer(3000, 0, 65535),
  DATABASE_PATH: z.string().min(1).default('data/bot.db'),
});
export type Config = z.infer<typeof schema>;
export type Mode = Config['TRADING_MODE'];
export function runtimeConfig(raw: Record<string, unknown>, requestedMode?: string): Config {
  if (requestedMode === 'live' && raw.TRADING_MODE !== 'live') {
    throw new Error('LIVE requires explicit TRADING_MODE=live in ENV; CLI cannot substitute it');
  }
  return parseEnv({ ...raw, ...(requestedMode ? { TRADING_MODE: requestedMode } : {}) });
}
export function parseEnv(raw: Record<string, unknown>): Config {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`,
    );
  const c = result.data;
  if (c.TRADING_MODE === 'live' && !c.ENABLE_LIVE_TRADING)
    throw new Error('LIVE requires TRADING_MODE=live and ENABLE_LIVE_TRADING=true');
  if (c.TRADING_MODE === 'demo' && c.ENABLE_LIVE_TRADING)
    throw new Error('DEMO requires ENABLE_LIVE_TRADING=false');
  if (
    ['live', 'testnet', 'demo'].includes(c.TRADING_MODE) &&
    (!c.BYBIT_API_KEY || !c.BYBIT_API_SECRET)
  )
    throw new Error('Authenticated execution requires Bybit credentials');
  if (!!c.TELEGRAM_BOT_TOKEN !== !!c.TELEGRAM_CHAT_ID)
    throw new Error('Configure both Telegram credentials or neither');
  if (c.LEVERAGE > c.MAX_LEVERAGE) throw new Error('LEVERAGE exceeds MAX_LEVERAGE');
  if (!(c.EMA_FAST < c.EMA_SLOW && c.EMA_SLOW < c.EMA_TREND))
    throw new Error('EMA periods must increase');
  if (c.RSI_LONG_MIN > c.RSI_LONG_MAX || c.RSI_SHORT_MIN > c.RSI_SHORT_MAX)
    throw new Error('Invalid RSI range');
  if (
    c.WEIGHT_TREND +
      c.WEIGHT_EMA +
      c.WEIGHT_VWAP +
      c.WEIGHT_RSI +
      c.WEIGHT_VOLUME +
      c.WEIGHT_BOOK +
      c.WEIGHT_SPREAD <=
    0
  )
    throw new Error('Score weights must have positive sum');
  return c;
}
export function assertExecutionMode(c: Config): void {
  if (!['testnet', 'demo', 'live'].includes(c.TRADING_MODE))
    throw new Error('Exchange writes forbidden in SIGNAL/PAPER');
  if (c.TRADING_MODE === 'demo' && c.ENABLE_LIVE_TRADING !== false)
    throw new Error('DEMO requires ENABLE_LIVE_TRADING=false');
  if (c.TRADING_MODE === 'live' && c.ENABLE_LIVE_TRADING !== true)
    throw new Error('Live execution disabled');
  if (c.LEVERAGE > Math.min(c.MAX_LEVERAGE, 3)) throw new Error('Unsafe leverage');
}
export function endpoints(c: Config) {
  const live = c.TRADING_MODE === 'live';
  const demo = c.TRADING_MODE === 'demo';
  const publicMainnet =
    live ||
    demo ||
    (['signal', 'paper'].includes(c.TRADING_MODE) && c.MARKET_DATA_NETWORK === 'mainnet');
  return {
    rest: demo
      ? 'https://api-demo.bybit.com'
      : live
        ? 'https://api.bybit.com'
        : 'https://api-testnet.bybit.com',
    publicRest: publicMainnet ? 'https://api.bybit.com' : 'https://api-testnet.bybit.com',
    publicWs: publicMainnet
      ? 'wss://stream.bybit.com/v5/public/linear'
      : 'wss://stream-testnet.bybit.com/v5/public/linear',
    privateWs: demo
      ? 'wss://stream-demo.bybit.com/v5/private'
      : live
        ? 'wss://stream.bybit.com/v5/private'
        : 'wss://stream-testnet.bybit.com/v5/private',
  };
}
