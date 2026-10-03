import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from '../config/env.js';
import { BybitRestClient } from '../exchange/bybit/BybitRestClient.js';
import { BybitClient } from '../exchange/bybit/BybitClient.js';
import { createLogger } from '../utils/logger.js';
import type { Candle } from '../exchange/bybit/types.js';
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
try {
  const symbol = arg('--symbol', 'BTCUSDT'),
    days = Number(arg('--days', '7')),
    network = arg('--network', 'testnet');
  if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error('--days must be 0..90');
  const c = parseEnv({ SYMBOLS: symbol, MARKET_DATA_NETWORK: network });
  const client = new BybitClient(new BybitRestClient(c, createLogger('warn'))),
    instrument = await client.instrument(symbol);
  const end = Date.now(),
    start = end - days * 86400000;
  let cursor = end;
  const rows = new Map<number, Candle>();
  while (cursor > start) {
    const batch = await client.candles(symbol, 1, 1000, cursor);
    if (!batch.length) break;
    for (const candle of batch) if (candle.start >= start) rows.set(candle.start, candle);
    const next = batch[0]!.start - 1;
    if (next >= cursor) throw new Error('Historical cursor did not advance');
    cursor = next;
  }
  if (!rows.size) throw new Error('No historical candles returned');
  const file = arg('--out', `data/${symbol}-1m.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...rows.values()].sort((a, b) => a.start - b.start)));
  writeFileSync(file + '.instruments.json', JSON.stringify([instrument], null, 2));
  console.log(
    JSON.stringify({
      file: resolve(file),
      network,
      symbol,
      candles: rows.size,
      metadata: resolve(file + '.instruments.json'),
    }),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : 'History download failed');
  process.exitCode = 1;
}
