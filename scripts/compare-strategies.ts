import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv, strategyTimeframes } from '../src/config/env.js';
import { runBacktest, validateHistory } from '../src/backtest/runner.js';
import type { Instrument } from '../src/exchange/bybit/types.js';

// Offline only: no .env loading, exchange clients, credentials or preset selection.
const symbols = ['SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'HYPEUSDT', 'SANDUSDT'];
const histories = symbols.map((symbol) => {
  const file = `data/research-${symbol}-1m.json`;
  const bars = validateHistory(JSON.parse(readFileSync(file, 'utf8')));
  if (bars.some((bar) => bar.symbol !== symbol)) throw new Error(`Unexpected symbol in ${file}`);
  const metadata = JSON.parse(readFileSync(`${file}.instruments.json`, 'utf8')) as Instrument[];
  const instrument = metadata.find((item) => item.symbol === symbol);
  if (!instrument) throw new Error(`Missing instrument metadata: ${symbol}`);
  return { symbol, file: resolve(file), bars, instrument };
});
const instruments = new Map(histories.map((history) => [history.symbol, history.instrument]));
const start = Math.max(...histories.map((history) => history.bars[0]!.start));
const end = Math.min(...histories.map((history) => history.bars.at(-1)!.start)) + 60000;
const holdoutStart = end - 2 * 86400000;
// Keep at least 60 complete hourly candles before the holdout; no positions cross the split.
if (holdoutStart - start < 60 * 3600000)
  throw new Error('History requires at least 60 hours of warmup before the final two-day holdout');
const bars = histories
  .flatMap((history) => history.bars)
  .filter((bar) => bar.start >= start && bar.start < end)
  .sort((a, b) => a.start - b.start || a.symbol.localeCompare(b.symbol));
const common = {
  TRADING_MODE: 'demo',
  DEMO_CONTINUOUS_TESTING: 'true',
  ENABLE_LIVE_TRADING: 'false',
  // These placeholders only satisfy mode validation. Replay always uses PaperExecutionEngine.
  BYBIT_API_KEY: 'offline-unused',
  BYBIT_API_SECRET: 'offline-unused',
  SYMBOLS: symbols.join(','),
  PAPER_INITIAL_EQUITY: 119.78,
  TRADING_CAPITAL_USDT: 119.78,
  RISK_PER_TRADE_PERCENT: 2,
  MAX_OPEN_POSITIONS: 20,
  LEVERAGE: 1,
  ENTRY_ORDER_TYPE: 'Limit',
  POST_ONLY: 'false',
  ORDER_TIMEOUT_SECONDS: 60,
};
const presets = [
  { STRATEGY: 'scalping', MIN_SIGNAL_SCORE: 65, SL_ATR_MULTIPLIER: 2, TP_ATR_MULTIPLIER: 4 },
  { STRATEGY: 'trend-pullback' },
] as const;
type Result = Awaited<ReturnType<typeof runBacktest>>;
const compact = (result: Result) => ({
  stats: result.stats,
  signals: result.signals,
  assumptions: result.assumptions,
});
const comparisons = [];
for (const preset of presets) {
  const config = parseEnv({ ...common, ...preset });
  const training = compact(
    await runBacktest(
      bars.filter((bar) => bar.start < holdoutStart),
      config,
      instruments,
    ),
  );
  const holdout = compact(await runBacktest(bars, config, instruments, holdoutStart));
  const comparison = {
    strategy: config.STRATEGY,
    timeframesMinutes: strategyTimeframes(config),
    preset,
    training,
    holdout,
  };
  comparisons.push(comparison);
  console.log(JSON.stringify(comparison));
}
const report = {
  createdAt: new Date().toISOString(),
  sources: histories.map((history) => history.file),
  symbols,
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  holdoutStart: new Date(holdoutStart).toISOString(),
  common: { ...common, BYBIT_API_KEY: undefined, BYBIT_API_SECRET: undefined },
  comparisons,
  limitations: [
    'Both presets fixed before running; no tuning or selection from the final two-day holdout.',
    'Short exploratory historical sample, not evidence of reliable future profitability.',
    'No historical order book: neutral imbalance, fixed spread and approximate minute-based limit fills.',
    'Funding is not modeled; entry and exit fees, spread and configured slippage are modeled.',
    'Adverse intrabar extreme precedes favorable extreme; replay cannot recover actual tick ordering.',
    'Warmup only before holdout; positions, equity and guards reset independently for each replay.',
    'DEMO continuous-testing loss-guard policy is the same for both presets; margin and order checks remain.',
  ],
};
const rows = comparisons.flatMap((comparison) =>
  (['training', 'holdout'] as const).map((period) => {
    const stats = comparison[period].stats;
    return `| ${comparison.strategy} | ${period} | ${stats.totalTrades} | ${stats.netPnL.toFixed(4)} | ${stats.fees.toFixed(4)} | ${stats.winRate.toFixed(1)}% | ${stats.profitFactor?.toFixed(3) ?? 'n/a'} | ${stats.maxDrawdownPercent.toFixed(2)}% |`;
  }),
);
const markdown = [
  '# Fixed strategy comparison',
  '',
  `History: ${report.start} – ${report.end}. Final two-day holdout starts ${report.holdoutStart}.`,
  '',
  `Initial equity: 119.78 USDT. Limit GTC, timeout 60s, leverage 1, risk 2%, maximum 20 positions.`,
  '',
  '| Strategy | Period | Trades | Net PnL USDT | Fees USDT | Win rate | Profit factor | Max drawdown |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows,
  '',
  ...report.limitations.map((limitation) => `- ${limitation}`),
  '',
].join('\n');
mkdirSync('backtest-results', { recursive: true });
writeFileSync('backtest-results/strategy-comparison.json', JSON.stringify(report, null, 2));
writeFileSync('backtest-results/strategy-comparison.md', markdown);
