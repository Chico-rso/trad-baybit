import type { Mode } from '../config/env.js';
import type { Position, Quote } from '../exchange/bybit/types.js';

export interface ClosedProfit {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winningPnL: number;
  losingPnL: number;
  netPnL: number;
  fees: number;
}

export interface ProfitReport {
  activeStrategy?: { name: 'scalping' | 'trend-pullback'; totals: ClosedProfit };
  mode: Mode;
  allTime: ClosedProfit;
  today: ClosedProfit;
  openPositions: number;
  openPnL: number | null;
  totalPnL: number | null;
  initialCapital: number | null;
  currentCapital: number | null;
  returnPercent: number | null;
}

export function buildProfitReport(input: {
  mode: Mode;
  allTime: ClosedProfit;
  today: ClosedProfit;
  positions: Iterable<Position>;
  quote: (symbol: string) => Quote | undefined;
  now: number;
  marketStaleMs: number;
  positionsSynchronized: boolean;
  initialCapital?: number;
}): ProfitReport {
  const positions = [...input.positions];
  let openPnL: number | null = input.positionsSynchronized ? 0 : null;
  for (const p of positions) {
    if (openPnL === null) break;
    const quote = input.quote(p.symbol);
    if (
      !quote ||
      input.now < quote.timestamp ||
      input.now - quote.timestamp > input.marketStaleMs
    ) {
      openPnL = null;
      break;
    }
    const mark = p.side === 'Long' ? quote.bid : quote.ask;
    openPnL += p.grossPnL - p.fees + (mark - p.entry) * p.quantity * (p.side === 'Long' ? 1 : -1);
  }
  const totalPnL = openPnL === null ? null : input.allTime.netPnL + openPnL;
  const initialCapital = input.initialCapital ?? null;
  return {
    mode: input.mode,
    allTime: input.allTime,
    today: input.today,
    openPositions: positions.length,
    openPnL,
    totalPnL,
    initialCapital,
    currentCapital: initialCapital === null || totalPnL === null ? null : initialCapital + totalPnL,
    returnPercent:
      initialCapital === null || totalPnL === null ? null : (totalPnL / initialCapital) * 100,
  };
}
