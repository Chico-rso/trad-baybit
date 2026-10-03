import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { assertExecutionMode, endpoints, type Config } from '../../config/env.js';
import type { Logger } from '../../utils/logger.js';
import { retryRead } from '../../utils/retry.js';

const envelope = z.object({
  retCode: z.number(),
  result: z.unknown(),
  time: z.number().optional(),
});
export class BybitApiError extends Error {
  constructor(readonly code: number) {
    super(`Bybit API error code ${code}`);
  }
}
export class BybitRestClient extends EventEmitter {
  lastSuccess = 0;
  consecutiveErrors = 0;
  private offset = 0;
  constructor(
    readonly config: Config,
    private readonly logger: Logger,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    super();
  }
  async get<T>(
    path: string,
    params: Record<string, string> = {},
    authenticated = false,
  ): Promise<T> {
    return retryRead(() => this.request<T>('GET', path, params, authenticated));
  }
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    assertExecutionMode(this.config);
    return this.request<T>('POST', path, body, true); // mutation is deliberately sent once
  }
  async synchronizeClock(): Promise<void> {
    const before = Date.now();
    const result = await this.get<{ timeNano: string }>('/v5/market/time');
    const time = Number(result.timeNano) / 1e6;
    if (!Number.isFinite(time)) throw new Error('Invalid server time');
    this.offset = Math.round(time - (before + Date.now()) / 2);
  }
  localTimestamp(serverTimestamp: number): number {
    if (!Number.isFinite(serverTimestamp) || serverTimestamp <= 0)
      throw new Error('Invalid server timestamp');
    return serverTimestamp - this.offset;
  }
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    data: Record<string, unknown>,
    authenticated: boolean,
  ): Promise<T> {
    if (!path.startsWith('/v5/')) throw new Error('Only Bybit V5 endpoints are supported');
    if (authenticated && (!this.config.BYBIT_API_KEY || !this.config.BYBIT_API_SECRET))
      throw new Error('Missing Bybit credentials');
    const correlationId = randomUUID();
    const query = new URLSearchParams(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ).toString();
    const body = method === 'POST' ? JSON.stringify(data) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'cdn-request-id': correlationId,
    };
    if (authenticated) {
      const timestamp = String(Date.now() + this.offset);
      headers['X-BAPI-API-KEY'] = this.config.BYBIT_API_KEY;
      headers['X-BAPI-TIMESTAMP'] = timestamp;
      headers['X-BAPI-RECV-WINDOW'] = '5000';
      headers['X-BAPI-SIGN'] = createHmac('sha256', this.config.BYBIT_API_SECRET)
        .update(timestamp + this.config.BYBIT_API_KEY + '5000' + (body ?? query))
        .digest('hex');
    }
    const base = authenticated ? endpoints(this.config).rest : endpoints(this.config).publicRest;
    try {
      const response = await this.fetcher(
        `${base}${path}${method === 'GET' && query ? '?' + query : ''}`,
        { method, headers, body, signal: AbortSignal.timeout(this.config.REST_TIMEOUT_MS) },
      );
      if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
      const parsed = envelope.parse(await response.json());
      // Bybit 110043 on this endpoint means the requested leverage is already set.
      // Classify before emitting failure, so repeated startup configuration cannot
      // trigger the exchange-error kill switch. All other codes remain failures.
      const unchangedLeverage =
        method === 'POST' && path === '/v5/position/set-leverage' && parsed.retCode === 110043;
      if (parsed.retCode !== 0 && !unchangedLeverage) throw new BybitApiError(parsed.retCode);
      this.lastSuccess = Date.now();
      this.consecutiveErrors = 0;
      this.emit('success');
      this.logger.debug({ event: 'exchange.rest.success', path, correlationId });
      return parsed.result as T;
    } catch (err) {
      this.consecutiveErrors++;
      this.emit('failure', err);
      this.logger.warn({ event: 'exchange.rest.failure', path, correlationId, error: err });
      throw err;
    }
  }
}
