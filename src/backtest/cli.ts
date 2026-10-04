import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { parseEnv } from '../config/env.js';
import { runBacktest, validateHistory } from './runner.js';
import type { Instrument } from '../exchange/bybit/types.js';
const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
loadDotenv({ quiet: true });
try {
  const file = arg('--file', 'fixtures/demo-candles.json');
  const metadata = arg(
    '--instruments',
    file === 'fixtures/demo-candles.json'
      ? 'fixtures/demo-instruments.json'
      : file + '.instruments.json',
  );
  const c = parseEnv({
    ...process.env,
    TRADING_MODE: 'paper',
    ENABLE_LIVE_TRADING: 'false',
    BYBIT_API_KEY: '',
    BYBIT_API_SECRET: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    ...(process.argv.includes('--order-type')
      ? { ENTRY_ORDER_TYPE: arg('--order-type', 'Limit') }
      : {}),
    ...(process.argv.includes('--strategy') ? { STRATEGY: arg('--strategy', 'scalping') } : {}),
  });
  const bars = validateHistory(JSON.parse(readFileSync(file, 'utf8')));
  const raw = z
    .array(
      z.object({
        symbol: z.string(),
        tickSize: z.string(),
        qtyStep: z.string(),
        minOrderQty: z.string(),
        maxOrderQty: z.string(),
        maxMarketOrderQty: z.string(),
        minNotional: z.string(),
        maxLeverage: z.number(),
      }),
    )
    .parse(JSON.parse(readFileSync(metadata, 'utf8')));
  const instruments = new Map<string, Instrument>(raw.map((i) => [i.symbol, i]));
  for (const symbol of new Set(bars.map((b) => b.symbol)))
    if (!instruments.has(symbol)) throw new Error(`Missing instrument metadata: ${symbol}`);
  const split = Number(arg('--split', '0.7'));
  if (!(split > 0 && split < 1)) throw new Error('--split must be between 0 and 1');
  const timestamps = [...new Set(bars.map((b) => b.start))];
  const boundary = process.argv.includes('--validation-start')
    ? Date.parse(arg('--validation-start', ''))
    : timestamps[Math.floor(timestamps.length * split)]!;
  if (!Number.isFinite(boundary)) throw new Error('Invalid validation boundary');
  const training = bars.filter((b) => b.start < boundary),
    validation = bars.filter((b) => b.start >= boundary);
  if (!training.length || !validation.length)
    throw new Error('Training and validation must both contain data');
  const trainingResult = await runBacktest(training, c, instruments);
  // Independent positions/equity/guards; earlier candles only warm up indicators.
  const validationResult = await runBacktest(bars, c, instruments, boundary);
  const report = {
    dataSource: resolve(file),
    syntheticDemo: file === 'fixtures/demo-candles.json',
    validationStart: new Date(boundary).toISOString(),
    parameters: {
      strategy: c.STRATEGY,
      orderType: c.ENTRY_ORDER_TYPE,
      riskPercent: c.RISK_PER_TRADE_PERCENT,
      minScore: c.MIN_SIGNAL_SCORE,
      makerFeeBps: c.MAKER_FEE_BPS,
      takerFeeBps: c.TAKER_FEE_BPS,
      slippageBps: c.SLIPPAGE_BPS,
      spreadBps: c.BACKTEST_SPREAD_BPS,
    },
    training: trainingResult,
    validation: validationResult,
  };
  const output = arg('--out', 'backtest-results/report.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        syntheticDemo: report.syntheticDemo,
        validationStart: report.validationStart,
        training: trainingResult.stats,
        validation: validationResult.stats,
        assumptions: validationResult.assumptions,
        report: resolve(output),
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Backtest failed');
  process.exitCode = 1;
}
