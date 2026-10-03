import { describe, expect, it } from 'vitest';
import { BybitWebSocket } from '../../src/exchange/bybit/BybitWebSocket.js';
import { createLogger } from '../../src/utils/logger.js';
import { EventEmitter } from 'node:events';
class Socket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(v: string) {
    this.sent.push(v);
  }
  close() {
    this.emit('close');
  }
  terminate() {
    this.emit('close');
  }
}
describe('websocket protocol', () => {
  it('waits for subscribe acknowledgement and authenticates before subscribing private topics', () => {
    const socket = new Socket();
    const ws = new BybitWebSocket(
      'wss://example.invalid',
      ['order.linear'],
      createLogger('silent'),
      { key: 'test-key', secret: 'test-secret' },
      () => socket,
    );
    ws.start();
    socket.emit('open');
    expect(JSON.parse(socket.sent[0]!).op).toBe('auth');
    expect(ws.connected).toBe(false);
    socket.emit('message', Buffer.from(JSON.stringify({ op: 'auth', success: true })));
    expect(JSON.parse(socket.sent[1]!).op).toBe('subscribe');
    socket.emit('message', Buffer.from(JSON.stringify({ op: 'subscribe', success: true })));
    expect(ws.connected).toBe(true);
    ws.stop();
    expect(ws.connected).toBe(false);
  });
});
