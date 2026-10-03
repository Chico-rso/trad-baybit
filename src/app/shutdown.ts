import type { TradingEngine } from '../trading/TradingEngine.js';
import type { Logger } from '../utils/logger.js';
export function installShutdown(
  stop: () => Promise<void>,
  engine: TradingEngine,
  logger: Logger,
): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    engine.stopEntries();
    logger.info({ event: 'shutdown.started' });
    void stop().catch((err) => {
      logger.error({ event: 'shutdown.failed', error: err });
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
