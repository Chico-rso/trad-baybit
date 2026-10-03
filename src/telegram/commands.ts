export const commands = [
  'status',
  'positions',
  'stats',
  'profit',
  'pause',
  'resume',
  'mode',
  'health',
] as const;
export type Command = (typeof commands)[number];
export const commandDescriptions: Record<Command, string> = {
  status: 'Текущее состояние бота',
  positions: 'Открытые позиции',
  stats: 'Статистика торговли',
  profit: 'Прибыль и убыток',
  pause: 'Приостановить новые входы',
  resume: 'Возобновить новые входы',
  mode: 'Текущий режим торговли',
  health: 'Состояние подключений',
};
export function parseCommand(text: string): Command | undefined {
  const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?$/.exec(text.trim());
  return match && commands.includes(match[1] as Command) ? (match[1] as Command) : undefined;
}
