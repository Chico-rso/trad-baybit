import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClosedProfit } from '../monitoring/profit.js';

export const tables = ['signals', 'orders', 'fills', 'positions', 'trades', 'events'] as const;
export type Table = (typeof tables)[number];
export class Journal {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    for (const table of tables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, symbol TEXT, mode TEXT, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_${table}_time ON ${table}(timestamp);`,
      );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version=1;',
    );
  }
  private table(table: Table): Table {
    if (!tables.includes(table)) throw new Error('Invalid table');
    return table;
  }
  save(table: Table, id: string, value: unknown, timestamp = Date.now()): void {
    const v = value as { symbol?: string; mode?: string };
    this.db
      .prepare(
        `INSERT INTO ${this.table(table)} (id,timestamp,symbol,mode,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, symbol=excluded.symbol, mode=excluded.mode`,
      )
      .run(id, timestamp, v.symbol ?? null, v.mode ?? null, JSON.stringify(value));
  }
  insert(table: Table, id: string, value: unknown, timestamp = Date.now()): boolean {
    const v = value as { symbol?: string; mode?: string };
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${this.table(table)} (id,timestamp,symbol,mode,payload) VALUES (?,?,?,?,?)`,
        )
        .run(id, timestamp, v.symbol ?? null, v.mode ?? null, JSON.stringify(value)).changes > 0
    );
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT payload FROM ${this.table(table)} WHERE id=?`).get(id) as
      { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  list<T>(table: Table, limit = 200, mode?: string): T[] {
    const query = mode
      ? `SELECT payload FROM ${this.table(table)} WHERE mode=? ORDER BY timestamp DESC LIMIT ?`
      : `SELECT payload FROM ${this.table(table)} ORDER BY timestamp DESC LIMIT ?`;
    const rows = mode ? this.db.prepare(query).all(mode, limit) : this.db.prepare(query).all(limit);
    return (rows as { payload: string }[]).map((r) => JSON.parse(r.payload) as T);
  }
  profitTotals(mode: string, since = 0, until = Number.MAX_SAFE_INTEGER): ClosedProfit {
    return this.db
      .prepare(
        `
      WITH closed AS (
        SELECT json_extract(payload, '$.netPnL') AS netPnL,
               json_extract(payload, '$.fees') AS fees
        FROM trades
        WHERE mode = ?
          AND json_extract(payload, '$.exitTime') >= ?
          AND json_extract(payload, '$.exitTime') < ?
      )
      SELECT count(*) AS totalTrades,
             coalesce(sum(CASE WHEN netPnL > 0 THEN 1 ELSE 0 END), 0) AS wins,
             coalesce(sum(CASE WHEN netPnL < 0 THEN 1 ELSE 0 END), 0) AS losses,
             coalesce(sum(CASE WHEN netPnL = 0 THEN 1 ELSE 0 END), 0) AS breakEven,
             coalesce(sum(CASE WHEN netPnL > 0 THEN netPnL ELSE 0 END), 0) AS winningPnL,
             coalesce(sum(CASE WHEN netPnL < 0 THEN netPnL ELSE 0 END), 0) AS losingPnL,
             coalesce(sum(netPnL), 0) AS netPnL,
             coalesce(sum(fees), 0) AS fees
      FROM closed
    `,
      )
      .get(mode, since, until) as unknown as ClosedProfit;
  }
  setState(id: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(id, JSON.stringify(value));
  }
  state<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM state WHERE id=?').get(id) as
      { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  healthy(): boolean {
    if (this.closed) return false;
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
