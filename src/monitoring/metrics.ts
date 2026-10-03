import type { Trade } from '../exchange/bybit/types.js';
export function tradeStats(trades: Trade[], initialEquity = 10000) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const wins = trades.filter((t) => t.netPnL > 0),
    losses = trades.filter((t) => t.netPnL < 0);
  const positive = wins.reduce((s, t) => s + t.netPnL, 0),
    negative = -losses.reduce((s, t) => s + t.netPnL, 0);
  let equity = initialEquity,
    peak = equity,
    maxDrawdown = 0,
    maxDrawdownPercent = 0;
  for (const t of sorted) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - equity) / peak) * 100);
  }
  const netPnL = trades.reduce((s, t) => s + t.netPnL, 0);
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakEven: trades.length - wins.length - losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossPnL: trades.reduce((s, t) => s + t.grossPnL, 0),
    fees: trades.reduce((s, t) => s + t.fees, 0),
    estimatedSlippage: trades.reduce((s, t) => s + t.estimatedSlippage, 0),
    netPnL,
    profitFactor: negative > 0 ? positive / negative : null,
    averageWin: wins.length ? positive / wins.length : 0,
    averageLoss: losses.length ? -negative / losses.length : 0,
    maxDrawdown,
    maxDrawdownPercent,
    expectancy: trades.length ? netPnL / trades.length : 0,
  };
}
