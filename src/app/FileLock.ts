import { openSync, writeFileSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class FileLock {
  private readonly owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  private released = false;
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch {
      throw new Error(
        `Journal lock exists: ${path}. Verify the old process is stopped before removing its lock.`,
      );
    }
    try {
      writeFileSync(fd, this.owner);
    } finally {
      closeSync(fd);
    }
  }
  release(): void {
    if (this.released) return;
    if (readFileSync(this.path, 'utf8') === this.owner) unlinkSync(this.path);
    this.released = true;
  }
}
