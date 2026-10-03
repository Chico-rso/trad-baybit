import type { Config } from '../config/env.js';
import type { Journal } from '../database/db.js';
import type { MarketState } from '../market/MarketState.js';
export interface Health {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  reasons: string[];
  timestamp: number;
}
export function health(
  c: Config,
  market: MarketState,
  db: Journal,
  warmup: number,
  restLastSuccess: number,
  stateSynchronized: boolean,
  now = Date.now(),
): Health {
  const reasons: string[] = [];
  if (!market.publicConnected) reasons.push('public websocket disconnected');
  if (['testnet', 'demo', 'live'].includes(c.TRADING_MODE) && !market.privateConnected)
    reasons.push('private websocket disconnected');
  if (!db.healthy()) reasons.push('database unavailable');
  if (now - restLastSuccess > Math.max(c.RECONCILE_INTERVAL_MS * 3, 60000))
    reasons.push('REST connectivity stale');
  if (!stateSynchronized) reasons.push('account state unsynchronized');
  for (const symbol of c.SYMBOLS)
    if (!market.ready(symbol, now, c.MARKET_STALE_MS, c.CANDLE_STALE_MS, warmup))
      reasons.push(`${symbol}: market unsynchronized or stale`);
  return {
    status:
      reasons.length === 0
        ? 'HEALTHY'
        : !db.healthy() || !stateSynchronized
          ? 'UNHEALTHY'
          : 'DEGRADED',
    reasons,
    timestamp: now,
  };
}
