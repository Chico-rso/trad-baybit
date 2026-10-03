import { ExchangeExecutionEngine } from './ExchangeExecutionEngine.js';
export class TestnetExecutionEngine extends ExchangeExecutionEngine {
  constructor(...args: ConstructorParameters<typeof ExchangeExecutionEngine>) {
    if (args[0].TRADING_MODE !== 'testnet')
      throw new Error('Testnet execution requires testnet mode');
    super(...args);
  }
}
