import pino from 'pino';
import { randomUUID } from 'node:crypto';

const secrets = new Set<string>();
export function registerSecrets(values: string[]): void {
  for (const s of values) if (s) secrets.add(s);
}
export function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    let safe = value.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
    for (const s of secrets) safe = safe.split(s).join('[REDACTED]');
    return safe;
  }
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message) };
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /secret|token|signature|api.?key|authorization|headers|config/i.test(k)
          ? '[REDACTED]'
          : sanitize(v),
      ]),
    );
  return value;
}
export function createLogger(level = 'info') {
  return pino({
    level,
    mixin: () => ({ correlationId: randomUUID() }),
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(sanitize) as Parameters<typeof method>);
      },
    },
  });
}
export type Logger = ReturnType<typeof createLogger>;
