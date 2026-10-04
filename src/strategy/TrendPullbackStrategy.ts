import { randomUUID } from 'node:crypto';
import type { Config } from '../config/env.js';
import type { Candle, Quote, Signal, Side } from '../exchange/bybit/types.js';
import { ema } from '../indicators/ema.js';
import { atr } from '../indicators/atr.js';
import { rsi } from '../indicators/rsi.js';
import { vwap } from '../indicators/vwap.js';
import { sma } from '../indicators/volume.js';

export class TrendPullbackStrategy {
  readonly warmup: number;
  constructor(private readonly c: Config) {
    this.warmup = Math.max(
      c.EMA_TREND + 10,
      c.ATR_PERIOD + 1,
      c.RSI_PERIOD + 1,
      c.VOLUME_PERIOD + 1,
      c.PULLBACK_LOOKBACK + 3,
    );
  }
  evaluate(
    symbol: string,
    entryBars: Candle[],
    trendBars: Candle[],
    quote: Quote,
    now: number,
  ): Signal[] {
    const closed = (bars: Candle[], interval: 15 | 60) =>
      bars.filter(
        (b) =>
          b.symbol === symbol &&
          b.interval === interval &&
          b.confirmed &&
          b.start + interval * 60000 <= now,
      );
    const entry = closed(entryBars, 15),
      trend = closed(trendBars, 60);
    const contiguous = (bars: Candle[], interval: number) => {
      const recent = bars.slice(-this.warmup);
      return (
        recent.length === this.warmup &&
        recent.every(
          (b, i) =>
            b.start % (interval * 60000) === 0 &&
            (i === 0 || b.start - recent[i - 1]!.start === interval * 60000),
        )
      );
    };
    if (!contiguous(entry, 15) || !contiguous(trend, 60)) return [];
    const last = entry.at(-1)!,
      previous = entry.at(-2)!;
    if (
      last.start !== Math.floor(now / 900000) * 900000 - 900000 ||
      trend.at(-1)!.start !== Math.floor(now / 3600000) * 3600000 - 3600000 ||
      now - (last.start + 900000) > this.c.CANDLE_STALE_MS
    )
      return [];
    const c = this.c,
      closes = entry.map((b) => b.close),
      hours = trend.map((b) => b.close);
    const volatility = atr(entry, c.ATR_PERIOD)!,
      hourlyAtr = atr(trend, c.ATR_PERIOD)!;
    const snapshot: Signal['snapshot'] = {
      price: last.close,
      ema9: ema(closes, c.EMA_FAST)!,
      ema21: ema(closes, c.EMA_SLOW)!,
      ema50: ema(closes, c.EMA_TREND)!,
      rsi: rsi(closes, c.RSI_PERIOD)!,
      atr: volatility,
      vwap: vwap(entry)!,
      volume: last.volume,
      volumeAverage: sma(
        entry.slice(0, -1).map((b) => b.volume),
        c.VOLUME_PERIOD,
      )!,
      spread: ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 10000,
      imbalance: quote.imbalance,
      trendEma21: ema(hours, c.EMA_SLOW)!,
      trendEma50: ema(hours, c.EMA_TREND)!,
    };
    if (
      Object.values(snapshot).some((v) => !Number.isFinite(v)) ||
      volatility <= 0 ||
      !Number.isFinite(hourlyAtr) ||
      hourlyAtr <= 0 ||
      quote.bid <= 0 ||
      quote.ask < quote.bid
    )
      return [];
    const priorTrendEma = ema(hours.slice(0, -3), c.EMA_SLOW)!;
    const pullback = entry.slice(-c.PULLBACK_LOOKBACK - 1, -1);
    return (['Long', 'Short'] as Side[]).map((side) => {
      const direction = side === 'Long' ? 1 : -1;
      const price =
        c.ENTRY_ORDER_TYPE === 'Limit'
          ? direction === 1
            ? quote.bid
            : quote.ask
          : direction === 1
            ? quote.ask
            : quote.bid;
      const reasons: string[] = [],
        rejections: string[] = [];
      const require = (ok: boolean, good: string, bad: string) =>
        (ok ? reasons : rejections).push(ok ? good : bad);
      require(direction * (snapshot.trendEma21 - snapshot.trendEma50) >=
        hourlyAtr * c.PULLBACK_MIN_TREND_ATR &&
        direction * (snapshot.trendEma21 - priorTrendEma) > 0 &&
        direction * (hours.at(-1)! - snapshot.trendEma50) >
          0, 'hourly trend confirmed', '1h trend unconfirmed');
      require(direction * (snapshot.ema21 - snapshot.ema50) >
        0, 'entry trend confirmed', '15m trend unconfirmed');
      const touched = pullback.some((bar, i) => {
        const index = entry.length - c.PULLBACK_LOOKBACK - 1 + i;
        const average = ema(closes.slice(0, index + 1), c.EMA_SLOW)!;
        return bar.low <= average + 0.25 * volatility && bar.high >= average - 0.25 * volatility;
      });
      require(touched, 'pullback confirmed', 'EMA pullback missing');
      require(direction * (last.close - last.open) > 0 &&
        (direction === 1 ? last.close > previous.high : last.close < previous.low) &&
        direction * (last.close - snapshot.ema21) >
          0, 'recovery confirmed', 'pullback recovery unconfirmed');
      require(Math.abs(price - snapshot.ema21) <= c.PULLBACK_MAX_EXTENSION_ATR * volatility &&
        Math.abs(price - last.close) <=
          0.5 * volatility, 'extension confirmed', 'entry extended from EMA');
      require(snapshot.rsi >= (direction === 1 ? c.RSI_LONG_MIN : c.RSI_SHORT_MIN) &&
        snapshot.rsi <=
          (direction === 1
            ? c.RSI_LONG_MAX
            : c.RSI_SHORT_MAX), 'rsi confirmed', 'rsi insufficient');
      require(snapshot.spread <= c.MAX_SPREAD_BPS, 'spread confirmed', 'spread too high');
      require(now >= quote.timestamp &&
        now - quote.timestamp <= c.MARKET_STALE_MS, 'quote confirmed', 'quote stale');
      require((volatility / last.close) * 100 <=
        c.MAX_ATR_PERCENT, 'volatility confirmed', 'ATR volatility too high');
      const extreme =
        direction === 1
          ? Math.min(...pullback.map((b) => b.low), last.low)
          : Math.max(...pullback.map((b) => b.high), last.high);
      const distance = Math.max(
        volatility * c.PULLBACK_SL_ATR,
        direction * (price - extreme) + 0.2 * volatility,
      );
      const stopLoss = price - direction * distance,
        takeProfit = price + direction * distance * c.PULLBACK_REWARD_R;
      const costs = (price * (2 * c.TAKER_FEE_BPS + 2 * c.SLIPPAGE_BPS)) / 10000;
      const netRR = (distance * c.PULLBACK_REWARD_R - costs) / (distance + costs);
      require(netRR >= c.PULLBACK_MIN_NET_RR &&
        distance >= 3 * costs &&
        c.PULLBACK_REWARD_R >= c.MIN_RR &&
        stopLoss > 0 &&
        takeProfit > 0, 'costs confirmed', 'net risk reward too low');
      return {
        id: randomUUID(),
        strategy: 'trend-pullback',
        symbol,
        side,
        timestamp: now,
        candleStart: last.start,
        entry: price,
        stopLoss,
        takeProfit,
        score: Math.round((reasons.length / (reasons.length + rejections.length)) * 100),
        decision: rejections.length ? 'rejected' : 'accepted',
        reasons,
        rejections,
        snapshot,
        protection: {
          breakevenEnabled: true,
          breakevenTriggerR: 1.5,
          trailingStopEnabled: false,
          trailingAtrMultiplier: c.TRAILING_ATR_MULTIPLIER,
        },
      };
    });
  }
}
