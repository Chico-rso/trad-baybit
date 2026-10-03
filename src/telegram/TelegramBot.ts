import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../utils/logger.js';
import { registerSecrets, sanitize } from '../utils/logger.js';
import { commandDescriptions, commands, parseCommand, type Command } from './commands.js';
export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}
interface TelegramEnvelope<T> {
  ok: boolean;
  result: T;
}
export class TelegramBot {
  private offset = 0;
  private stopped = true;
  private abort = new AbortController();
  private readonly outbound: string[] = [];
  private sending = false;
  private polling?: Promise<void>;
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly logger: Logger,
    private readonly command: (command: Command) => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    registerSecrets([token]);
  }
  get enabled(): boolean {
    return !!this.token && !!this.chatId;
  }
  async request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!this.enabled) throw new Error('Telegram is disabled');
    const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(35000)]),
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    const value = (await response.json()) as TelegramEnvelope<T>;
    if (!value.ok) throw new Error('Telegram API rejected request');
    return value.result;
  }
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || String(msg.chat.id) !== this.chatId || !msg.text) return;
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    // Command handlers apply pause synchronously before any remote notification.
    const reply = await this.command(cmd);
    await this.request('sendMessage', { chat_id: this.chatId, text: reply.slice(0, 4000) });
  }
  notify(text: string): void {
    if (!this.enabled || this.stopped) return;
    if (this.outbound.length >= 100) {
      this.logger.warn({ event: 'telegram.queue.full' });
      return;
    }
    this.outbound.push(text);
    void this.sendQueued();
  }
  private async sendQueued(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbound.length && !this.stopped) {
        const text = this.outbound.shift()!;
        for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
          try {
            await this.request('sendMessage', { chat_id: this.chatId, text: text.slice(0, 4000) });
            break;
          } catch (err) {
            if (this.stopped) break;
            this.logger.warn({
              event: attempt === 2 ? 'telegram.send.failed' : 'telegram.send.retry',
              attempt: attempt + 1,
              error: err,
            });
            if (attempt < 2)
              await delay(1000 * 2 ** attempt, undefined, { signal: this.abort.signal }).catch(
                () => undefined,
              );
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }
  start(): void {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.polling = this.poll();
  }
  private async poll(): Promise<void> {
    try {
      // Discard historical commands from an earlier process; do not replay /resume.
      const old = await this.request<TelegramUpdate[]>('getUpdates', {
        offset: -1,
        timeout: 0,
        allowed_updates: ['message'],
      });
      if (old.length) this.offset = old.at(-1)!.update_id + 1;
    } catch (err) {
      if (!this.stopped) this.logger.warn({ event: 'telegram.initialization.failed', error: err });
    }
    if (this.stopped) return;
    try {
      await this.request('setMyCommands', {
        scope: { type: 'chat', chat_id: this.chatId },
        commands: commands.map((command) => ({
          command,
          description: commandDescriptions[command],
        })),
      });
      const privateChatId = Number(this.chatId);
      if (!this.stopped && Number.isSafeInteger(privateChatId) && privateChatId > 0) {
        await this.request('setChatMenuButton', {
          chat_id: privateChatId,
          menu_button: { type: 'commands' },
        });
      }
    } catch (err) {
      if (!this.stopped)
        this.logger.warn({ event: 'telegram.commands.registration.failed', error: sanitize(err) });
    }
    while (!this.stopped) {
      try {
        const updates = await this.request<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message'],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (this.stopped) break;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn({ event: 'telegram.poll.failed', error: err });
        await delay(2500, undefined, { signal: this.abort.signal }).catch(() => undefined);
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.polling;
  }
}
