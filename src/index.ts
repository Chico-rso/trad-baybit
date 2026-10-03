import { config as loadDotenv } from 'dotenv';
import { runtimeConfig } from './config/env.js';
import { bootstrap } from './app/bootstrap.js';
import { installShutdown } from './app/shutdown.js';
import { registerSecrets, createLogger } from './utils/logger.js';

if (!process.argv.includes('--no-env')) loadDotenv({ quiet: true });
registerSecrets([
  process.env.BYBIT_API_KEY ?? '',
  process.env.BYBIT_API_SECRET ?? '',
  process.env.TELEGRAM_BOT_TOKEN ?? '',
]);
try {
  const modeIndex = process.argv.indexOf('--mode');
  const raw = {
    ...process.env,
    ...(modeIndex >= 0 ? { TRADING_MODE: process.argv[modeIndex + 1] } : {}),
  };
  if (modeIndex >= 0 && !process.argv[modeIndex + 1]) throw new Error('Missing --mode value');
  const durationIndex = process.argv.indexOf('--run-seconds');
  const duration = durationIndex >= 0 ? Number(process.argv[durationIndex + 1]) : undefined;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))
    throw new Error('Invalid run duration');
  const c = runtimeConfig(process.env, modeIndex >= 0 ? raw.TRADING_MODE : undefined);
  const app = await bootstrap(c);
  installShutdown(app.stop, app.engine, app.logger);
  if (duration !== undefined) {
    setTimeout(() => {
      void app.stop().catch((err) => {
        app.logger.error({ event: 'shutdown.failed', error: err });
        process.exitCode = 1;
      });
    }, duration * 1000);
  }
} catch (err) {
  createLogger('error').error({ event: 'startup.failed', error: err });
  process.exitCode = 1;
}
