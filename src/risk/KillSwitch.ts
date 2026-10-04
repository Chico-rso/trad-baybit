import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Journal } from '../database/db.js';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config/env.js';
import type { Health } from '../monitoring/health.js';
export class KillSwitch extends EventEmitter {
  readonly reasons: string[];
  private recoverySince: number | undefined;
  private recoveryReconcileAt = 0;
  private recoveryConfirmations = 0;
  constructor(
    private readonly db: Journal,
    private readonly logger: Logger,
    private readonly mode: string,
  ) {
    super();
    this.reasons = db.state<string[]>(`kill:${mode}`) ?? [];
  }
  get active(): boolean {
    return this.reasons.length > 0;
  }
  interruptRecovery(): void {
    this.recoverySince = undefined;
    this.recoveryReconcileAt = 0;
    this.recoveryConfirmations = 0;
  }
  recoverDemo(c: Config, current: Health, now = Date.now()): void {
    const reconciliation = this.db.state<{ timestamp: number; synchronized: boolean }>(
      `reconcile:${this.mode}`,
    );
    // Only the two observed transient faults are eligible. Other latches require an audit.
    if (
      this.mode !== 'demo' ||
      c.TRADING_MODE !== 'demo' ||
      !c.DEMO_CONTINUOUS_TESTING ||
      !this.active ||
      this.reasons.some(
        (reason) => !['local position missing on exchange', 'market data stale'].includes(reason),
      ) ||
      current.status !== 'HEALTHY' ||
      !reconciliation?.synchronized ||
      !Number.isFinite(reconciliation.timestamp) ||
      reconciliation.timestamp > now ||
      now - reconciliation.timestamp > c.RECONCILE_INTERVAL_MS * 2
    ) {
      this.interruptRecovery();
      return;
    }
    this.recoverySince ??= now;
    if (reconciliation.timestamp > this.recoveryReconcileAt) {
      this.recoveryReconcileAt = reconciliation.timestamp;
      this.recoveryConfirmations++;
    }
    if (now - this.recoverySince < 30000 || this.recoveryConfirmations < 2) return;
    const event = {
      event: 'kill_switch.demo_recovered',
      mode: this.mode,
      previousReasons: [...this.reasons],
      healthySince: this.recoverySince,
      reconciliationTimestamp: reconciliation.timestamp,
      confirmations: this.recoveryConfirmations,
    };
    // Persist the reset and its evidence before allowing any new entry.
    this.db.transaction(() => {
      this.db.setState(`kill:${this.mode}`, []);
      this.db.save('events', randomUUID(), event);
    });
    this.reasons.splice(0);
    this.interruptRecovery();
    this.logger.info(event);
  }
  activate(reason: string): void {
    this.interruptRecovery();
    if (this.reasons.includes(reason)) return;
    this.reasons.push(reason);
    this.logger.error({ event: 'kill_switch.activated', reason });
    try {
      this.db.transaction(() => {
        this.db.setState(`kill:${this.mode}`, this.reasons);
        this.db.save('events', randomUUID(), {
          event: 'kill_switch.activated',
          reason,
          mode: this.mode,
        });
      });
    } catch {
      this.logger.error({ event: 'database.unavailable', reason: 'Cannot persist kill switch' });
    }
    this.emit('activated', reason);
  }
}
