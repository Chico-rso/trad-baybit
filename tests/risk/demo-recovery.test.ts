import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { Journal } from '../../src/database/db.js';
import { KillSwitch } from '../../src/risk/KillSwitch.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Health } from '../../src/monitoring/health.js';

const healthy: Health = { status: 'HEALTHY', reasons: [], timestamp: 0 };
const setup = () => {
  const c = parseEnv({
    TRADING_MODE: 'demo',
    DEMO_CONTINUOUS_TESTING: 'true',
    BYBIT_API_KEY: 'demo-key',
    BYBIT_API_SECRET: 'demo-secret',
  });
  const db = new Journal(':memory:');
  const kill = new KillSwitch(db, createLogger('silent'), 'demo');
  kill.activate('local position missing on exchange');
  kill.activate('market data stale');
  const tick = (now: number, current = healthy, synchronized = true, timestamp = now) => {
    db.setState('reconcile:demo', { synchronized, timestamp });
    kill.recoverDemo(c, current, now);
  };
  return { c, db, kill, tick };
};

describe('recovery from confirmed transient demo faults', () => {
  it.each(['repeated mismatch', 'disconnect'] as const)(
    'restarts waiting on a %s even between health monitor samples',
    (fault) => {
      const s = setup();
      try {
        s.tick(1000);
        if (fault === 'repeated mismatch') s.kill.activate('local position missing on exchange');
        else s.kill.interruptRecovery();
        s.tick(31000);
        expect(s.kill.active).toBe(true);
        s.tick(61000);
        expect(s.kill.active).toBe(false);
      } finally {
        s.db.close();
      }
    },
  );
  it('keeps both the durable latch and memory blocked if the audit transaction fails', () => {
    const s = setup();
    try {
      s.tick(1000);
      const save = vi.spyOn(s.db, 'save').mockImplementation(() => {
        throw new Error('audit write failed');
      });
      expect(() => s.tick(31000)).toThrow('audit write failed');
      expect(s.kill.active).toBe(true);
      expect(s.db.state('kill:demo')).toEqual(s.kill.reasons);
      save.mockRestore();
      s.tick(32000);
      expect(s.kill.active).toBe(false);
    } finally {
      s.db.close();
    }
  });
  it('resumes only after stable health and repeated account confirmations, with durable audit', () => {
    const s = setup();
    try {
      s.tick(1000);
      s.tick(16000);
      s.tick(30999);
      expect(s.kill.active).toBe(true);
      s.tick(31000);
      expect(s.kill.reasons).toEqual([]);
      expect(s.db.state('kill:demo')).toEqual([]);
      expect(new KillSwitch(s.db, createLogger('silent'), 'demo').active).toBe(false);
      expect(s.db.list('events')).toContainEqual(
        expect.objectContaining({
          event: 'kill_switch.demo_recovered',
          previousReasons: ['local position missing on exchange', 'market data stale'],
        }),
      );
    } finally {
      s.db.close();
    }
  });

  it.each(['DEGRADED', 'UNHEALTHY'] as const)(
    'restarts the healthy interval after %s',
    (status) => {
      const s = setup();
      try {
        s.tick(1000);
        s.tick(30000, { ...healthy, status });
        s.tick(31000);
        s.tick(60000);
        expect(s.kill.active).toBe(true);
        s.tick(61000);
        expect(s.kill.active).toBe(false);
      } finally {
        s.db.close();
      }
    },
  );

  it.each([false, true])(
    'blocks unresolved or stale account snapshots: synchronized=%s',
    (sync) => {
      const s = setup();
      try {
        s.tick(1000);
        s.tick(31000, healthy, sync, sync ? 0 : 31000);
        expect(s.kill.active).toBe(true);
      } finally {
        s.db.close();
      }
    },
  );

  it('requires multiple different successful reconciliations', () => {
    const s = setup();
    try {
      s.tick(1000);
      s.tick(31000, healthy, true, 1000);
      expect(s.kill.active).toBe(true);
      s.tick(32000);
      expect(s.kill.active).toBe(false);
    } finally {
      s.db.close();
    }
  });

  it.each([
    'unknown open exchange position',
    'ambiguous order submission',
    'daily loss limit',
    'database unavailable',
  ])('preserves a manual latch: %s', (reason) => {
    const s = setup();
    try {
      s.kill.activate(reason);
      s.tick(1000);
      s.tick(31000);
      expect(s.kill.reasons).toContain(reason);
      expect(s.kill.reasons).toHaveLength(3);
    } finally {
      s.db.close();
    }
  });

  it.each(['live', 'testnet', 'paper'] as const)('never recovers %s automatically', (mode) => {
    const s = setup();
    try {
      s.db.setState('reconcile:demo', { timestamp: 1000, synchronized: true });
      s.kill.recoverDemo({ ...s.c, TRADING_MODE: mode }, healthy, 1000);
      s.db.setState('reconcile:demo', { timestamp: 31000, synchronized: true });
      s.kill.recoverDemo({ ...s.c, TRADING_MODE: mode }, healthy, 31000);
      expect(s.kill.active).toBe(true);
    } finally {
      s.db.close();
    }
  });

  it('keeps the latch when continuous testing is disabled', () => {
    const s = setup();
    try {
      s.db.setState('reconcile:demo', { timestamp: 31000, synchronized: true });
      s.kill.recoverDemo({ ...s.c, DEMO_CONTINUOUS_TESTING: false }, healthy, 1000);
      s.kill.recoverDemo({ ...s.c, DEMO_CONTINUOUS_TESTING: false }, healthy, 31000);
      expect(s.kill.active).toBe(true);
    } finally {
      s.db.close();
    }
  });
});
