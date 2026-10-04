import { randomUUID } from 'node:crypto';
import type { Candle, Quote, Signal, Side } from '../exchange/bybit/types.js';
import type { Config } from '../config/env.js';
import { ema } from '../indicators/ema.js';
import { rsi } from '../indicators/rsi.js';
import { atr } from '../indicators/atr.js';
import { vwap } from '../indicators/vwap.js';
import { sma } from '../indicators/volume.js';
import { SignalScore } from './SignalScore.js';
export class ScalpingStrategy {
  readonly warmup: number;
  private readonly scorer: SignalScore;
  constructor(private readonly c: Config) {
    this.warmup = Math.max(
      c.EMA_TREND + 10,
      c.ATR_PERIOD + 1,
      c.RSI_PERIOD + 1,
      c.VOLUME_PERIOD + 1,
    );
    this.scorer = new SignalScore(c);
  }
  evaluate(
    symbol: string,
    one: Candle[],
    five: Candle[],
    quote: Quote,
    timestamp: number,
  ): Signal[] {
    one = one.filter((c) => c.confirmed && c.start + 60000 <= timestamp);
    five = five.filter((c) => c.confirmed && c.start + 300000 <= timestamp);
    if (one.length < this.warmup || five.length < this.warmup) return [];
    const c = this.c,
      last = one.at(-1)!;
    const close = one.map((v) => v.close),
      trend = five.map((v) => v.close);
    const snapshot = {
      price: last.close,
      ema9: ema(close, c.EMA_FAST)!,
      ema21: ema(close, c.EMA_SLOW)!,
      ema50: ema(close, c.EMA_TREND)!,
      rsi: rsi(close, c.RSI_PERIOD)!,
      atr: atr(one, c.ATR_PERIOD)!,
      vwap: vwap(one)!,
      volume: last.volume,
      volumeAverage: sma(
        one.slice(0, -1).map((v) => v.volume),
        c.VOLUME_PERIOD,
      )!,
      spread: ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 10000,
      imbalance: quote.imbalance,
      trendEma21: ema(trend, c.EMA_SLOW)!,
      trendEma50: ema(trend, c.EMA_TREND)!,
    };
    if (Object.values(snapshot).some((v) => !Number.isFinite(v)) || snapshot.atr <= 0) return [];
    return (['Long', 'Short'] as Side[]).map((side) => {
      const long = side === 'Long',
        direction = long ? 1 : -1;
      const factors = {
        trend: long
          ? snapshot.trendEma21 > snapshot.trendEma50
          : snapshot.trendEma21 < snapshot.trendEma50,
        ema: long ? snapshot.ema9 > snapshot.ema21 : snapshot.ema9 < snapshot.ema21,
        vwap: long ? last.close > snapshot.vwap : last.close < snapshot.vwap,
        rsi:
          snapshot.rsi >= (long ? c.RSI_LONG_MIN : c.RSI_SHORT_MIN) &&
          snapshot.rsi <= (long ? c.RSI_LONG_MAX : c.RSI_SHORT_MAX),
        volume: last.volume >= snapshot.volumeAverage * c.VOLUME_MULTIPLIER,
        book: long
          ? quote.imbalance >= c.BOOK_IMBALANCE_MIN
          : quote.imbalance <= 1 / c.BOOK_IMBALANCE_MIN,
        spread: snapshot.spread <= c.MAX_SPREAD_BPS,
      };
      const score = this.scorer.calculate(factors);
      const entry =
        c.ENTRY_ORDER_TYPE === 'Limit'
          ? long
            ? quote.bid
            : quote.ask
          : long
            ? quote.ask
            : quote.bid;
      const stopLoss = entry - direction * snapshot.atr * c.SL_ATR_MULTIPLIER,
        takeProfit = entry + direction * snapshot.atr * c.TP_ATR_MULTIPLIER;
      const rejections = score.failed.map((k) => `${k} insufficient`);
      const hard: string[] = [];
      if (!factors.trend) hard.push('5m trend unconfirmed');
      if (!factors.ema) hard.push('EMA structure unconfirmed');
      if (!factors.spread) hard.push('spread too high');
      if ((snapshot.atr / last.close) * 100 > c.MAX_ATR_PERCENT)
        hard.push('ATR volatility too high');
      if (score.score < c.MIN_SIGNAL_SCORE)
        hard.push(`score ${score.score} < ${c.MIN_SIGNAL_SCORE}`);
      if (score.confirmations < c.MIN_CONFIRMATIONS)
        hard.push('insufficient independent confirmations');
      if (Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss) < c.MIN_RR)
        hard.push('risk reward too low');
      return {
        id: randomUUID(),
        strategy: 'scalping',
        symbol,
        timestamp,
        candleStart: last.start,
        side,
        entry,
        stopLoss,
        takeProfit,
        score: score.score,
        decision: hard.length ? 'rejected' : 'accepted',
        reasons: score.passed.map((k) => `${k} confirmed`),
        rejections: [...hard, ...rejections],
        snapshot,
      };
    });
  }
}
