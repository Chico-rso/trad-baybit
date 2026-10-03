import { config as loadDotenv } from 'dotenv';
import { TelegramBot } from '../src/telegram/TelegramBot.js';
import { createLogger, registerSecrets } from '../src/utils/logger.js';
loadDotenv({ quiet: true });
const token = process.env.TELEGRAM_BOT_TOKEN ?? '',
  chat = process.env.TELEGRAM_CHAT_ID ?? '';
registerSecrets([token]);
const logger = createLogger('info');
try {
  if (!token || !chat) throw new Error('Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
  const bot = new TelegramBot(token, chat, logger, async () => 'diagnostic');
  const me = await bot.request<{ id: number; username: string }>('getMe', {});
  const destination = await bot.request<{ id: number; type: string }>('getChat', { chat_id: chat });
  logger.info({
    event: 'telegram.check.passed',
    botUsername: me.username,
    chatType: destination.type,
  });
  // A message is sent only when the operator explicitly uses --send.
  if (process.argv.includes('--send')) {
    await bot.request('sendMessage', {
      chat_id: chat,
      text: 'Связь с Telegram работает. Это проверочное сообщение; проверка не выставляет ордера.',
    });
    logger.info({ event: 'telegram.test_message.sent' });
  }
  await bot.stop();
} catch (err) {
  logger.error({ event: 'telegram.check.failed', error: err });
  process.exitCode = 1;
}
