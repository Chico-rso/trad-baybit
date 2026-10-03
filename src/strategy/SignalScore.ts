import type { Config } from '../config/env.js';
export interface Factors {
  trend: boolean;
  ema: boolean;
  vwap: boolean;
  rsi: boolean;
  volume: boolean;
  book: boolean;
  spread: boolean;
}
export class SignalScore {
  private readonly weights: Record<keyof Factors, number>;
  constructor(c: Config) {
    this.weights = {
      trend: c.WEIGHT_TREND,
      ema: c.WEIGHT_EMA,
      vwap: c.WEIGHT_VWAP,
      rsi: c.WEIGHT_RSI,
      volume: c.WEIGHT_VOLUME,
      book: c.WEIGHT_BOOK,
      spread: c.WEIGHT_SPREAD,
    };
  }
  calculate(factors: Factors): {
    score: number;
    confirmations: number;
    passed: string[];
    failed: string[];
  } {
    const keys = Object.keys(this.weights) as (keyof Factors)[];
    const total = keys.reduce((s, k) => s + this.weights[k], 0);
    const earned = keys.reduce((s, k) => s + (factors[k] ? this.weights[k] : 0), 0);
    return {
      score: Math.round((100 * earned) / total),
      confirmations: keys.filter((k) => factors[k] && k !== 'spread').length,
      passed: keys.filter((k) => factors[k]),
      failed: keys.filter((k) => !factors[k]),
    };
  }
}
