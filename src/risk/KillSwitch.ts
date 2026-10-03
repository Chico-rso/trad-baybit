import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Journal } from '../database/db.js';
import type { Logger } from '../utils/logger.js';
export class KillSwitch extends EventEmitter {
  readonly reasons: string[];
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
  activate(reason: string): void {
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
