import { describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/telegram/TelegramBot.js';
import { createLogger, registerSecrets, sanitize } from '../../src/utils/logger.js';
import { formatSignal, formatStop, reasonText } from '../../src/telegram/messages.js';
import { signal } from '../helpers.js';
describe('Telegram command authorization and secrets', () => {
  it('explains an unconfirmed missing exchange position in Russian', () => {
    const explanation = 'Локальная позиция не найдена на бирже; закрытие не подтверждено';
    expect(reasonText('local position missing on exchange')).toBe(explanation);
    expect(formatStop(['local position missing on exchange'], 'demo')).toContain(explanation);
  });
  it('retries a transient notification failure and stops the long poll cleanly', async () => {
    let updates = 0,
      sends = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/sendMessage')) {
        sends++;
        if (sends === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      if (++updates === 1) return new Response(JSON.stringify({ ok: true, result: [] }));
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
      );
    });
    const bot = new TelegramBot(
      'fake-token',
      '42',
      createLogger('silent'),
      async () => '',
      fetcher,
    );
    bot.start();
    bot.notify('Ордер исполнен');
    try {
      await vi.waitFor(() => expect(sends).toBe(2), { timeout: 2500 });
    } finally {
      await bot.stop();
    }
  });
  it('rejects unauthorized chats and applies pause before awaiting send', async () => {
    const command = vi.fn(async () => 'paused');
    const send = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    const bot = new TelegramBot('fake-token', '42', createLogger('silent'), command, send);
    await bot.handleUpdate({ update_id: 1, message: { chat: { id: 13 }, text: '/pause' } });
    expect(command).not.toHaveBeenCalled();
    await bot.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/pause' } });
    expect(command).toHaveBeenCalledWith('pause');
    await bot.handleUpdate({ update_id: 3, message: { chat: { id: 42 }, text: '/mode live' } });
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('redacts registered secrets in nested values and URLs', () => {
    registerSecrets(['fake-secret', 'fake-token']);
    expect(
      JSON.stringify(
        sanitize({
          error: new Error('https://api.telegram.org/botfake-token/sendMessage'),
          nested: { value: 'fake-secret' },
          apiKey: 'key',
        }),
      ),
    ).not.toContain('fake-token');
    expect(JSON.stringify(sanitize({ apiKey: 'key' }))).not.toContain('key');
  });
  it('formats score as heuristic points and includes costs and planned protection', () => {
    const text = formatSignal(signal, 'signal', 0.25);
    expect(text).toContain('80/100');
    expect(text).toContain('Ограничение убытка:');
    expect(text).toContain('Это сигнал');
    expect(text).not.toContain('Score:');
    expect(text).not.toContain('trend confirmed');
    expect(text).not.toContain('probability');
  });
});
