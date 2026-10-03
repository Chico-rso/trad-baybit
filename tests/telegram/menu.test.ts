import { describe, expect, it, vi } from 'vitest';
import { TelegramBot, type TelegramUpdate } from '../../src/telegram/TelegramBot.js';
import { createLogger } from '../../src/utils/logger.js';

interface Request {
  method: string;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

function transport(
  options: {
    fail?: string;
    block?: string;
    historical?: TelegramUpdate[];
    fresh?: TelegramUpdate[];
  } = {},
) {
  const requests: Request[] = [];
  let updates = 0;
  const fetcher = vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ method, body, signal: init?.signal });
    if (method === options.fail) throw new Error(`Failed ${String(url)}`);
    if (method === 'getUpdates') {
      updates++;
      if (updates === 1)
        return new Response(JSON.stringify({ ok: true, result: options.historical ?? [] }));
      if (updates === 2 && options.fresh)
        return new Response(JSON.stringify({ ok: true, result: options.fresh }));
    } else if (method !== options.block) {
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new Error('stopped'));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  });
  return { requests, fetcher };
}

async function waitForPolling(requests: Request[]): Promise<void> {
  await vi.waitFor(() => {
    expect(requests.filter((request) => request.method === 'getUpdates').length).toBeGreaterThan(1);
  });
}

describe('Telegram native command menu', () => {
  it('registers all supported commands with Russian descriptions only for the configured chat', async () => {
    const { requests, fetcher } = transport();
    const bot = new TelegramBot(
      'menu-token',
      '42',
      createLogger('silent'),
      async () => '',
      fetcher,
    );
    bot.start();
    try {
      await waitForPolling(requests);
      expect(requests.filter((request) => request.method === 'setMyCommands')).toEqual([
        expect.objectContaining({
          body: {
            scope: { type: 'chat', chat_id: '42' },
            commands: [
              { command: 'status', description: 'Текущее состояние бота' },
              { command: 'positions', description: 'Открытые позиции' },
              { command: 'stats', description: 'Статистика торговли' },
              { command: 'profit', description: 'Прибыль и убыток' },
              { command: 'pause', description: 'Приостановить новые входы' },
              { command: 'resume', description: 'Возобновить новые входы' },
              { command: 'mode', description: 'Текущий режим торговли' },
              { command: 'health', description: 'Состояние подключений' },
            ],
          },
        }),
      ]);
      expect(requests.map((request) => request.method)).not.toContain('sendMessage');
    } finally {
      await bot.stop();
    }
  });

  it('sets the commands menu button using a numeric private chat identifier', async () => {
    const { requests, fetcher } = transport();
    const bot = new TelegramBot(
      'menu-token',
      '42',
      createLogger('silent'),
      async () => '',
      fetcher,
    );
    bot.start();
    try {
      await waitForPolling(requests);
      expect(requests.filter((request) => request.method === 'setChatMenuButton')).toEqual([
        expect.objectContaining({ body: { chat_id: 42, menu_button: { type: 'commands' } } }),
      ]);
    } finally {
      await bot.stop();
    }
  });

  it('registers scoped commands for a group without changing its menu button or the default', async () => {
    const { requests, fetcher } = transport();
    const bot = new TelegramBot(
      'menu-token',
      '-42',
      createLogger('silent'),
      async () => '',
      fetcher,
    );
    bot.start();
    try {
      await waitForPolling(requests);
      expect(requests.some((request) => request.method === 'setMyCommands')).toBe(true);
      expect(requests.some((request) => request.method === 'setChatMenuButton')).toBe(false);
    } finally {
      await bot.stop();
    }
  });

  it.each([
    ['', '42'],
    ['menu-token', ''],
  ])('makes no requests when Telegram is disabled (%s, %s)', async (token, chatId) => {
    const { fetcher } = transport();
    const bot = new TelegramBot(token, chatId, createLogger('silent'), async () => '', fetcher);
    bot.start();
    await bot.stop();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['setMyCommands', 'setChatMenuButton'])(
    'keeps polling and sanitizes the warning when %s fails',
    async (fail) => {
      const { requests, fetcher } = transport({ fail });
      const logger = createLogger('silent');
      const warning = vi.spyOn(logger, 'warn');
      const bot = new TelegramBot('menu-token', '42', logger, async () => '', fetcher);
      bot.start();
      try {
        await waitForPolling(requests);
        expect(warning).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'telegram.commands.registration.failed' }),
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain('menu-token');
      } finally {
        await bot.stop();
      }
    },
  );

  it('discards historical resume before registration and handles only fresh authorized commands', async () => {
    const command = vi.fn(async () => 'resumed');
    const { requests, fetcher } = transport({
      historical: [{ update_id: 10, message: { chat: { id: 42 }, text: '/resume' } }],
      fresh: [
        { update_id: 11, message: { chat: { id: 13 }, text: '/resume' } },
        { update_id: 12, message: { chat: { id: 42 }, text: '/status' } },
      ],
    });
    const bot = new TelegramBot('menu-token', '42', createLogger('silent'), command, fetcher);
    bot.start();
    try {
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      expect(command).toHaveBeenCalledWith('status');
      expect(requests[0]).toMatchObject({
        method: 'getUpdates',
        body: { offset: -1, timeout: 0, allowed_updates: ['message'] },
      });
      expect(requests[1]?.method).toBe('setMyCommands');
      expect(requests.find((request) => request.body.timeout === 25)?.body.offset).toBe(11);
      expect(requests.filter((request) => request.method === 'sendMessage')).toHaveLength(1);
    } finally {
      await bot.stop();
    }
  });

  it.each(['setMyCommands', 'setChatMenuButton'])(
    'aborts pending %s during stop without continuing startup',
    async (block) => {
      const { requests, fetcher } = transport({ block });
      const bot = new TelegramBot(
        'menu-token',
        '42',
        createLogger('silent'),
        async () => '',
        fetcher,
      );
      bot.start();
      try {
        await vi.waitFor(() =>
          expect(requests.some((request) => request.method === block)).toBe(true),
        );
      } finally {
        await bot.stop();
      }
      expect(requests.find((request) => request.method === block)?.signal?.aborted).toBe(true);
      expect(requests.at(-1)?.method).toBe(block);
    },
  );
});
