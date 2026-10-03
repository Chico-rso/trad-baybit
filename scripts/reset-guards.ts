import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { parseEnv } from '../src/config/env.js';
import { FileLock } from '../src/app/FileLock.js';
import { Journal } from '../src/database/db.js';
import { randomUUID } from 'node:crypto';
loadDotenv({ quiet: true });
try {
  if (!process.argv.includes('--confirm'))
    throw new Error('Explicit --confirm required after inspecting and resolving the kill reason');
  const c = parseEnv(process.env),
    lock = new FileLock(resolve(c.DATABASE_PATH) + '.lock');
  let db: Journal | undefined;
  try {
    db = new Journal(c.DATABASE_PATH);
    const reasons = db.state<string[]>(`kill:${c.TRADING_MODE}`) ?? [];
    db.transaction(() => {
      db!.setState(`kill:${c.TRADING_MODE}`, []);
      db!.save('events', randomUUID(), {
        event: 'kill_switch.operator_reset',
        mode: c.TRADING_MODE,
        previousReasons: reasons,
      });
    });
    console.log(
      'Kill latch reset. Risk statistics, configured loss policy, position ownership and startup reconciliation are preserved.',
    );
  } finally {
    db?.close();
    lock.release();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : 'Guard reset failed');
  process.exitCode = 1;
}
