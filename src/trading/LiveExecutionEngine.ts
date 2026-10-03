import { ExchangeExecutionEngine } from './ExchangeExecutionEngine.js';
export class LiveExecutionEngine extends ExchangeExecutionEngine {
  constructor(...args: ConstructorParameters<typeof ExchangeExecutionEngine>) {
    if (args[0].TRADING_MODE !== 'live' || args[0].ENABLE_LIVE_TRADING !== true)
      throw new Error('Live execution disabled');
    super(...args);
  }
}
