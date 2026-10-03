import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { endpoints, type Config, assertExecutionMode } from '../../config/env.js';
import type { Logger } from '../../utils/logger.js';
import { BybitWebSocket, type WsMessage } from './BybitWebSocket.js';
const orderSchema = z.array(
  z.object({
    category: z.string(),
    orderId: z.string(),
    orderLinkId: z.string(),
    symbol: z.string(),
    side: z.enum(['Buy', 'Sell']),
    qty: z.string(),
    orderStatus: z.string(),
    cumExecQty: z.string(),
    avgPrice: z.string(),
    createdTime: z.string(),
    updatedTime: z.string(),
    reduceOnly: z.boolean(),
    stopOrderType: z.string().optional(),
    price: z.string(),
    orderType: z.enum(['Market', 'Limit']),
  }),
);
const fillSchema = z.array(
  z.object({
    category: z.string(),
    execId: z.string(),
    orderId: z.string(),
    orderLinkId: z.string(),
    symbol: z.string(),
    side: z.enum(['Buy', 'Sell']),
    execQty: z.string(),
    execPrice: z.string(),
    execFee: z.string(),
    execTime: z.string(),
    execType: z.string(),
    closedSize: z.string(),
    stopOrderType: z.string().optional(),
  }),
);
export class BybitPrivateData extends EventEmitter {
  readonly ws: BybitWebSocket;
  constructor(c: Config, logger: Logger) {
    super();
    assertExecutionMode(c);
    this.ws = new BybitWebSocket(
      endpoints(c).privateWs,
      ['order.linear', 'execution.linear', 'position.linear', 'wallet'],
      logger,
      { key: c.BYBIT_API_KEY, secret: c.BYBIT_API_SECRET },
    );
    for (const event of ['connected', 'disconnected', 'fault'])
      this.ws.on(event, (...args: unknown[]) => this.emit(event, ...args));
    this.ws.on('data', (msg: WsMessage) => {
      try {
        if (msg.topic === 'order.linear')
          this.emit(
            'orders',
            orderSchema.parse(msg.data).filter((o) => o.category === 'linear'),
          );
        else if (msg.topic === 'execution.linear')
          this.emit(
            'executions',
            fillSchema.parse(msg.data).filter((o) => o.category === 'linear'),
          );
        else if (msg.topic === 'position.linear' || msg.topic === 'wallet')
          this.emit('accountUpdate');
      } catch {
        this.emit('fault', new Error('Malformed private stream payload'));
        this.ws.forceReconnect();
      }
    });
  }
  start(): void {
    this.ws.start();
  }
  stop(): void {
    this.ws.stop();
  }
}
