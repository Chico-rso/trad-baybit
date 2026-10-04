import type { Config } from '../config/env.js';
import type { Instrument, Position, Quote } from '../exchange/bybit/types.js';
import { normalizePrice } from '../utils/math.js';
export function moveProtection(
  position: Position,
  quote: Quote,
  config: Config,
  instrument: Instrument,
): Position {
  const p = structuredClone(position),
    long = p.side === 'Long',
    direction = long ? 1 : -1,
    price = long ? quote.bid : quote.ask,
    tick = Number(instrument.tickSize);
  // The exchange may still be publishing fills for a triggered native SL/TP.
  if (
    long
      ? price <= p.stopLoss || price >= p.takeProfit
      : price >= p.stopLoss || price <= p.takeProfit
  )
    return p;
  const initialRisk = Math.abs(p.entry - p.initialStopLoss),
    profit = (price - p.entry) * direction;
  const policy = p.signal.protection;
  const costs = (p.entry * (config.TAKER_FEE_BPS * 2 + config.SLIPPAGE_BPS)) / 10000;
  const breakeven = Number(
    normalizePrice(p.entry + direction * costs, instrument.tickSize, long ? 'up' : 'down'),
  );
  const trigger = Math.max(
    initialRisk * (policy?.breakevenTriggerR ?? config.BREAKEVEN_TRIGGER_R),
    Math.abs(breakeven - p.entry) + tick,
  );
  if ((policy?.breakevenEnabled ?? config.BREAKEVEN_ENABLED) && !p.breakeven && profit >= trigger) {
    p.stopLoss = long ? Math.max(p.stopLoss, breakeven) : Math.min(p.stopLoss, breakeven);
    p.breakeven = true;
  }
  if (policy?.trailingStopEnabled ?? config.TRAILING_STOP_ENABLED) {
    p.trailingAnchor = long ? Math.max(p.trailingAnchor, price) : Math.min(p.trailingAnchor, price);
    const candidate =
      p.trailingAnchor -
      direction *
        p.signal.snapshot.atr *
        (policy?.trailingAtrMultiplier ?? config.TRAILING_ATR_MULTIPLIER);
    const bounded = long ? Math.min(candidate, price - tick) : Math.max(candidate, price + tick);
    const stop = Number(normalizePrice(bounded, instrument.tickSize, long ? 'down' : 'up'));
    p.stopLoss = long ? Math.max(p.stopLoss, stop) : Math.min(p.stopLoss, stop);
  }
  return p;
}
