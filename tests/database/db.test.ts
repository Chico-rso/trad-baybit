import { describe, expect, it } from 'vitest';
import { Journal } from '../../src/database/db.js';

describe('SQLite journal', () => {
  it('persists records, uniquely deduplicates fill ids and rolls back atomically', () => {
    const db = new Journal(':memory:');
    db.save('orders', 'one', { symbol: 'BTCUSDT', state: 'created' });
    expect(db.get<{ state: string }>('orders', 'one')?.state).toBe('created');
    expect(db.insert('fills', 'exec-1', { quantity: 1 })).toBe(true);
    expect(db.insert('fills', 'exec-1', { quantity: 2 })).toBe(false);
    expect(() =>
      db.transaction(() => {
        db.save('orders', 'two', {});
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.get('orders', 'two')).toBeUndefined();
    db.setState('risk', { dailyPnL: -10 });
    expect(db.state('risk')).toEqual({ dailyPnL: -10 });
    expect(db.healthy()).toBe(true);
    db.close();
    expect(db.healthy()).toBe(false);
  });
});
