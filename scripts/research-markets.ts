import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseEnv } from '../src/config/env.js';
import { runBacktest, validateHistory } from '../src/backtest/runner.js';
import type { Instrument } from '../src/exchange/bybit/types.js';

// This offline research does not load .env, credentials or contact the exchange.
const symbols = ['SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'SUIUSDT', 'HYPEUSDT', 'SANDUSDT'];
const presets = [
  {
    name: 'baseline',
    MIN_SIGNAL_SCORE: 70,
    SL_ATR_MULTIPLIER: 1.2,
    TP_ATR_MULTIPLIER: 1.8,
    ORDER_TIMEOUT_SECONDS: 20,
  },
  {
    name: 'balanced',
    MIN_SIGNAL_SCORE: 65,
    SL_ATR_MULTIPLIER: 2,
    TP_ATR_MULTIPLIER: 4,
    ORDER_TIMEOUT_SECONDS: 60,
  },
  {
    name: 'wider',
    MIN_SIGNAL_SCORE: 65,
    SL_ATR_MULTIPLIER: 2,
    TP_ATR_MULTIPLIER: 6,
    ORDER_TIMEOUT_SECONDS: 60,
  },
];
const history = symbols.map((symbol) => ({
  symbol,
  bars: validateHistory(JSON.parse(readFileSync(`data/research-${symbol}-1m.json`, 'utf8'))),
  instrument: (
    JSON.parse(
      readFileSync(`data/research-${symbol}-1m.json.instruments.json`, 'utf8'),
    ) as Instrument[]
  )[0]!,
}));
const allBars = history
  .flatMap((h) => h.bars)
  .sort((a, b) => a.start - b.start || a.symbol.localeCompare(b.symbol));
const instruments = new Map(history.map((h) => [h.symbol, h.instrument]));
const start = Math.max(...history.map((h) => h.bars[0]!.start));
const end = Math.min(...history.map((h) => h.bars.at(-1)!.start));
const boundary = end - 2 * 86400000;
const bars = allBars.filter((b) => b.start >= start && b.start <= end);
const base = {
  TRADING_MODE: 'paper',
  PAPER_INITIAL_EQUITY: 23.95,
  TRADING_CAPITAL_USDT: 23.95,
  SYMBOLS: symbols.join(','),
  LEVERAGE: 1,
  POST_ONLY: String(!process.argv.includes('--gtc')),
};
const training = [];
for (const preset of presets) {
  const config = parseEnv({ ...base, ...preset });
  const result = await runBacktest(
    bars.filter((b) => b.start < boundary),
    config,
    instruments,
  );
  training.push({ preset, result });
  console.log(
    JSON.stringify({
      stage: 'training',
      preset: preset.name,
      ...result.stats,
      signals: result.signals,
    }),
  );
}
// Freeze the choice before touching the final two days. Do not tune on the holdout.
const withTrades = training.filter((t) => t.result.stats.totalTrades > 0);
const selected = [...(withTrades.length ? withTrades : training)].sort(
  (a, b) => b.result.stats.netPnL - a.result.stats.netPnL,
)[0]!;
const validation = await runBacktest(
  bars,
  parseEnv({ ...base, ...selected.preset }),
  instruments,
  boundary,
);
const passed =
  selected.result.stats.netPnL > 0 &&
  validation.stats.netPnL > 0 &&
  validation.stats.totalTrades >= 10;
const report = {
  createdAt: new Date().toISOString(),
  start: new Date(start).toISOString(),
  end: new Date(end + 60000).toISOString(),
  validationStart: new Date(boundary).toISOString(),
  base,
  training,
  selected: selected.preset,
  validation,
  passed,
  limitations: [
    'Selection excludes presets without completed trades; a negative selected result is not a recommendation for real-money trading.',
    'Seven days is a short exploratory sample, not proof of profitability.',
    'No historical order book; neutral imbalance and fixed 2 bps spread.',
    'Funding is not modeled.',
    'A single portfolio, one simultaneous position and persistent loss guards.',
  ],
};
mkdirSync('backtest-results', { recursive: true });
writeFileSync(
  process.argv.includes('--gtc')
    ? 'backtest-results/market-research-gtc.json'
    : 'backtest-results/market-research.json',
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    stage: 'validation',
    selected: selected.preset.name,
    passed,
    ...validation.stats,
    signals: validation.signals,
  }),
);
