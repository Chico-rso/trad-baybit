import type { Config } from '../config/env.js';
import { ScalpingStrategy } from './ScalpingStrategy.js';
import { TrendPullbackStrategy } from './TrendPullbackStrategy.js';

export function createStrategy(config: Config) {
  return config.STRATEGY === 'trend-pullback'
    ? new TrendPullbackStrategy(config)
    : new ScalpingStrategy(config);
}
