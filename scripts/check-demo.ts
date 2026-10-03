import { parseEnv, endpoints } from '../src/config/env.js';
import { BybitRestClient } from '../src/exchange/bybit/BybitRestClient.js';
import { BybitClient } from '../src/exchange/bybit/BybitClient.js';
import { createLogger, registerSecrets } from '../src/utils/logger.js';

registerSecrets([process.env.BYBIT_API_KEY ?? '', process.env.BYBIT_API_SECRET ?? '']);
const logger = createLogger('warn');
try {
  const c = parseEnv({ ...process.env, TRADING_MODE: 'demo' });
  const client = new BybitClient(new BybitRestClient(c, logger));
  await client.rest.synchronizeClock();
  await client.validateAccount();
  const [equity, positions, orders] = await Promise.all([
    client.equity(),
    client.positions(),
    client.orders(),
  ]);
  console.log(
    JSON.stringify(
      {
        mode: 'demo',
        endpoint: endpoints(c).rest,
        accountVerified: true,
        equityUSDT: equity,
        openPositions: positions.filter((p) => Number(p.size) > 0).length,
        openOrders: orders.length,
        ordersSent: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  logger.error({ event: 'demo.check.failed', error });
  process.exitCode = 1;
}
