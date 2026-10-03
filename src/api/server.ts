import { createServer } from 'node:http';
import type { Logger } from '../utils/logger.js';
export type Resources = Record<
  'status' | 'health' | 'signals' | 'trades' | 'positions' | 'stats' | 'profit',
  () => unknown
>;
export function route(
  method: string,
  path: string,
  resources: Resources,
): { code: number; body: unknown } {
  if (method !== 'GET') return { code: 405, body: { error: 'Read-only API' } };
  const key = path.split('?')[0]?.replace(/^\/api\//, '') as keyof Resources;
  if (!/^\/api\//.test(path) || !Object.prototype.hasOwnProperty.call(resources, key))
    return { code: 404, body: { error: 'Not found' } };
  return { code: 200, body: resources[key]() };
}
export async function startApi(host: string, port: number, resources: Resources, logger: Logger) {
  const server = createServer((req, res) => {
    try {
      const result = route(req.method ?? '', req.url ?? '', resources);
      res.writeHead(result.code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      logger.error({ event: 'api.request.failed', error: err });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'State unavailable' }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  logger.info({
    event: 'api.listening',
    host,
    port: typeof address === 'object' ? address?.port : port,
  });
  return {
    server,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
