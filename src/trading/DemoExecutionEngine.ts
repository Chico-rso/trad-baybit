import { ExchangeExecutionEngine } from './ExchangeExecutionEngine.js';

export class DemoExecutionEngine extends ExchangeExecutionEngine {
  constructor(...args: ConstructorParameters<typeof ExchangeExecutionEngine>) {
    if (args[0].TRADING_MODE !== 'demo' || args[0].ENABLE_LIVE_TRADING !== false)
      throw new Error('Demo execution requires demo mode and live trading disabled');
    super(...args);
  }
}
