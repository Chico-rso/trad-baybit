import { EventEmitter } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Logger } from '../../utils/logger.js';

export interface SocketLike extends EventEmitter {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
}
export interface WsMessage {
  op?: string;
  success?: boolean;
  topic?: string;
  type?: string;
  ts?: number;
  data?: unknown;
}
export class BybitWebSocket extends EventEmitter {
  connected = false;
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' = 'disconnected';
  private socket?: SocketLike;
  private stopped = true;
  private attempts = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private lastPong = 0;
  constructor(
    private readonly url: string,
    private readonly topics: string[],
    private readonly logger: Logger,
    private readonly credentials?: { key: string; secret: string },
    private readonly socketFactory: (url: string) => SocketLike = (url) =>
      new WebSocket(url, { handshakeTimeout: 10000 }),
  ) {
    super();
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  private send(value: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value));
  }
  private subscribe(): void {
    this.send({ op: 'subscribe', args: this.topics, req_id: randomUUID() });
  }
  private connect(): void {
    if (this.stopped) return;
    this.state = this.attempts ? 'reconnecting' : 'connecting';
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    this.handshake = setTimeout(() => socket.terminate(), 15000);
    socket.on('open', () => {
      this.lastPong = Date.now();
      if (this.credentials) {
        const expires = Date.now() + 10000;
        const signature = createHmac('sha256', this.credentials.secret)
          .update(`GET/realtime${expires}`)
          .digest('hex');
        this.send({ op: 'auth', args: [this.credentials.key, expires, signature] });
      } else this.subscribe();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 45000) socket.terminate();
        else this.send({ op: 'ping', req_id: randomUUID() });
      }, 20000);
    });
    socket.on('message', (raw: { toString(): string }) => {
      if (this.stopped) return;
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage;
        if (msg.op === 'pong' || msg.op === 'ping') this.lastPong = Date.now();
        else if (msg.op === 'auth') {
          if (msg.success === true) this.subscribe();
          else {
            this.emit('fault', new Error('Private WS authentication rejected'));
            socket.terminate();
          }
        } else if (msg.op === 'subscribe') {
          if (msg.success !== true) {
            this.emit('fault', new Error('WS subscription rejected'));
            socket.terminate();
            return;
          }
          clearTimeout(this.handshake);
          this.connected = true;
          this.state = 'connected';
          this.attempts = 0;
          this.logger.info({ event: this.credentials ? 'private.connected' : 'market.connected' });
          this.emit('connected');
        } else if (msg.topic) this.emit('data', msg);
      } catch {
        this.emit('fault', new Error('Malformed WS message'));
        socket.terminate();
      }
    });
    socket.on('error', () => {
      this.logger.warn({ event: 'websocket.error' });
      this.emit('fault', new Error('WebSocket transport error'));
      socket.terminate();
    });
    socket.once('close', () => {
      clearInterval(this.heartbeat);
      clearTimeout(this.handshake);
      this.connected = false;
      this.state = 'disconnected';
      this.emit('disconnected');
      this.logger.warn({
        event: this.credentials ? 'private.disconnected' : 'market.disconnected',
      });
      if (!this.stopped) {
        this.state = 'reconnecting';
        this.reconnect = setTimeout(
          () => this.connect(),
          Math.min(1000 * 2 ** this.attempts++, 30000) + Math.random() * 500,
        );
      }
    });
  }
  forceReconnect(): void {
    this.socket?.terminate();
  }
  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.state = 'disconnected';
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    clearTimeout(this.handshake);
    this.socket?.close();
  }
}
